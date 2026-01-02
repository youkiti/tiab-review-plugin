# experiments/asreview

ASReview の `elas_u3`（TF-IDF + MultinomialNB + Balanced + max querier）相当を TypeScript で再現するための実験用実装です。

## 目的

- `cq3` と `depression` を使って TS 実装の `predict_proba` を検証する
- Python 実装の出力と一致するかを比較する

## 実行例

```bash
npx ts-node --project experiments/asreview/tsconfig.json experiments/asreview/src/index.ts --dataset cq3
```

## データセット

`experiments/asreview/src/index.ts` で `cq3` または `depression` を指定します。
実体は `scripts/asreview-baseline/datasets/` 以下の JSON です。

## 出力

`experiments/asreview/outputs/` に JSON を出力します。

- `proba_included`: 各レコードの `P(y=1)`
- `ranking`: 確率降順のインデックス配列
- `debug_state`: `vocabulary` や `idf` などの再現性確認用情報

## メモ

- 参照実装は `vendor/asreview/asreview/models/feature_extractors.py` と `vendor/asreview/asreview/models/classifiers.py` にあります。
- まずは `elas_u3` 固定のパラメータに合わせています。
