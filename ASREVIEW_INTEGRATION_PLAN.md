# ASReview（Active Learning）統合計画（TiAb Review Plugin）

更新日: 2025-12-29

このドキュメントは、TiAb Review Plugin（Google Sheets をDBにした TiAb スクリーニング拡張）へ **ASReview（asreview/asreview）相当の “Active Learning による動的スクリーニング”** を新規機能として追加するための実装計画です。  
最終的に、TypeScript 側で Python 版と同等の機械学習パイプライン（少なくとも1モデル）を実装し、**ASReview のサンプルデータに対して予測確率が一致すること**（検証スクリプトで再現可能）までを目標にします。

---

## 0. ゴール / 非ゴール

### ゴール（やること）

- 拡張機能内（TypeScript）で、**ラベル（include/exclude）に応じてモデル学習→未判定文献の関連度（予測確率）を更新**し、次に読むべき文献を自動推薦できる。
- ASReview の設計に合わせて、以下のコンポーネント構造を TypeScript で再現する（最小構成）:
  - Feature extractor（TF-IDF）
  - Classifier（まずは確率が出せるもの）
  - Balancer（重み付け）
  - Querier（max などのクエリ戦略）
  - Active learning cycle（fit → rank）
- **ASReview のリポジトリをクローンして参照実装として利用**し、ASReview 側のデモデータで **TS 実装と予測確率が一致**することを機械的に確認できる（`npm run ...` で再現）。

### 非ゴール（今回やらない）

- ASReview LAB の Web UI の移植
- ASReview の **simulation / validation**（停止曲線、性能指標、シミュレーションCLI等）を拡張機能に実装
- 多言語 embedding（`multilingual-e5-large` 等）や heavy model（外部モデルDLが必要になるもの）
- “完全自動” で Sheets の人間判定を置き換える運用

---

## 1. 前提・制約（Chrome Extension / 現行実装）

- 主要UIは Side Panel（`src/sidepanel/*`）。
- データは Google Sheets（References/Decisions/Config）。
- 判定保存は `ref_id + reviewer_id` の行を update/append（既存仕様）。
- 文献数 3,000 件程度でも快適に動く必要があるため、ML 処理は **UI スレッドで重い処理をしない**（Web Worker 前提）。

---

## 2. まず合わせる “ASReview 互換” の対象範囲（最小互換面）

ASReview の `ActiveLearningCycle` のうち、拡張機能に必要な箇所だけを TS で再現する。

- 入力: 文献（title + abstract）とラベル（include=1 / exclude=0 / unlabeled=-1）
- 出力:
  - 各文献の関連度スコア（まずは `predict_proba(:,1)` を “予測確率” と呼ぶ）
  - 未判定文献の推奨順序（querier=`max` で降順）

### MVP で固定する “基準モデル”（検証対象）

**確率一致の検証を最優先**し、まずは ASReview の既存設定に存在し、かつ `predict_proba` が素直に比較できる構成を選ぶ。

- 参照: `asreview/models/models.py` の `elas_u3`
  - querier: `max`
  - classifier: `nb`（`MultinomialNB`）+ `alpha=3.822`
  - balancer: `balanced` + `ratio=1.2`
  - feature_extractor: `tfidf` + `stop_words="english"`

この “elas_u3 相当” を TS で再現し、ASReview のデモデータで確率一致を最初の到達点にする。  
（将来 `elas_u4` 相当（SVM+TFIDF）へ拡張する場合は、SVM の確率化/スコア扱いを別途設計する）

---

## 3. TypeScript 側 ML 実装方針（設計）

### 3.1 モジュール構成（案）

拡張機能本体に組み込める “小さな ASReview コア” を `src/lib/asreview/*` として作る。

- `src/lib/asreview/types.ts`
  - `Label = 1 | 0 | -1`
  - `ActiveLearningConfig`（querier/classifier/feature_extractor/balancer の設定）
  - `ModelState`（vocabulary, idf, class_log_prior, feature_log_prob…）
- `src/lib/asreview/text.ts`
  - `mergeTitleAbstract(ref): string`
  - `tokenizeSklearnLike(text, tokenPattern, lowercase, stopWords, ngramRange)`
- `src/lib/asreview/tfidf.ts`
  - `fitTfidf(texts, params) -> {vocabulary, idf, docVectors}`
  - scikit-learn 互換の TF-IDF（`sublinear_tf`, `smooth_idf`, `norm="l2"`, `min_df`, `max_df`, `ngram_range`）
- `src/lib/asreview/nb.ts`
  - `fitMultinomialNB(X, y, sampleWeight?, alpha) -> {class_log_prior, feature_log_prob}`
  - `predictProbaMultinomialNB(X, state) -> Float64Array`
- `src/lib/asreview/balanced.ts`
  - ASReview の `Balanced.compute_sample_weight` 相当
- `src/lib/asreview/queriers.ts`
  - `max(p): number[]`（降順インデックス）
  - 将来 `uncertainty`, `random` 等も追加可能（まずは `max` のみ）
- `src/lib/asreview/cycle.ts`
  - `fitAndRank(refs, labels, config) -> {proba, ranking, state}`

### 3.2 実行形態（Worker）

- Side Panel から Web Worker を起動して ML 計算を隔離する。
- Worker は以下を受け取って返す:
  - 入力: `refs[]`（title/abstract）, `labelsByRefId`, `config`
  - 出力: `probaByRefId`, `rankedRefIds`, `debugStateHash`

### 3.3 データの扱い（Sheets との整合）

