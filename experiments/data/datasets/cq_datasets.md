# CQ Datasets (Clinical Questions)

## 概要

CQ（Clinical Question）データセットは、臨床上の疑問に基づいたシステマティックレビューのタイトル・アブストラクトスクリーニングデータです。

## ローカルファイル

| CQ | ファイル名 | 総数 | 採用 | 除外 | 有病率 |
|----|-----------|------|------|------|--------|
| CQ1 | `cq1_labeled.json` | 5,628 | 113 | 5,515 | 2.01% |
| CQ2 | `cq2_labeled.json` | 3,400 | 17 | 3,383 | 0.50% |
| CQ3 | `cq3_labeled.json` | 1,038 | 16 | 1,022 | 1.54% |
| CQ4 | `cq4_labeled.json` | 4,326 | 72 | 4,254 | 1.66% |
| CQ5 | `cq5_labeled.json` | 2,253 | 41 | 2,212 | 1.82% |

**総計**: 16,645件（採用259件）

## データ形式

- **パス**: `scripts/asreview-baseline/datasets/`
- **形式**: JSON配列
- **フィールド**: 
  - `id`: 一意識別子
  - `title`: 論文タイトル
  - `abstract`: アブストラクト
  - `year`: 発行年
  - `journal`: ジャーナル名
  - `doi`: DOI
  - `pmid`: PubMed ID
  - `label_included`: ラベル (0=除外, 1=組み入れ)

## 生データ

Excelファイルとして保管:
- `scripts/asreview-baseline/raw_data/CQ1_data.xlsx`
- `scripts/asreview-baseline/raw_data/CQ2_data.xlsx`
- `scripts/asreview-baseline/raw_data/CQ3_data.xlsx`
- `scripts/asreview-baseline/raw_data/CQ4_data.xlsx`
- `scripts/asreview-baseline/raw_data/CQ5_data.xlsx`

## 特徴

- **低い採用率**: 0.5%〜2%の低い有病率（スクリーニングの困難さを反映）
- **臨床指向**: 各CQは特定の臨床疑問に対応
- **複数の研究領域**: CQ1〜CQ5で異なる臨床トピックをカバー

## データセット用途

- 機械学習モデルの評価ベンチマーク
- 低有病率環境でのスクリーニング自動化の評価
- Title & Abstract スクリーニングの精度測定

## 備考

CQデータセットは、日本の臨床ガイドライン作成に関連するシステマティックレビューから派生しています。
各CQの詳細な組み入れ・除外基準は個別のレビュープロトコルを参照してください。

---
*最終更新: 2025-12-31*
