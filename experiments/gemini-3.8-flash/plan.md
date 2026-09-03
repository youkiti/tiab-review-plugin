# 実験計画: gemini-3.8-flash

**起案日**: 2026-09-03
**ステータス**: 計画（未実行）

## コンテキスト

`gemini-3.8-flash` が GA としてリリースされた（公式ドキュメント: [Gemini API Models](https://ai.google.dev/gemini-api/docs/models)）。公式の位置付けは「最も賢い Flash」だが、明示されている設計目標は **長期ホライズンのソフトウェアエンジニアリング・自律エージェント・複雑なエンタープライズワークフロー**であり、TiAb スクリーニングのような「1件あたり数百トークンの短い分類タスクを感度最優先で大量に回す」用途とは方向性が異なる。

直近3世代の実測は以下の通りで、**世代が新しくなるほど depression Recall が下がり Precision が上がる（判断が除外方向へ寄る）**という傾向が再現している。

| モデル | 最良条件 | depression Recall | Precision | $/1K件 | 判定 |
|---|---|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | Temp1.0/TopP0.95/Think LOW | **96.1%** | 53.4% | ~$1.70 | 現行精度枠（チャンピオン） |
| GA C1 (`gemini-3.1-flash-lite`) | Temp 0 | 93.6% | 61.6% | ~$0.30 | UI 既定モデル |
| `gemini-3.5-flash` | Think MINIMAL | 93.2% | 54.6% | $1.93 | 却下 |
| `gemini-3.6-flash` | Think LOW | 94.6% | 49.6% | $1.70 | フォールバック候補止まり |
| `gemini-3.7-flash` | Think MEDIUM | 91.1% | 65.6% | $3.27 | 却下 |
| **`gemini-3.8-flash`** | 今回 | TBD | TBD | TBD | — |

出典: [experiments/report.md](../report.md)、[experiments/gemini-3.6-flash/report.md](../gemini-3.6-flash/report.md)、[experiments/gemini-3.7-flash/report.md](../gemini-3.7-flash/report.md)、[experiments/gpt-5.6/report.md](../gpt-5.6/report.md)。

**事前予想（反証されうる仮説として明記しておく）**: 公式が「難しい多段タスクでは推論ステップを細かく刻み、ツールを反復呼び出しし、自分の作業を検証するため**トークン消費が増える設計**」と明言していることから、(a) Recall は前世代同様 95% に届かない、(b) thinking トークンが増えコストは 3.7 世代以上になる、の2点が起きる確率が高いと見ている。この予想が外れる（Recall ≥0.95 が出る）ことこそが本実験の主たる価値。

**RQ1**: depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: $/1K件は B4 の ~$1.70 と比較して許容範囲か？
**RQ3**: 3世代続いた「Recall↓・Precision↑」の傾向は 3.8 でも継続するか、それとも反転するか？（継続する場合、threshold を下げれば Recall 95% に届くかを追加コストなしで確認する）

## 価格

| 期間 | 入力 / 1M tok | 出力 / 1M tok（思考トークン含む） |
|---|---|---|
| 〜2026-12-31（導入価格） | $0.75 | $3.75 |
| 2027-01-01〜 | $1.50 | $7.50 |

`gemini-3.7-flash` と**同額**（3.7 も導入価格 $0.75/$3.75、2027-01-01 から倍増）。したがってコスト差は単価ではなく**消費トークン量の差**としてのみ現れる。レポートでは導入価格ベースの実測値と、2027-01-01 以降の 2 倍換算値を併記する。

## 実験設計

### 条件（thinking_level）

TopP / Temperature は**送らない**（後述「サンプリングパラメータの扱い」）。振るのは `thinking_level` のみ。

| 条件 | thinking_level | maxOutputTokens | 位置付け |
|---|---|---|---|
| F1 | `low` | 8,192 | B4 相当・最安。**最初に本実行する条件** |
| F2 | `medium` | 16,384 | 3.8 の既定 thinking_level。F1 の結果次第で実行 |
| F3 (既定で除外) | `high` | 32,768 | 疎通確認も行わない |
| — (除外) | `minimal` | — | **公式に非対応と明記**（送るとエラー）。実行しない |

**`minimal` を最初から除外する根拠**: 公式ドキュメントに "minimal thinking level is not supported for Gemini 3.8 Flash and will return an error" と明記されている。`gemini-3.7-flash` では同じ非対応に気づかず smoke n=50 を回し、全件 API エラー→フォールバック（`include_probability=1.0`）となって「Recall 100% / Precision 16.0%」という**無効な数値**を出した（[gemini-3.7-flash/report.md](../gemini-3.7-flash/report.md) 5節）。今回はドキュメント上で確定しているので条件表に載せない。

**F3 (`high`) を既定で除外する根拠**: `gemini-3.5-flash` が HIGH で $104/データセット、`gemini-3.6-flash` が HIGH で約 $79/データセットと2世代連続で $20 を大きく超過。3.8 は公式が「トークン消費が増える」と明言しているため、さらに高くなる公算が大きい。F1/F2 の実測を見て、それでも必要と判断された場合のみ smoke から再検討する。

### 段階実行ルール（ユーザー決定 2026-09-03）

```
Phase 0（事前確認・ほぼ無料）
  ↓
F1 (low) smoke n=50 → コスト外挿を提示 → ユーザーが GO/NO-GO
  ↓ GO
F1 (low) フル実行 (n=1,993)
  ↓
  Recall ≥ 0.93 ?
   ├ Yes → F2 (medium) smoke → コスト外挿を提示 → ユーザー GO/NO-GO → フル実行
   └ No  → F2 は実行せず打ち切り（3.7 世代で LOW→MEDIUM の Recall 改善が
            +0.36pp・コスト2.6倍だった実測から、0.93 未満を 0.95 まで
            引き上げる見込みが無いため）
  ↓
threshold スイープ（API 追加費用ゼロ）→ report.md
```

**コスト足切りは固定閾値ではなく都度判断**（ユーザー決定）。smoke の実測から `cost.totalUSD / 50 * 1993` で全件コストを外挿し、その数値を提示してユーザーが GO/NO-GO を出す。過去世代の $20 固定閾値は参考値として併記する。

### サンプリングパラメータの扱い（ユーザー決定 2026-09-03）

公式移行チェックリストが `temperature` / `top_p` / `top_k` を非推奨・削除としているため、**最初から送らない**方針を採る。

これは既存コードに手を入れる必要がある。現状:

- [src/lib/gemini-api.ts:19](../../src/lib/gemini-api.ts#L19) `GeminiModelConfig.temperature` が**必須** `number`
- [src/lib/gemini-api.ts:334](../../src/lib/gemini-api.ts#L334) `generationConfig.temperature = config.temperature` を常時付与（`topP` は既に optional で、undefined なら `JSON.stringify` で落ちる）
- [src/lib/llm-processor.ts:135](../../src/lib/llm-processor.ts#L135) `BatchProcessOptions.temperature` も必須

必要な変更は「`temperature` を optional にし、undefined のときリクエストボディに載せない」だけ（`JSON.stringify` が undefined のキーを落とすため、型を緩めれば送信側の分岐は不要）。ただし **`src/` の共有ライブラリと拡張機能本体に波及する変更**なので、実装は commander 経由（implementer に委譲 → 差分レビュー → 既存テスト green 確認 → PR）で行う。既定モデルの挙動を変えないこと（`temperature` を明示している既存モデルはすべて従来通り送る）を受け入れ条件にする。

**報告書に明記すべき差分**: 本実験のみサンプリング条件が過去世代（Temp 1.0 / TopP 0.95）と揃わない。Recall 差の一部がこの条件差に由来する可能性を排除できない。ただし公式が非推奨としている以上、送った場合の挙動も保証されないため、公式推奨側に合わせる判断とする。

### API 経路

既存ランナーは `src/lib/llm-processor.ts` → `gemini-api.ts` の **`streamGenerateContent`** を叩く。公式ドキュメントは新しい Interactions API (`interactions.create`) を推しているが、本実験は過去世代との比較可能性を優先し **`streamGenerateContent` を維持**する。Phase 0 で 3.8 が同エンドポイントで HTTP 200 を返すことを確認する（返さなければその時点で計画を見直す）。

## Phase 0: 実行前に確認すること（各1リクエスト、コストほぼゼロ）

`gemini-3.7-flash` の E2 事故（非対応パラメータに気づかず smoke 50 件を無駄にし、無効な数値を出した）の再発防止として、フル実行前に以下を実測で潰す。**すべて 1 件ずつのリクエストで済む。**

| # | 確認事項 | 期待 | 外れたときの対応 |
|---|---|---|---|
| P0-1 | `models.list` に `gemini-3.8-flash` が存在し、`streamGenerateContent` / `generateContent` / `countTokens` を対応メソッドに含む | 存在する | 存在しない/メソッド非対応なら計画中止・ユーザー報告 |
| P0-2 | 入力/出力トークン上限（公称 1,048,576 / 65,536） | 公称通り | maxOutputTokens 設定を実値に合わせる |
| P0-3 | `thinking_level: low` / `medium` で HTTP 200 | 200 | 400 ならその水準を除外 |
| P0-4 | **`temperature` / `topP` を送った場合**の HTTP ステータス | 不明（200 で無視 or 400） | 記録のみ。本実験は送らない方針だが、拡張機能本体が既定で送っているため、400 なら「3.8 を UI に載せる際は必ず省略経路が要る」という別 Issue になる |
| P0-5 | **`temperature` / `topP` を送らない場合**の HTTP 200 と `usageMetadata` の取得 | 200 かつ `thoughtsTokenCount` が取れる | 取れないならコスト試算方法を見直す |
| P0-6 | JSON レスポンススキーマ（`responseMimeType: application/json` + `responseSchema`）が従来通り機能する | 機能する | 機能しないならパーサ側の対応が必要 |

Phase 0 の結果は `config.json` の `phase0Findings` と report.md に必ず残す。

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall@0.5) | ★最重要 | ≥ 0.95 |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | ≥ 0.93 |
| 処理時間 (ms/件) | コスト評価 | — |
| $/1K件（導入価格 / 2027年価格の両方） | ★ | B4 比 ≤ 5倍 |
| MAX_TOKENS 切り詰め率 | 信頼性 | ≤ 5% |
| フォールバック率（`parse_error`） | 妥当性検証 | 0% であること |

**無効データの検知ルール（3.7 世代の教訓）**: フォールバックは安全側（`include_probability=1.0`）に倒れるため、API が全滅すると必ず「Recall 100% + 異常に低い Precision」が出る。この組み合わせが出たら結果を採用せず、まず API 呼び出しの成否を疑う。ランナーは `fallbackCount` を毎回ログに出す。

## 判断基準（採用判定表）

`gemini-3.7-flash` の判定表をそのまま流用する（世代間で判定ルールを揃えるため）。

| Recall | B4比コスト | 結論 |
|---|---|---|
| ≥ 0.96 | ≤ 2倍 | デフォルト切替候補 |
| ≥ 0.96 | 2–5倍 | UI公開（上位互換枠） |
| ≥ 0.96 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.95–0.96 | ≤ 5倍 | UI公開（上位互換枠） |
| 0.95–0.96 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.93–0.95 | — | フォールバック検討 |
| < 0.93 | — | 現行維持（却下） |

コスト比は**導入価格（〜2026-12-31）での実測値**で判定し、2027-01-01 以降の 2 倍換算値を併記する。UI 公開判断に進む場合は「価格改定後も基準を満たすか」を別途明記する。

## 追加分析: threshold スイープ（ユーザー決定 2026-09-03、API 追加費用ゼロ）

フル実行で保存した JSONL の `include_probability` を再利用し、threshold 0.05 / 0.10 / 0.20 / 0.30 / 0.40 / 0.50 で Recall / Specificity / Precision / Fβ(7) を再計算する。[experiments/gpt-5.6/threshold_sweep.ts](../gpt-5.6/threshold_sweep.ts) と同型のスクリプトを用意する。

目的は RQ3。3.7 世代のように「Recall↓・Precision↑（除外方向への偏り）」が出た場合、**閾値を下げれば Recall 95% に到達できるのか、到達しても同 Recall 帯の B4 に Precision で劣るのか**を追加費用なしで判定する。gpt-5.6 では threshold 0.05 まで下げれば Recall 95.7% に届いたが Precision が 38〜48% に落ち、同 Recall 帯の B4 に劣るという結論だった（[gpt-5.6/threshold_sweep.md](../gpt-5.6/threshold_sweep.md)）。同じ形で比較する。

## データセット

- `scripts/asreview-baseline/datasets/depression_slim_labeled.json`（n=1,993、陽性 280件 = 14.0%）
- 由来: [experiments/data/datasets/zenodo_151190_depression.md](../data/datasets/zenodo_151190_depression.md)
- 判定基準（`config.json` の `datasetConfigs.depression.criteria`、過去世代と同一文言を使う）:
  ```
  Include studies on in vivo models of depression (Animal studies).
  Exclude human studies.
  Exclude studies where 'depression' refers to respiratory depression, cardiac depression, etc.
  ```
- スクリーニングプロンプトも過去世代と同一（`config.json` の `defaultScreeningPrompt`）。**プロンプトは一切変えない** — 変えるとモデル間比較が成立しなくなる。

## 実装物（未作成 / commander 経由で実装する）

`experiments/gemini-3.7-flash/` をベースにコピーして作る。中断耐性（JSONL への1件ごと追記 + 再開）はそのまま流用する。

| ファイル | 内容 |
|---|---|
| `config.json` | model / pricing / conditions (F1, F2) / excludedConditions (F3, minimal) / tierConfigs / phase0Findings |
| `runner.ts` | 3.7 版のコピー。条件から `temperature` / `topP` を送らない経路に対応 |
| `run_phase1.ts` | 段階実行（F1 のみ既定。F2 は明示指定で実行） |
| `summarize.ts` | 3.7 版のコピー |
| `threshold_sweep.ts` | gpt-5.6 版のコピー（JSONL の項目名に合わせる） |
| `tsconfig.json` | 3.7 版と同一 |
| `src/lib/gemini-api.ts` / `src/lib/llm-processor.ts` | `temperature` を optional にする（拡張機能本体に波及するため commander でレビュー必須） |

## 実行コマンド（実装後）

```bash
# Phase 0（models.list とパラメータ疎通、各1リクエスト）
npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
  experiments/gemini-3.8-flash/phase0_probe.ts

# F1 smoke（疎通 + コスト外挿、n=50）
npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
  experiments/gemini-3.8-flash/runner.ts --dataset depression --condition F1 --tier tier_smoke --sample 50

# F1 フル実行（ユーザー GO 後）
npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
  experiments/gemini-3.8-flash/runner.ts --dataset depression --condition F1 --tier tier_max

# 中断しても同じコマンドで再開する（results/depression_F1_items.jsonl の未処理分のみ）
# 最初からやり直す場合のみ --fresh

# threshold スイープ（API 追加費用ゼロ）
npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
  experiments/gemini-3.8-flash/threshold_sweep.ts

# サマリー
npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
  experiments/gemini-3.8-flash/summarize.ts
```

API キーはプロジェクトルートの `.env` の `GEMINI_API_KEY` を `dotenv` 経由で読む（[experiments/README.md](../README.md)）。**キーや URL をログ・レポートに出さないこと。**

## 想定コストと所要時間

| 段階 | 件数 | 想定コスト | 根拠 |
|---|---|---|---|
| Phase 0 | 約6リクエスト | < $0.01 | 1件ずつ |
| F1 smoke | 50 | $0.05〜0.15 | 3.7 の E1 smoke が $0.062 |
| F1 フル | 1,993 | $2.5〜6 | 3.7 の E1 フルが $2.47。3.8 はトークン増の公式言及があるため上振れ想定 |
| F2 smoke | 50 | $0.2〜0.5 | 3.7 の E3 smoke が $0.198 |
| F2 フル | 1,993 | $6.5〜15 | 3.7 の E3 フルが $6.52 |
| **合計（F2 まで進んだ場合）** | — | **$9〜22** | F1 で打ち切れば $3〜6 |

所要時間は 3.7 世代の実測（LOW 42.6ms/件、MEDIUM 56.9ms/件、concurrency 60）から、フル1条件あたり数分〜十数分の見込み。3.8 は思考ステップが増える設計のため、レイテンシは上振れしうる。

## リスクと対処

| リスク | 対処 |
|---|---|
| `temperature` 省略のための `src/` 変更が拡張機能本体を壊す | commander 経由で実装・レビューし、既存テストを green で確認してからマージ |
| 3.8 の思考トークンが想定を大きく超え予算を食う | smoke で必ず外挿してからユーザーが GO/NO-GO。中断しても JSONL 再開でやり直しコストは未処理分のみ |
| API 全滅に気づかず無効な数値を出す | `fallbackCount` を毎回ログ出力。「Recall 100% + 低 Precision」を無効データのシグナルとして扱う |
| `streamGenerateContent` が 3.8 で非対応 | Phase 0 (P0-1) で検知し、その時点で計画を見直す |
| サンプリング条件が過去世代と揃わない | report.md に条件差を明記し、Recall 差の解釈に留保を付ける |

## 成果物

- `experiments/gemini-3.8-flash/report.md`（この計画と同じ節構成 + 実測値）
- [README.md](../../README.md) のリーダーボードへの追記（採用可否にかかわらず参考記録として1行）
- 採用判定が「デフォルト切替候補」または「UI公開」に該当した場合のみ、[src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) の `AVAILABLE_MODELS` 追加を別 PR で検討

## 参照

- 公式: [Gemini API Models](https://ai.google.dev/gemini-api/docs/models)（3.8 Flash の GA アナウンス、thinking level、移行チェックリスト、導入価格）
- 過去世代の計画・レポート: [gemini-3.7-flash/](../gemini-3.7-flash/)、[gemini-3.6-flash/](../gemini-3.6-flash/)、[gemini-3.5-flash/](../gemini-3.5-flash/)、[gpt-5.6/](../gpt-5.6/)
- 全体リーダーボード: [experiments/report.md](../report.md)、[README.md](../../README.md)
