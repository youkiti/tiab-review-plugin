# OpenRouter ベンチマーク計画 (Step 0)

## 目的

`openrouter` 経由で利用可能な Kimi / Qwen の最新モデルが、現行 Gemini ベースの TiAb スクリーニングの代替・拡張として有用かを定量的に判断する。

論文化プロジェクト（科研費 25K13585）の根拠データにも転用できるよう、評価条件・データ・プロンプトを既存 Gemini 評価と完全に揃える。

## スコープ外

- 本体プラグイン（src/）のリファクタや provider 抽象化（Step 2 以降）。
- 複数データセットでの広域比較（depression 1 本でまず勝ち負けを確定）。

## 条件（4 条件、temperature 等は OpenRouter 標準値ベース）

| ID | Provider | Model | Temperature | TopP | Reasoning |
|---|---|---|---|---|---|
| REF-B | Gemini | `gemini-3-flash-preview` | 1.0 | 0.95 | thinkingLevel=LOW |
| OR-Q1 | OpenRouter | `qwen/qwen3-235b-a22b-2507` | 0 | - | なし（Instruct 2507） |
| OR-Q2 | OpenRouter | `qwen/qwen3-235b-a22b-thinking-2507` | 1.0 | 0.95 | effort=medium |
| OR-K1 | OpenRouter | `moonshotai/kimi-k2-thinking` | 1.0 | - | effort=medium |

## データセット

`scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 全件: 1,993 件
- 陽性: 280 件 / 陰性: 1,713 件
- 既知 B4 ベースライン: Recall 96.1% / Precision 53% / FN 11 件

## プロンプト

`experiments/openrouter-bench/config.json` の `defaultScreeningPrompt` を使用。既存 [experiments/experiments.json](../experiments.json) と同一。

## 出力スキーマ

`include_probability` (0-1) / `reasons` (string[]) / `evidence` ({field, quote, start_char, end_char}[]) を `response_format: json_schema` で強制。

## 評価指標

`runner.ts` の `calculateMetrics` で計算（既存 [experiments/runner.ts](../runner.ts) と同一実装）:
- Sensitivity / Specificity / Precision
- Fβ score (β=7)
- TP / FP / TN / FN
- tokens (prompt/completion/reasoning)
- 推定コスト（USD、config.json の `pricing` から算出）
- 1 件あたり平均レイテンシ (ms)

## 実行手順

```bash
# 0. .env に OPENROUTER_API_KEY を追加（GEMINI_API_KEY と並列）

# 1. 動作確認 (sample=50 で 1 条件だけ)
npx ts-node --project experiments/tsconfig.json experiments/openrouter-bench/runner.ts \
    --dataset depression --condition OR-Q1 --sample 50

# 2. 全 4 条件で sample=300 のスモークテスト
npx ts-node --project experiments/tsconfig.json experiments/openrouter-bench/run_all.ts \
    --dataset depression --sample 300

# 3. 結果が許容範囲なら全件で本番実行
npx ts-node --project experiments/tsconfig.json experiments/openrouter-bench/run_all.ts \
    --dataset depression

# 4. レポート集約
npx ts-node --project experiments/tsconfig.json experiments/openrouter-bench/summarize.ts
```

## 判定基準

- **採用候補**: Recall ≥ 0.95 かつ、Precision・コスト・レイテンシのいずれかで B4 を上回る
- **フォールバック枠**: Recall 0.93-0.95（オプション選択肢として残す）
- **不採用**: Recall < 0.93

## リスクと対応

- OpenRouter の provider routing で同 model でも実体が変わる場合がある。`responseMetadata.provider` をログに残し、再現性チェックに使う。
- JSON Schema strict が provider 側で落ちることがある。`tryParseJson` でテキスト中の `{...}` 抽出フォールバックあり。
- Kimi K2 系は SR の単発判定で過剰推論する可能性があり。effort=medium で始め、必要なら low にも下げて再評価。

## 完了後の Step 1 (バージョンアップ計画) への引継ぎ

- 採用候補が決まったら → `src/lib/gemini-api.ts` を `LlmProvider` インタフェースへリファクタし、`openrouter-provider.ts` を追加（v0.20.0 β）
- 採用候補がなかった場合 → Gemini 維持、OpenRouter は実装しないか、ユーザー要望ベースで再検討
