# Mendeley Cochrane Datasets Overview

## 概要

Mendeley経由で取得したCochrane系統的レビューのスクリーニングデータセット一覧です。
各データセットは、Cochraneの異なるレビュートピックに対応しています。

## データセット一覧

| Cochrane ID | ファイル名 | サイズ | 説明 |
|-------------|-----------|--------|------|
| CD011218 | `mendeley_CD011218_data_cleaned.json` | 1.3 MB | |
| **CD012268** | `mendeley_CD012268_data_cleaned.json` | 9.8 MB | **Calcium supplementation for obesity** |
| CD013042 | `mendeley_CD013042_data_cleaned.json` | 2.1 MB | |
| CD013059 | `mendeley_CD013059_data_cleaned.json` | 11.1 MB | |
| CD013071 | `mendeley_CD013071_data_cleaned.json` | 17.6 MB | |
| CD013197 | `mendeley_CD013197_data_cleaned.json` | 5.3 MB | |
| CD013199 | `mendeley_CD013199_data_cleaned.json` | 3.3 MB | |
| CD013295 | `mendeley_CD013295_data_cleaned.json` | 6.4 MB | |
| CD013358 | `mendeley_CD013358_data_cleaned.json` | 7.7 MB | |
| CD013377 | `mendeley_CD013377_data_cleaned.json` | 12.6 MB | |
| CD013421 | `mendeley_CD013421_data_cleaned.json` | 4.6 MB | |
| CD013590 | `mendeley_CD013590_data_cleaned.json` | 3.0 MB | |
| CD013591 | `mendeley_CD013591_data_cleaned.json` | 31.5 MB | |
| CD013822 | `mendeley_CD013822_data_cleaned.json` | 22.7 MB | |
| CD013880 | `mendeley_CD013880_data_cleaned.json` | 24.6 MB | |
| CD014715 | `mendeley_CD014715_data_cleaned.json` | 89.3 MB | 最大データセット |
| CD014736 | `mendeley_CD014736_data_cleaned.json` | 15.2 MB | |
| CD015038 | `mendeley_CD015038_data_cleaned.json` | 3.7 MB | |
| CD015042 | `mendeley_CD015042_data_cleaned.json` | 8.4 MB | |
| CD015067 | `mendeley_CD015067_data_cleaned.json` | 4.4 MB | |
| CD015306 | `mendeley_CD015306_data_cleaned.json` | 2.5 MB | |
| CD015432 | `mendeley_CD015432_data_cleaned.json` | 4.1 MB | |

## その他のMendeleyデータセット

| ファイル名 | サイズ | 説明 |
|-----------|--------|------|
| `mendeley_20240827_dev_set.json` | 810 MB | 開発セット（最大） |
| `mendeley_20240827_val_set.json` | 46.7 MB | 検証セット |
| `mendeley_20240827_random_test_set.json` | 46.7 MB | ランダムテストセット |
| `mendeley_20240827_heart_test_set.json` | 36.1 MB | 心疾患テストセット |
| `mendeley_20240827_HIV_test_set.json` | 7.8 MB | HIVテストセット |

## データ形式

- **パス**: `scripts/asreview-baseline/datasets/`
- **形式**: JSON配列
- **共通フィールド**: 
  - `id`: 一意識別子（形式: `Mendeley-<CD_ID>-<number>`）
  - `title`: 論文タイトル
  - `abstract`: アブストラクト
  - `label_included`: ラベル (0=除外, 1=組み入れ)

## Cochrane ID参照

各Cochrane IDは `CD` で始まり、以下のURLで元のレビューを参照できます：

```
https://doi.org/10.1002/14651858.<COCHRANE_ID>.pub2
```

例: [CD012268](https://doi.org/10.1002/14651858.CD012268.pub2)

## 出典

- [Mendeley Data Repository](https://data.mendeley.com/)
- [Cochrane Library](https://www.cochranelibrary.com/)

---
*最終更新: 2025-12-31*
