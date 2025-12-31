# LLMモデル比較実験計画 (Updated 2025-12-31)

## 目的

タイトル・抄録スクリーニングにおいて、どのGeminiモデルを、どのパラメータ設定で使用すると最適な精度（特にSensitivity）が得られるかを検証する。

## 重要な知見 (Pre-experiment Findings)

1. **Inclusion Criteriaの必須性**:
   データセットごとに具体的な組み入れ基準（PICO等）をプロンプトに含めないと、Specificityが著しく低下する（FP増大）。
   - 対応: `experiments.json` の `datasetConfigs` に全データセットのCriteriaを定義済み。

2. **APIレート制限と高速化**:
   Tier 2 (Paid) 環境では、**Concurrency 50 / Delay 5ms** という設定で1,000件あたり約1分という高速処理が可能。

3. **タイムアウト設定**:
   APIハング対策として **60秒** のタイムアウト設定が必須（Thinkingモデル含む）。

---

## 評価指標

### 主要指標: Fβスコア（β=7）

$$
F_\beta = (1 + \beta^2) \cdot \frac{\text{Precision} \cdot \text{Recall}}{\beta^2 \cdot \text{Precision} + \text{Recall}}
$$

**Sensitivity（感度/Recall）を非常に重視**した評価。取りこぼし（FN）のペナルティを大きくする。

### 副次指標
- **Sensitivity**（感度）: TP / (TP + FN) - 最重要
- **Specificity**（特異度）: TN / (TN + FP) - Criteria導入で改善
- **Precision**（精度）: TP / (TP + FP)

---

## 評価データセット

各データセットのCriteriaは `experiments.json` に定義済み。

| Dataset | 総数 | 採用 | 率(%) | 推奨度 | 特徴 |
|---------|------|------|-------|--------|------|
| **CQ1** | 5,628 | 113 | 2.01% | ★★★ | Sepsis/Fluid管理。大規模・高信頼性。本番用。 |
| **Depression** | 1,993 | 280 | 14.05% | ★★★ | 動物モデル。高採用率でSensitivity検証に最適。 |
| **CQ3** | 1,038 | 16 | 1.54% | ★★☆ | 重炭酸Na。小規模で高速テスト用。 |
| CQ4 | 4,326 | 72 | 1.66% | ★★☆ | EGDT/Sepsis。CQ1と同様の傾向。 |
| CQ5 | 2,253 | 41 | 1.82% | ★☆☆ | Restrictive Fluid。 |
| CQ2 | 3,400 | 17 | 0.50% | ★☆☆ | 血圧管理。採用数が少なすぎる。 |
| Wilson | 3,453 | 0? | 0.00% | ☆☆☆ | ラベルデータ異常のため使用不可。 |

---

## 実験条件 (Conditions)

### Model A: gemini-2.5-flash-lite (8条件)

| ID | Temp | TopP | 狙い |
|----|------|------|------|
| A1 | 0.0 | 0.65 | 決定的・厳格 (※タイムアウト注意) |
| A2 | 0.0 | 0.95 | 決定的・多様 |
| A3 | 0.3 | 0.65 | **推奨ベースライン** |
| A4 | 0.3 | 0.95 | バランス |
| A5-A8 | 0.5-1.0 | - | 創造性重視（スクリーニングには不向きか検証） |

### Model B: gemini-3-flash-preview (8条件)

Thinking機能付きモデル。
- Parameters: `thinkingLevel` (MINIMAL - HIGH), `topP`

---

## 実行設定 (experiments.json)

### レート制限 (Tier 2)
```json
"tier2": {
    "concurrency": 50,
    "delayBetweenRequests": 5
}
```

### 実行コマンド例

**1. 限界性能テスト / 動作確認 (CQ3)**
```bash
npx ts-node runner.ts --dataset cq3 --condition A3 --tier tier2
```

**2. 本番実験 (Depression)**
```bash
npx ts-node runner.ts --dataset depression --condition A3 --tier tier2
```

**3. 大規模実験 (CQ1)**
```bash
npx ts-node runner.ts --dataset cq1 --condition A3 --tier tier2
```

---

## 実装状況

- [x] **Runner拡張**: CLI引数, ログ出力, 正規化
- [x] **Rate Limit最適化**: Tier 2 (50/5ms) 実装済み
- [x] **Criteria注入**: 各データセット固有の基準をプロンプトに反映
- [x] **Timeout**: 60秒設定済み
- [ ] **全条件比較**: 今後のタスク
