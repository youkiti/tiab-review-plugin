# CQ1 10-fold 実装一致検証レポート（TS vs Python）

## 概要

CQ1データセットに対して、10-fold internal validation を用い、各foldで同一の学習データを使った **TS実装とPython実装のランキング top100 ID一致率** を検証した。

## 検証対象

- データセット: `scripts/asreview-baseline/datasets/cq1_labeled.json`
- 分割方法: 層化10-fold（seed=42）
- 目的: TSとPythonの実装一致（ランキングのID一致率）

## 再現手順

### 1. fold生成

```bash
python experiments/asreview/make_folds.py --dataset cq1 --k 10 --seed 42
```

出力:
- `experiments/asreview/splits/cq1_k10_seed42.json`

### 2. TS側の10-fold実行

```bash
npx ts-node --project experiments/asreview/tsconfig.json experiments/asreview/src/cv.ts --dataset cq1
```

出力例:
- `experiments/asreview/outputs/asreview_ts_cv_cq1_2026-01-02T09-18-39-906Z.json`

### 3. Python側の10-fold実行

```bash
python experiments/asreview/cv_baseline.py --dataset cq1
```

出力例:
- `experiments/asreview/outputs/asreview_py_cv_cq1_2026-01-02T09-19-01-458682.json`

### 4. 一致率の比較

```bash
python experiments/asreview/compare_cv.py --dataset cq1
```

## 実装リンク

- TS 10-fold実装: `experiments/asreview/src/cv.ts`
- Python 10-fold実装: `experiments/asreview/cv_baseline.py`
- fold生成: `experiments/asreview/make_folds.py`
- 比較スクリプト: `experiments/asreview/compare_cv.py`

## 結果

実行結果（比較スクリプト出力）:

- 全foldで top100 ID一致率 = **1.0**
- summary:
  - mean = 1.0
  - min = 1.0
  - max = 1.0
  - perfect = 10

## 補足

- TS/Python の単発比較（確率とランキング一致）の手順は以下を参照:
  - `experiments/asreview/compare.py`
  - `experiments/asreview/baseline.py`
  - `experiments/asreview/src/index.ts`
