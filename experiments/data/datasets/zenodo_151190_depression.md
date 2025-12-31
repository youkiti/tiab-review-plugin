# Depression Dataset (zenodo_151190)

## 概要

| 項目 | 内容 |
|------|------|
| **レビュータイトル** | Understanding in vivo Models of Depression: A Systematic Review |
| **DOI** | [10.5281/zenodo.151190](https://zenodo.org/records/151190) |
| **検索日** | 2016年5月 |
| **データベース** | 2つのオンラインデータベース |
| **検索結果** | 70,365件のユニーク論文 |
| **スクリーニング済み** | 5,749件 |
| **スクリーニング方法** | 2名の独立レビュアー + 3人目が調停 |

## ローカルファイル

- **パス**: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- **形式**: JSON配列
- **フィールド**: `id`, `title`, `abstract`, `label_included` (0=除外, 1=組み入れ)

## 組み入れ基準 (Inclusion Criteria)

**「うつ病の動物モデル (in vivo models of depression)」に関する研究**

以下の条件を満たす論文:
1. **動物実験** (in vivo) であること
2. **うつ病モデル**を使用または報告していること

### 組み入れ例
- Forced Swim Test (強制水泳試験)
- Tail Suspension Test (尾懸垂試験)  
- Chronic Mild Stress model (慢性軽度ストレスモデル)
- Olfactory Bulbectomy (嗅球摘出モデル)
- 抗うつ薬の動物実験

## 除外基準 (Exclusion Criteria)

以下に該当する論文:
1. **ヒト研究** (human studies)
2. **「depression」が別の意味で使用されている論文**:
   - 呼吸抑制 (respiratory depression)
   - 心機能抑制 (cardiac depression)  
   - 皮質拡延性抑制 (cortical spreading depression)
   - 近交弱勢 (inbreeding depression)
   - Long-term depression (LTD, シナプス可塑性)
3. うつ病の動物モデルと無関係な研究

## データセット用途

- 機械学習によるシステマティックレビュー自動化
- Text-miningアプローチの開発・評価
- Title & Abstract スクリーニングの自動化

## キーワード (Zenodo)

- in vivo modelling
- text-mining
- machine learning
- depression
- systematic review

## 備考

このデータセットは、機械学習アルゴリズムのトレーニング用に設計されており、
手動スクリーニングの結果を教師データとして使用できます。

---
*最終更新: 2025-12-31*
