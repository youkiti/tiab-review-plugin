# 実験レポート: gemini-3.5-flash

**実施日**: 2026-05-20
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — [experiments/report.md](../report.md)
- GA C1 (`gemini-3.1-flash-lite`, Temp 0) — [experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md)

## 1. 目的

2026-05 リリースの `gemini-3.5-flash` がリーダーボードに追加可能か（B4 を上回るか）を検証する。
公式価格は **入力 $1.50 / 出力 $9.00 (思考トークン含む) / 1M tokens** と従来 Flash 系より高価格帯のため、Recall とコストの両軸で評価する。

## 2. 実験設計

depression データセット (n=1,993, 陽性 280件) で thinking_level マトリクスを比較。
TopP 0.95 / Temp 1.0 固定、`thinking_level` のみ変動。

| 条件 | thinking_level | maxOutputTokens | 備考 |
|---|---|---|---|
| D1 | LOW | 8,192 | B4 相当 |
| D2 | MINIMAL | 4,096 | B2 相当 |
| D3 | MEDIUM | 16,384 | B6 相当 |
| ~~D4~~ | ~~HIGH~~ | ~~32,768~~ | **除外**: 疎通確認で $52/1K件（1,993件で約 $104）と判明、コスト過大のため本実行から除外 |

threshold は全条件で 0.5 固定。

### MAX_TOKENS 切り詰め対策 (今回新規実装)

過去の Flash 系実験で `thinking_level=high` 時に MAX_TOKENS 切り詰めによる無駄なリトライが発生していたため、以下を改修:

1. [src/lib/gemini-api.ts](../../src/lib/gemini-api.ts): ストリーミング応答から `finishReason` を抽出し、`MAX_TOKENS` を検出したら `code='max_tokens_truncated'` (retryable=false) として投げる。
2. [src/lib/llm-processor.ts](../../src/lib/llm-processor.ts): `max_tokens_truncated` を即座にフォールバック処理へ（無駄な指数バックオフを回避）。フォールバックは include_probability=1.0 で記録（SR 保守主義）。
3. [runner.ts](runner.ts): MAX_TOKENS 件数を集計し、レポートに明示。

→ 本実験では全条件 (D1–D4 含む) で **MAX_TOKENS 切り詰めは 0件**。`maxOutputTokens` の段階設定は妥当だった。

## 3. Phase 1 結果 (depression, n=1,993, 陽性 280件)

| 条件 | thinking | Temp | TopP | maxOut | Recall | Precision | Fβ(7) | TP | FP | TN | FN | フォールバック | MAX_TOK | 時間(s) | $/1K件 | 総コスト |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 | LOW | 1.0 | 0.95 | 8,192 | **92.5%** | 60.1% | 91.5% | 259 | 172 | 1,541 | 21 | 0 | 0 | 146 | $7.11 | $14.18 |
| D2 | MINIMAL | 1.0 | 0.95 | 4,096 | **93.2%** | 54.6% | 91.9% | 261 | 217 | 1,496 | 19 | 0 | 0 | 62 | $1.93 | $3.85 |
| D3 | MEDIUM | 1.0 | 0.95 | 16,384 | **92.1%** | 60.7% | 91.2% | 258 | 167 | 1,546 | 22 | 0 | 0 | 510 | $31.77 | $63.31 |
| **B4 (参考)** | LOW | 1.0 | 0.95 | - | **96.1%** | 53.4% | 95.0% | 269 | 235 | 1,478 | 11 | - | - | - | (推定 $1.70) | - |
| GA C1 (参考) | - | 0 | - | - | **93.6%** | 61.6% | 92.6% | 262 | 163 | 1,550 | 18 | - | - | - | (推定 $0.30) | - |

### 疎通確認のみで除外された条件 (n=50, 統計的有意性なし)

| 条件 | thinking | n | Recall | $/1K件 (実測) | 除外理由 |
|---|---|---|---|---|---|
| D4 | HIGH | 50 | 100.0% | $52.16 | 1,993件で約 $104、B4 比 30倍以上のコスト過大 |

