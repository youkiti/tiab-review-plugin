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

---

## Phase 3 性能ベンチマーク結果（2026-01-02）

### 目的

Phase 3 の性能目標（初回学習 5秒 / 再計算 1秒）の妥当性を検証するため、TS 実装の fit/rank 処理時間を計測。

### 実行環境

- Node.js: ts-node (experiments/asreview/benchmark.ts)
- CPU: ローカル開発環境

### 結果サマリー

| Dataset    | Records | Total (ms) | TF-IDF (ms) | NB fit (ms) | NB predict (ms) |
|------------|---------|------------|-------------|-------------|-----------------|
| **cq1**    | 5,628   | 3,004      | 2,361 (79%) | 204         | 435             |
| cq2        | 3,400   | 1,415      | 1,058 (75%) | 109         | 246             |
| cq3        | 1,038   | 294        | 230 (78%)   | 24          | 40              |
| **cq4**    | 4,326   | 1,734      | 1,305 (75%) | 138         | 287             |
| cq5        | 2,253   | 975        | 739 (76%)   | 68          | 165             |
| depression | 1,993   | 456        | 347 (76%)   | 44          | 63              |
| wilson     | 3,451   | 746        | 554 (74%)   | 68          | 121             |

### 分析

1. **TF-IDF が支配的**: 全処理時間の 74-79% を TF-IDF fit が占める
2. **スケーリング特性**: レコード数にほぼ線形（5,628件で約3秒）
3. **NB再学習の高速性**: NB fit は 1,000件あたり約40ms と高速

### 目標値の評価

| 目標 | 現状 | 評価 |
|------|------|------|
| 初回学習 5秒以内 | 3秒 (5,628件) | ✅ 達成可能 |
| ラベル更新後の再計算 1秒以内 | TF-IDF再構築なしなら 200-500ms | ✅ キャッシュ活用で達成可能 |

### 推奨事項

1. **TF-IDF のキャッシュ**: refs 変更時のみ再構築し、ラベル更新時は NB 再学習のみ実行
2. **目標値の確定**: 現行目標（初回5秒/再計算1秒）を維持
3. **3,000件を超える場合**: IndexedDB キャッシュで初回学習のレイテンシを軽減

