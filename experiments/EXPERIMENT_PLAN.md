# LLMモデル比較実験計画

## 目的

タイトル・抄録スクリーニングにおいて、どのGeminiモデルを、どのパラメータ設定で使用すると最適な精度が得られるかを検証する。

## 評価指標

### 主要指標: Fβスコア（β=7）

$$
F_\beta = (1 + \beta^2) \cdot \frac{\text{Precision} \cdot \text{Recall}}{\beta^2 \cdot \text{Precision} + \text{Recall}}
$$

β=7 により、**Sensitivity（感度/Recall）を非常に重視**した評価となる。
システマティックレビューでは、関連文献の取りこぼしを最小化することが重要であるため、この設定が適切。

### 副次指標

- Sensitivity（感度）: TP / (TP + FN)
- Specificity（特異度）: TN / (TN + FP)
- Precision（精度）: TP / (TP + FP)

---

## 対象モデルとパラメータ

### Model A: gemini-2.5-flash-lite

軽量・高速モデル。思考機能なし。

| パラメータ  | 調整可能範囲 | 実験値                     |
| ----------- | ------------ | -------------------------- |
| temperature | 0.0 - 2.0    | **0, 0.3, 0.5, 1.0** |
| topP        | 0.0 - 1.0    | **0.65, 0.95**       |
| topK        | 64（固定）   | -                          |

**条件数**: 4 × 2 = **8条件**

### Model B: gemini-3-flash-preview

最新の思考機能付きモデル。

| パラメータ    | 調整可能範囲               | 実験値               |
| ------------- | -------------------------- | -------------------- |
| thinkingLevel | MINIMAL, LOW, MEDIUM, HIGH | **全4レベル**  |
| topP          | 0.0 - 1.0                  | **0.65, 0.95** |
| temperature   | デフォルト1.0推奨          | **変更しない** |
| topK          | 64（固定）                 | -                    |

**条件数**: 4 × 2 = **8条件**

---

## 実験条件一覧

### gemini-2.5-flash-lite（8条件）

| ID | model                 | temperature | topP |
| -- | --------------------- | ----------- | ---- |
| A1 | gemini-2.5-flash-lite | 0.0         | 0.65 |
| A2 | gemini-2.5-flash-lite | 0.0         | 0.95 |
| A3 | gemini-2.5-flash-lite | 0.3         | 0.65 |
| A4 | gemini-2.5-flash-lite | 0.3         | 0.95 |
| A5 | gemini-2.5-flash-lite | 0.5         | 0.65 |
| A6 | gemini-2.5-flash-lite | 0.5         | 0.95 |
| A7 | gemini-2.5-flash-lite | 1.0         | 0.65 |
| A8 | gemini-2.5-flash-lite | 1.0         | 0.95 |

### gemini-3-flash-preview（8条件）

| ID | model                  | thinkingLevel | topP |
| -- | ---------------------- | ------------- | ---- |
| B1 | gemini-3-flash-preview | MINIMAL       | 0.65 |
| B2 | gemini-3-flash-preview | MINIMAL       | 0.95 |
| B3 | gemini-3-flash-preview | LOW           | 0.65 |
| B4 | gemini-3-flash-preview | LOW           | 0.95 |
| B5 | gemini-3-flash-preview | MEDIUM        | 0.65 |
| B6 | gemini-3-flash-preview | MEDIUM        | 0.95 |
| B7 | gemini-3-flash-preview | HIGH          | 0.65 |
| B8 | gemini-3-flash-preview | HIGH          | 0.95 |

**総条件数**: 16条件

---

## 評価データセット

利用可能なデータセットのメタデータは `experiments/data/datasets/` に整理されています。

### データセット一覧

| Dataset | 総数 | 採用 | 有病率 | 備考 |
|---------|------|------|--------|------|
| **CQ1** | 5,628 | 113 | 2.01% | 臨床ガイドライン関連 |
| **CQ2** | 3,400 | 17 | 0.50% | 臨床ガイドライン関連 |
| **CQ3** | 1,038 | 16 | 1.54% | 臨床ガイドライン関連 |
| **CQ4** | 4,326 | 72 | 1.66% | 臨床ガイドライン関連 |
| **CQ5** | 2,253 | 41 | 1.82% | 臨床ガイドライン関連 |
| **Depression** | 5,749 | - | - | Zenodo 151190, うつ病動物モデル |
| **Wilson** | 3,453 | 26 | 0.75% | Zenodo 3625931, Wilson病治療 |
| **CD012268** | - | 18 | - | Cochrane, カルシウム・肥満 |

**CQ合計**: 16,645件（採用259件）

### 実験用データセット選定

| 優先度 | データセット | 理由 |
|--------|-------------|------|
| ★★★ | CQ1 | 最大規模、適度な有病率（2%） |
| ★★☆ | CQ4 | 2番目に大きい |
| ★★☆ | Wilson | 低有病率（0.75%）、厳しい条件 |
| ★☆☆ | CQ3 | 小規模（1,038件）、テスト用 |

### データ形式

```json
[
  {
    "id": "ref_001",
    "title": "論文タイトル",
    "abstract": "アブストラクト",
    "label_included": 0 | 1
  }
]
```

### データ配置

- **データセット**: `scripts/asreview-baseline/datasets/`
  - `cq1_labeled.json` 〜 `cq5_labeled.json`
  - `depression_slim_labeled.json`
  - `wilson_tiab_labeled.json`
- **メタデータ**: `experiments/data/datasets/*.md`
- **スクリーニング基準**: 各データセットのメタデータファイルを参照

---

## 実験手順

### 1. 環境準備

```bash
cd experiments
npm install
```

### 2. 実験実行

```bash
npx ts-node runner.ts --config experiments.json
```

### 3. 結果出力

各条件の結果は `experiments/results/` に保存：

```
results/
├── condition_A1_2025-01-01.json
├── condition_A2_2025-01-01.json
├── ...
└── summary_2025-01-01.json
```

---

## 実装要件

### runner.ts の拡張

- [ ] 複数モデル対応
- [ ] gemini-3-flash-preview の thinkingConfig 対応
- [ ] 条件一括実行機能
- [ ] 結果のJSON出力

### 評価スクリプト

- [ ] `evaluate.ts` の作成
  - Fβ（β=7）スコア計算
  - Sensitivity, Specificity, Precision 計算
  - 閾値別の評価（0.3, 0.5, 0.7）

---

## 想定スケジュール

| ステップ | 内容               | 所要時間 |
| -------- | ------------------ | -------- |
| 1        | 評価データ準備     | TBD      |
| 2        | runner.ts 拡張     | 1-2時間  |
| 3        | 実験実行（16条件） | ~30分    |
| 4        | 結果分析・レポート | 1時間    |

---

## 備考

- 各条件1回のみ実行（安定性検証は行わない）
- API制限に注意（QPM, RPM）
- 結果はコミットしない（.gitignore に追加済み）