- 学習ラベルは基本 **自分の判定**（`reviewer_id = chrome.identity.getProfileUserInfo().email`）のみを使用（MVP）。
  - include → `1`
  - exclude → `0`
  - maybe → 原則 `-1`（未学習）として扱う（必要なら後で設定で変更可能）
- 予測確率は Sheets に保存しない（まずはローカル表示のみ）。  
  ※ “保存するなら note に JSON” などの方針は後段で検討。

---

## 4. UI/UX（スクリーニング画面への統合）

### 4.1 追加する UI（最小）

- スクリーニング画面に “ML 推薦” トグル
  - ON: 未判定リストを `p(relevant)` 降順で提示（次へも推薦順）
  - OFF: 現行どおり（固定順/検索/フィルタ）
- 文献カードに `p(relevant)` を表示（例: `0.732`）
- “学習状態” の表示（例: `Labeled: include=12 / exclude=30`）
- “モデルをリセット” ボタン（ローカル状態を消して再学習）

### 4.2 更新タイミング

- 判定（include/exclude）を保存したら Worker に通知し、モデル更新→推薦順更新。
- 連打で重くならないように debounce（例: 300ms）＋最新のみ適用。

---

## 5. 確率一致の検証（ASReview クローン + サンプルデータ）

### 5.1 目的

「ASReview の実装（Python）と、拡張機能内の TS 実装が同じ入力に対して同じ予測確率を返す」ことを、機械的に再現・検証できる状態にする。

### 5.2 検証データ（ASReview 側のデモデータを流用）

ASReview リポジトリ内の以下を利用（ライセンス/同梱可否は要確認）:

- `tests/demo_data/generic.csv`（title/abstract を含む）
- `tests/demo_data/generic_labels.csv`（`label_included` を含む）

### 5.3 Baseline（Python）生成スクリプト（案）

- `scripts/asreview-baseline/` を作成し、以下を出力する:
  - 入力: 上記 CSV
  - 参照実装: ASReview の `elas_u3` 相当（TF-IDF + MultinomialNB + Balanced）
  - 出力: `baseline.json`
    - 学習に使用したパラメータ
    - 文献順序（ID または行 index）
    - `proba_included[]`（`predict_proba[:,1]`）
    - 可能なら `vocabulary` / `idf` / `class_log_prior` / `feature_log_prob` も保存（デバッグ容易化）

### 5.4 TS 側の検証スクリプト（案）

- `scripts/asreview-verify/` を作成し、TS 実装で同じ入力から `proba_included[]` を生成して比較する。
- 期待値:
  - 原則 “完全一致” を目標（少なくとも `Float64` で計算・同じ数式なら一致しやすい）
  - 実際に差が出る場合は、誤差許容を決める（例: `absDiff <= 1e-12`）  
    ※ ただし「許容誤差で逃げる」のではなく、まずは tokenization / idf / 正規化 / NB の式を Python に厳密に合わせる。

### 5.5 実行コマンド（案）

- `npm run ml:verify`
  - Python 側 baseline 生成
  - TS 側計算
  - diff 判定（失敗時は mismatch の上位N件を表示）

---

## 6. 実装ステップ（ロードマップ）

### Phase 1: 参照実装の固定（再現性の確保）

1. ASReview を `vendor/asreview` として取り込む方針決め（submodule / subtree / “開発時のみ clone”）。
2. 検証対象の ASReview バージョンを pin（commit hash）して、以後の比較基準を固定する。
3. `generic.csv` / `generic_labels.csv` の同梱可否（ライセンス）を確認し、不可なら同等の公開データセットを用意する。

### Phase 2: TS で “elas_u3 相当” の ML コア実装

1. `token_pattern` / `stop_words="english"` / `ngram_range` 等、scikit-learn 互換の tokenization を TS で実装。
2. TF-IDF（`TfidfVectorizer` 相当）を TS で実装（min_df/max_df/sublinear_tf/norm/smooth_idf を含む）。
3. MultinomialNB を TS で実装（`alpha`、`predict_proba`、`sample_weight` 対応）。
4. Balanced sample weight（ASReview の式）を TS で実装。
5. Querier=`max` を実装し、`fit → proba → ranking` が動く状態にする。

### Phase 3: 拡張機能 UI に統合

1. Side Panel に “ML 推薦” トグルと `p(relevant)` 表示を追加。
2. 判定（include/exclude）保存後に Worker へ通知→推薦更新。
3. キャッシュ（ローカル）を導入して 3,000 件で快適に動くことを確認（最初は計測→必要なら最適化）。

### Phase 4: 確率一致の検証を完了（ゴール）

1. Python baseline 出力と TS 出力が一致するまで差分を潰す（tokenization / idf / norm / NB）。
2. `npm run ml:verify` を安定化（再現可能・一発で比較できる）。
3. 既知の落とし穴（Unicode 正規化、空文字、欠損、改行、CSV quoting）をテストケース化する（最小限）。

---

## 7. リスクと対策

- **scikit-learn 互換 TF-IDF の厳密再現が難しい**  
  → まずは ASReview が実際に使っているパラメータ（`elas_u3`）だけに範囲を絞る。差分は baseline の `vocabulary/idf` を吐かせて追う。
- **ブラウザ内での性能（TF-IDF の fit が重い）**  
  → Web Worker、疎行列、キャッシュ（IndexedDB）で回避。学習は “ラベル更新時のみ” に限定。
- **ライセンス**  
  → ASReview は Apache-2.0。コード/データ同梱時は NOTICE 等を含める。サンプルデータの再配布可否を個別確認する。

