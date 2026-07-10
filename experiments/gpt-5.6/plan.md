# gpt-5.6-luna depression ベンチマーク計画

## 目的
depression データセット（1,993件 / 陽性280件）で `gpt-5.6-luna` のタイトル・抄録スクリーニング性能を測定し、既存ベースライン **B4**（`gemini-3-flash-preview`, thinkingLevel=LOW / Recall 96.1% / Precision 53.4% / Fβ7 95.2%）と横並び比較する。採用基準は既存踏襲で **Recall ≥ 95%**。

## モデル選定
- gpt-5.6 は **Sol / Terra / Luna** の3ティア。エイリアス `gpt-5.6` は最上位 **Sol**（$5/$30）にルーティングされる。
- 本実験は既存ベンチの比較相手（Gemini Flash 等の高速・安価層）と整合する **Luna**（`gpt-5.6-luna`, input $1.00 / cached $0.10 / output $6.00）を採用。
- 価格・モデルID は 2026-07 の developers.openai.com/api/docs 記載値（confidence: medium）。疎通で実在確認する。

## 実験設計

reasoning モデルは `temperature` / `top_p` を HTTP 400 で拒否するため、探索軸は **reasoning_effort のみ**。
gpt-5.6 は `minimal` 非対応（公式サポート値: `none/low/medium/high/xhigh/max`）。最小段は **none** を採用。

| 条件ID | reasoning_effort | max_output_tokens | 狙い |
|---|---|---|---|
| G56-none | none | 8192 | 非推論ベースライン（最速・最安） |
| G56-low | low | 8192 | 低 reasoning。B4 相当のバランス点 |
| G56-med | medium | 16384 | 中 reasoning。精度上限側 |
| G56-high | high | 32768 | 高 reasoning。reasoning トークン最多・コスト最大 |

- **verbosity**: 探索しない（固定）。provider は `verbosity=low` を送信。gpt-5.6 ドキュメントに verbosity 記載がないため、疎通で 400 が出た場合は provider から外す。
- 出力言語 `ja`、screening prompt / criteria は既存 depression 設定を流用（in vivo 動物モデルの depression、呼吸抑制等を除外）。

## 評価
- threshold=0.5、Recall / Specificity / Precision / **Fβ(β=7)**（既存 openrouter-bench の `calculateMetrics` と完全一致）。

## コスト計測・再計算性
- **per-item で生トークンを保存**（`items_*.json`）: prompt / **cached** / completion / reasoning / total。
- 集計と推定コストは `experiment_*.log.json` の `results` に保存。cached 入力は割引単価で計算:
  `cost = (prompt-cached)/1M × input + cached/1M × cachedInput + (completion+reasoning)/1M × output`
- 生トークンが残るため、**単価が後で変わっても config を直して再計算可能**。

## 実装
- `experiments/gpt-5.6/` に閉じる（本体ロジックは触らない）。ただし以下の src 追記のみ実施:
  - `src/lib/types.ts`: `UsageMetadata.cachedInputTokens?`（cached 保存用、optional 追加）
  - `src/lib/providers/openai.ts`: `input_tokens_details.cached_tokens` を usage にマッピング
  - `src/lib/llm-provider.ts`: `reasoningEffort` union に `'none'` を追加
- runner は `src/lib/providers/openai.ts` の `screenViaOpenAi` を再利用（Node 環境では `OPENAI_API_KEY` を `.env` から読む）。
- 長時間の全件 run に備え、`checkpointEvery`（既定50）件ごとに items / log を中間保存（途中クラッシュ耐性）。

## 実行手順
```bash
# 1) 疎通（数件）— モデルID実在・verbosity 400有無・1件コスト実測
npx ts-node --project experiments/tsconfig.json experiments/gpt-5.6/runner.ts --condition G56-none --sample 5
npx ts-node --project experiments/tsconfig.json experiments/gpt-5.6/runner.ts --condition G56-high --sample 5

# 2) 全条件を全件で順次実行
npx ts-node --project experiments/tsconfig.json experiments/gpt-5.6/run_all.ts --dataset depression

# 3) 集計 → report.md
npx ts-node --project experiments/tsconfig.json experiments/gpt-5.6/summarize.ts
```

## リスク管理
- **high effort のコスト**: 過去に Gemini の HIGH thinking を $104/データセットで除外した前例あり。疎通で high の1件あたりトークン／コストを実測し、全件換算が過大なら全件前に相談する。
- runner は中間保存するので、コスト超過時は途中中断しても取得済み結果は残る。

## データ・ソース
- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`（N=1,993 / 陽性280）
- config: `experiments/gpt-5.6/config.json`
- runner: `experiments/gpt-5.6/runner.ts`