**Phase 1 実コスト合計: 約 $86** (疎通 $4.7 + D1 $14.18 + D2 $3.85 + D3 $63.31)

## 4. 分析

### 4.1 Recall は B4 に届かない

最良条件の D2 (MINIMAL) でも Recall 93.2%、B4 (96.1%) に **-2.9pp**。
現行デフォルトの GA C1 (93.6%) すら下回る。

`gemini-3.5-flash` は depression データセットにおいて、SR 用途で求める Recall ≥0.95 を達成できなかった。

### 4.2 思考トークンを増やすほど Recall が下がる傾向

| thinking_level | Recall | 思考トークン/件 (平均) | $/1K件 |
|---|---|---|---|
| MINIMAL | **93.2%** | 0 | $1.93 |
| LOW | 92.5% | 約 400 | $7.11 |
| MEDIUM | 92.1% | 約 4,600 | $31.77 |

→ 「より深く考えさせる」設定が逆に Recall を下げる **逆相関**。
B シリーズでも HIGH (95%) < LOW (96%) という同様傾向が観察されており、今回はさらに広い帯域で確認された。
depression のような動物実験除外という単純な判定では、過剰な思考は **過度に exclude 寄り** に判定を倒してしまう可能性がある (FN 増加: D2=19 → D3=22)。

### 4.3 コスト面の優位性もない

最良の D2 で $1.93/1K件、B4 推定 ($1.70/1K件) と同等。
GA C1 ($0.30/1K件) には大きく劣る。
Recall・コスト両面で既存モデルに対する優位性が認められない。

### 4.4 MAX_TOKENS 対策は奏功

新規実装した MAX_TOKENS 検出は、4,000〜32,768 トークンの maxOutputTokens 設定下で **全条件 0件** の切り詰めを実現。
将来 thinking_level=HIGH を採用する場合も、maxOutputTokens=32,768 で十分なマージンがあることが確認された。

## 5. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.96 & B4比コスト ≤ 2倍 → デフォルト切替 | ❌ 未達 (最良 93.2%) |
| Recall ≥ 0.95 & コスト 2–5倍 → UI 公開 | ❌ 未達 |
| Recall 0.93–0.95 → フォールバック検討 | ⚠️ 該当 (93.2%) だが GA C1 (93.6%) が既存のため不要 |
| Recall < 0.93 → 現行維持 | — |

**`gemini-3.5-flash` は現時点で systematic review 用途のリーダーボードに追加する優位性がない。**

- B4 (`gemini-3-flash-preview`) に対し depression Recall **-2.9pp**
- 現行デフォルト GA C1 (`gemini-3.1-flash-lite`) と比較してもわずかに劣る
- コスト ($1.93/1K件) も B4 と同等、優位性なし
- thinking_level を上げると Recall がむしろ低下（逆相関）

**推奨**:
- **UI 公開しない** ([src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `AVAILABLE_MODELS` に追加しない)
- 実験記録は本レポートで残し、将来モデル更新時に再評価
- リーダーボード ([README.md](../../README.md) の「LLMスクリーニング精度ベンチマーク」セクション) には**参考エントリ**として追記し、SR 用途で追加不可だった事実を明示

## 6. 副産物

本実験のために実装したコード改修は永続化:

- **MAX_TOKENS 検出**: [src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `callGeminiApi` 内に finishReason チェックを追加
- **非リトライ即フォールバック**: [src/lib/llm-processor.ts](../../src/lib/llm-processor.ts) `processWithRetry` で `max_tokens_truncated` を即座にフォールバック
- **`gemini-3.5-flash` の BATCH_PROFILE_OVERRIDES**: [src/lib/types.ts](../../src/lib/types.ts) に追加（将来採用時に即利用可能）

将来 thinking モデルを再評価する場合、これらの基盤がそのまま利用できる。

## 7. ソースコード・元データ

- 実験計画: [plan.md](plan.md)
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- 結果サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下
- 元データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md) (B4)、[experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md) (GA C1)
