# Cochrane CD012268 - Calcium Supplementation for Obesity Dataset

## 概要

| 項目 | 内容 |
|------|------|
| **レビュータイトル** | Calcium supplementation for people with overweight or obesity |
| **Cochrane ID** | CD012268 |
| **DOI** | [10.1002/14651858.CD012268.pub2](https://doi.org/10.1002/14651858.CD012268.pub2) |
| **著者** | Gabriela Cormick, Agustín Ciapponi, et al. |
| **公開日** | 2024年5月9日 |
| **検索データベース** | CENTRAL, MEDLINE, Embase, LILACS, ClinicalTrials.gov |
| **検索最終日** | 2023年5月10日 |

## ローカルファイル

- **パス**: `scripts/asreview-baseline/datasets/mendeley_CD012268_data_cleaned.json`
- **形式**: JSON配列
- **フィールド**: `id`, `title`, `abstract`, `label_included` (0=除外, 1=組み入れ)

## 研究目的

過体重または肥満を持つ人々に対するカルシウム補充の体重減少効果を評価すること。

## 組み入れ基準 (Inclusion Criteria)

### 研究デザイン
- **ランダム化比較試験 (RCT)** のみ

### 参加者
- 過体重または肥満の参加者（年齢・性別不問）
- 吸収障害のある参加者は除外

### 介入
次のいずれか：
1. カルシウム補充 vs プラセボ
2. カルシウム強化食品/飲料 vs プラセボ
3. カルシウム強化食品/飲料 vs 非強化食品/飲料

### 研究期間
- 最低2ヶ月以上

### アウトカム
**主要アウトカム:**
- 体重変化
- 健康関連QOL
- 有害事象

**副次的アウトカム:**
- その他の人体計測指標（BMI、腹囲、体脂肪量など）
- 全死因死亡
- 罹患率

## 除外基準 (Exclusion Criteria)

1. **他のサプリメントとの併用研究**（カルシウム単独でない場合）
2. **吸収障害のある参加者**を対象とした研究
3. **2ヶ月未満**の短期研究
4. **RCT以外**の研究デザイン

## 採用研究の特徴

採用されたレビューから：
- **採用研究数**: 18研究
- **総参加者数**: 1,873名
- **介入方法**: 経口カルシウム錠剤
- **投与量**: 0.162g〜1.5g/日
- **実施国**: 主にアメリカとイラン
- **研究期間**: 大半が6ヶ月未満
- **参加者**: 女性が中心

## 主な結論 (Cochrane Review)

- カルシウム補充は体重変化にほとんど影響なし（MD -0.15 kg）
- BMI（MD -0.18 kg/m²）と腹囲（MD -0.51 cm）に小さな減少あり（中程度のエビデンス）
- 体脂肪量にも小さな減少（MD -0.34 kg）
- 有害事象は低頻度

## データセット用途

- 機械学習によるシステマティックレビュー自動化
- Title & Abstract スクリーニングの評価
- 栄養介入研究のスクリーニングベンチマーク

## 出典

- [Cochrane Library](https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD012268.pub2/full)
- [Mendeley Dataset](https://data.mendeley.com/)

---
*最終更新: 2025-12-31*
