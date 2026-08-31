# 実験計画: Gemini implicit caching によるスクリーニングコスト削減の検証

## コンテキスト

現行実装は Gemini のプロンプトキャッシュに明示対応していない（explicit caching (`cachedContents`) 未使用）。
ただし `screenReference()` のプロンプトは「共通の screeningPrompt → 文献ごとのタイトル/抄録 → 出力指示」の順で、
**共通部分が先頭**にあるため、Gemini 2.5 以降でデフォルト有効の implicit caching が偶然効きうる構造にはなっている。

一方で:

- implicit caching には最小プレフィックス長の閾値がある（Flash 系で約 1,024 トークンと公表されてきた。
  3.x 系の閾値は要確認）。現行の depression 用プロンプトは約 400 chars（≈100 トークン）で、**閾値未満のため
  ヒットしない見込み**。
- これまで usageMetadata から `cachedContentTokenCount` を取得しておらず、**効いているかどうか自体が未計測**だった。
  本ブランチで `src/lib/gemini-api.ts` に計測を追加した（`UsageMetadata.cachedInputTokens` として decisions の
  note に保存される）。

## RQ

- **RQ1**: 現行プロンプト（P0）で implicit caching はヒットしているか（予想: ヒット率 ≈ 0%）
- **RQ2**: 共有プレフィックスを閾値超え（約 9.6K chars ≈ 2,200〜2,400 トークン）まで延ばしたプロンプト（P1）で
  ヒット率・実効コストはどう変わるか
- **RQ3**: コスト削減率はモデル（flash / flash-lite）でどう違うか
  - 仮説: flash（thinking LOW）は思考トークンで出力コストが支配的なため、入力キャッシュの寄与は相対的に小さい。
    flash-lite（temp 0、思考なし）は入力の比重が大きく、削減率が高く出るはず
- **RQ4**（副次）: 並列度はヒット率に影響するか（tier_max=60並列 vs tier_serial=逐次）。
  同時多発の初回リクエストは全て cache miss になりうるため、warmup 1 件を既定で先行送信する

## 条件

データセット: depression（約 2,000 件、陽性 280）固定。

| 条件ID | モデル | パラメータ | プロンプト |
|---|---|---|---|
| lite-P0 | gemini-3.1-flash-lite | Temp 0（現行デフォルトと同一） | P0: 現行相当（~400 chars） |
| lite-P1 | gemini-3.1-flash-lite | Temp 0 | P1: 長プレフィックス（~9.6K chars） |
| flash-P0 | gemini-3-flash-preview | Temp 1.0 / TopP 0.95 / Think LOW（B4と同一） | P0 |
| flash-P1 | gemini-3-flash-preview | 同上 | P1 |

- P0 / P1 はどちらも `{{CRITERIA}}` に同じ depression 基準を埋め込む。P1 は感度優先の判定方針は P0 と同一だが
  ガイダンスが増えるため、**判定挙動が変わりうる**。Recall は副次アウトカムとして必ず確認する。
- 主要アウトカム: **キャッシュヒット率**（cachedInputTokens > 0 のリクエスト割合）と
  **キャッシュトークン比率**（Σcached / Σprompt）。これらは単価設定に依存しない実測値。
- 副次アウトカム: 推定コスト（config.json の pricing に基づく）、削減率、Recall@0.5、ms/件。

## 実行前の準備（必須）

1. **料金の確認**: `config.json` の `pricing.models` は仮置き (confidence: low)。実行前に
   https://ai.google.dev/gemini-api/docs/pricing で `gemini-3.1-flash-lite` / `gemini-3-flash-preview` の
   入力・出力単価と、キャッシュヒット分の割引率（`cachedInputMultiplier`、公称 75% 割引 = 0.25 を仮置き）を
   確認して更新する。**単価が違ってもヒット率・キャッシュ比率の解釈は変わらない。**
2. `.env` にプロジェクトルートの `GEMINI_API_KEY`（有料 tier キー）があること。
3. 疎通確認（下記 smoke）で `cachedInputTokens` がログに現れること（0 でもフィールドが出ていればOK）。

## 実行コマンド

```bash
# 疎通確認 (depression 50件, lite-P1)
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --dataset depression --condition lite-P1 --tier tier_smoke --sample 50

# 本実験 (各条件 全件, warmup 1 は既定)
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --condition lite-P0 --tier tier_max
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --condition lite-P1 --tier tier_max
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --condition flash-P0 --tier tier_max
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --condition flash-P1 --tier tier_max

# RQ4: 並列度の影響 (lite-P1 のみ、コスト抑制のため 300件サンプル)
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/runner.ts --condition lite-P1 --tier tier_serial --sample 300

# 集計
npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
  experiments/gemini-prompt-cache/summarize.ts
```

## 判断基準

| 結果 | 解釈・次アクション |
|---|---|
| P0 でヒット率 ≈ 0% かつ P1 で大幅ヒット（比率 50%超） | プロンプト設計次第で削減可能。本体側で (a) 出力指示を screeningPrompt 側へ寄せてプレフィックスを最大化、(b) UI でプロンプトが短い場合の注意喚起、を検討 |
| P1 でもヒット率が低い（<20%） | implicit 任せは不成立。explicit caching (`cachedContents` + TTL) の設計検討へ進むか、見送り |
| 削減率が全条件で数%未満 | 実装コストに見合わないため見送り（flash-lite は元の単価が安く、この結果になる可能性が十分ある） |
| P1 で Recall が P0 比 -2pp 超劣化 | プロンプト増強の副作用。コスト削減とは独立に P1 の文面を見直してから再判定 |

## 注意事項

- implicit caching のヒットはサーバ側のルーティングに依存し保証されない。同一条件でも run 間でヒット率が
  変動しうるため、判断が際どい場合は同条件を2回走らせて幅を見る。
- `cachedContentTokenCount` は課金上の割引対象トークン数の根拠（Google の usage 報告値）。これが 0 のまま
  なら課金も割引されていない。
- フォールバック判定（リトライ全滅時の include_probability=1.0）には usageMetadata が無いため、集計では
  `decisionsWithoutUsage` として除外カウントされる。失敗が多い run はコスト集計の信頼性が下がる点に注意。
- 本実験の変更のうち src 側（`cachedInputTokens` の計測）は本番にそのまま入れて害がない。実験結果が
  ネガティブでも計測だけは残す価値がある。
