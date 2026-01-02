# ASReview（Active Learning）統合計画（TiAb Review Plugin）

更新日: 2025-12-29（調査完了版）

このドキュメントは、TiAb Review Plugin（Google Sheets をDBにした TiAb スクリーニング拡張）へ **ASReview（asreview/asreview）相当の "Active Learning による動的スクリーニング"** を新規機能として追加するための実装計画です。
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
- "完全自動" で Sheets の人間判定を置き換える運用

---

## 1. 前提・制約（Chrome Extension / 現行実装）

- 主要UIは Side Panel（`src/sidepanel/*`）。
- データは Google Sheets（References/Decisions/Config）。
- 判定保存は `ref_id + reviewer_id` の行を update/append（既存仕様）。
- 文献数 3,000 件程度でも快適に動く必要があるため、ML 処理は **UI スレッドで重い処理をしない**（Web Worker 前提）。

---

## 2. まず合わせる "ASReview 互換" の対象範囲（最小互換面）

ASReview の `ActiveLearningCycle` のうち、拡張機能に必要な箇所だけを TS で再現する。

- 入力: 文献（title + abstract）とラベル（include=1 / exclude=0 / unlabeled=-1）
- 出力:
  - 各文献の関連度スコア（まずは `predict_proba(:,1)` を "予測確率" と呼ぶ）
  - 未判定文献の推奨順序（querier=`max` で降順）

### MVP で固定する "基準モデル"（検証対象）✅ 調査完了

**確率一致の検証を最優先**し、まずは ASReview の既存設定に存在し、かつ `predict_proba` が素直に比較できる構成を選ぶ。

- 参照: `vendor/asreview/asreview/models/models.py` の `elas_u3` (L45-57)

| コンポーネント              | 設定                   | 確定パラメータ                    |
| --------------------------- | ---------------------- | --------------------------------- |
| **Querier**           | `max`                | `np.argsort(-p)` で降順         |
| **Classifier**        | `nb` (MultinomialNB) | `alpha=3.822`                   |
| **Balancer**          | `balanced`           | `ratio=1.2`                     |
| **Feature Extractor** | `tfidf`              | `stop_words="english"` のみ指定 |

#### TF-IDF デフォルトパラメータ（確定）

| パラメータ              | 値                        | 説明                            |
| ----------------------- | ------------------------- | ------------------------------- |
| `columns`             | `["title", "abstract"]` | 結合するカラム                  |
| `lowercase`           | `True`                  | 小文字化                        |
| `token_pattern`       | `r"(?u)\b\w\w+\b"`      | scikit-learn 標準パターン       |
| `ngram_range`         | `(1, 1)`                | unigram のみ                    |
| `max_df` / `min_df` | `1.0` / `1`           | 上限なし / 1回以上出現          |
| `norm`                | `"l2"`                  | L2正規化                        |
| `smooth_idf`          | `True`                  | `idf = log((1+n)/(1+df)) + 1` |
| `sublinear_tf`        | `False`                 | tf そのまま使用                 |

#### Balanced サンプル重み計算式（確定）

- class 1 (include): 重み = `1.0`
- class 0 (exclude): 重み = `n_include / (ratio * n_exclude)`
- 正規化: `weights * (len(y) / sum(weights))`

この "elas_u3 相当" を TS で再現し、検証データで確率一致を最初の到達点にする。
（将来 `elas_u4` 相当（SVM+TFIDF）へ拡張する場合は、SVM の確率化/スコア扱いを別途設計する）

---

## 3. TypeScript 側 ML 実装方針（設計）

### 3.1 モジュール構成（案）

拡張機能本体に組み込める "小さな ASReview コア" を `src/lib/asreview/*` として作る。

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
  ※ "保存するなら note に JSON" などの方針は後段で検討。

---

## 4. UI/UX（スクリーニング画面への統合）

### 4.1 追加する UI（最小）

- スクリーニング画面に "ML 推薦" トグル
  - ON: 未判定リストを `p(relevant)` 降順で提示（次へも推薦順）
  - OFF: 現行どおり（固定順/検索/フィルタ）
- 文献カードに `p(relevant)` を表示（例: `0.732`）
- "学習状態" の表示（例: `Labeled: include=12 / exclude=30`）
- "モデルをリセット" ボタン（ローカル状態を消して再学習）

### 4.2 更新タイミング

- 判定（include/exclude）を保存したら Worker に通知し、モデル更新→推薦順更新。
- 連打で重くならないように debounce（例: 300ms）＋最新のみ適用。

---

## 5. 確率一致の検証（ASReview クローン + サンプルデータ）

### 5.1 目的

「ASReview の実装（Python）と、拡張機能内の TS 実装が同じ入力に対して同じ予測確率を返す」ことを、機械的に再現・検証できる状態にする。

### 5.2 検証データ ✅ 確定

#### 採用データセット: LLM Citation Screening Data (CQ1-5)

リポジトリ `seveneleven711thanks39/llm-assisted_citation_screening` のデータを使用する。
SYNERGYデータセットの問題（ラベル競合・ID重複）を回避し、現実的なスクリーニング課題（Critical Care領域）を提供する。

**構成:**

| Dataset       | Total | Included | Prevalence | 特徴                               |
| ------------- | ----- | -------- | ---------- | ---------------------------------- |
| **CQ1** | 5,628 | 113      | 2.0%       | **メイン検証用**（最大規模） |
| CQ2           | 3,400 | 17       | 0.5%       | 不均衡データ検証用                 |
| CQ3           | 1,038 | 16       | 1.5%       | 小規模データ検証用                 |
| CQ4           | 4,326 | 72       | 1.7%       | サブ検証用                         |
| CQ5           | 2,253 | 41       | 1.8%       | サブ検証用                         |

**準備手順（スクリプト化済み `scripts/asreview-baseline/generate_datasets.py`）:**

1. `Data/CQ*_data.xlsx` からタイトル・抄録を読み込む（Rayyan形式）。
2. `Data/Reference_standard_data.xlsx` から「採用文献タイトルリスト」を読み込む。
3. タイトルの正規化・ファジーマッチングを行い、一致する文献を `label=1`、それ以外を `0` とする。
4. `scripts/asreview-baseline/datasets/cq{n}_labeled.json` として保存。

#### 追加採用データセット（ユーザー要望）

以下のオープンデータセットも検証用として取得・整備する。

| Dataset                     | URL                                                                 | Description                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depression (SLIM)** | [Zenodo 151190](https://zenodo.org/records/151190)                     | うつ病（動物モデル）SR。2名独立評価+reconcile。`scripts/asreview-baseline/datasets/depression_slim_labeled.json` を作成済み（`label_included`）。元データは `scripts/asreview-baseline/datasets/zenodo_151190/`。                                                                      |
| **Wilson's Disease**  | [Zenodo 3625931](https://zenodo.org/records/3625931)                   | Wilson病治療SR。TiAb全件を基準に2種ラベル保持:`label_tiab`（FT対象=1）/ `label_final_included`（最終included=1）。`scripts/asreview-baseline/datasets/wilson_tiab_labeled.json` を作成済み。元データは `scripts/asreview-baseline/datasets/zenodo_3625931/`。                        |
| **Mendeley Data**     | [Mendeley 7sgmg89zb6](https://data.mendeley.com/datasets/7sgmg89zb6/1) | Title/Absスクリーニング用大規模データ。`scripts/asreview-baseline/datasets/mendeley_20240827_*_set.json` と `scripts/asreview-baseline/datasets/mendeley_CD*_data_cleaned.json` を作成済み。mainセットは `label_score` を保持し、`label_included` は `label_score >= 0.5` を許容。 |

#### 他のデータセット（experiments/ で確認済み）

- **Depression (SLIM)**: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- **Wilson's Disease**: `scripts/asreview-baseline/datasets/wilson_tiab_labeled.json`
- **Mendeley Cochrane 系**: `scripts/asreview-baseline/datasets/mendeley_CD*_data_cleaned.json`
- **Mendeley 追加セット**: `scripts/asreview-baseline/datasets/mendeley_20240827_{dev,val,random_test,heart_test,HIV_test}_set.json`

#### 追加データの詳細（experiments/ の整理内容）

- **CQデータ合計**: 16,645件（採用259件）
  - 根拠: `experiments/data/datasets/cq_datasets.md`
  - 生データ: `scripts/asreview-baseline/raw_data/CQ1_data.xlsx` 〜 `CQ5_data.xlsx`
- **Depression (zenodo_151190)**: スクリーニング済み5,749件の一部をラベル化して利用
  - 形式: JSON配列（`id`, `title`, `abstract`, `label_included`）
  - 詳細: `experiments/data/datasets/zenodo_151190_depression.md`
- **Wilson (zenodo_3625931)**: TiAb 3,453件 / 最終採用26件
  - 元データはRIS形式（パース + ラベル突合が必要）
  - 詳細: `experiments/data/datasets/zenodo_3625931_wilson.md`
- **Mendeley Cochrane**: CD011218 〜 CD015432 の複数セット（最大: CD014715 = 89.3MB）
  - 追加セット: dev 810MB / val 46.7MB / random_test 46.7MB / heart_test 36.1MB / HIV_test 7.8MB
  - 詳細: `experiments/data/datasets/mendeley_cochrane_overview.md`

#### 拡張性（他のデータセット追加）

PubMed検索結果やユーザー独自データ（RIS/CSV）など、他のデータセットを検証に追加したい場合は、上記 `cq*_labeled.json` と同じ JSON スキーマ（`id`, `title`, `abstract`, `label_included`）を持つファイルを作成し、`scripts/asreview-baseline/datasets/` に配置することで、検証パイプラインに追加可能とする。必要に応じて `label_score`（連続値）や `label_tiab` / `label_final_included` のような追加ラベルも併存可。

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
  - 原則 "完全一致" を目標（少なくとも `Float64` で計算・同じ数式なら一致しやすい）
  - 実際に差が出る場合は、誤差許容を決める（例: `absDiff <= 1e-12`）
    ※ ただし「許容誤差で逃げる」のではなく、まずは tokenization / idf / 正規化 / NB の式を Python に厳密に合わせる。

### 5.5 実行コマンド（案）

- `npm run ml:verify`
  - Python 側 baseline 生成
  - TS 側計算
  - diff 判定（失敗時は mismatch の上位N件を表示）

---

## 6. 実装ステップ（ロードマップ）

### Phase 1: 参照実装の固定（再現性の確保）✅ 完了

1. ✅ ASReview を `vendor/asreview` として取り込み（clone --depth 1）
2. ⬜ 検証対象の ASReview バージョンを pin（commit hash）して、以後の比較基準を固定する。
3. ⚠️ `generic.csv` / `generic_labels.csv` は不十分。代替データセットを用意する。

### Phase 2: TS で "elas_u3 相当" の ML コア実装 ✅ 完了

1. `token_pattern` / `stop_words="english"` / `ngram_range` 等、scikit-learn 互換の tokenization を TS で実装。
2. TF-IDF（`TfidfVectorizer` 相当）を TS で実装（min_df/max_df/sublinear_tf/norm/smooth_idf を含む）。
3. MultinomialNB を TS で実装（`alpha`、`predict_proba`、`sample_weight` 対応）。
4. Balanced sample weight（ASReview の式）を TS で実装。
5. Querier=`max` を実装し、`fit → proba → ranking` が動く状態にする。

完了レポート: `experiments/asreview/REPORT.md`

### Phase 3: 拡張機能 UI に統合（ML タブ） ✅ 完了

**目的**: ML アシストスクリーニングを Side Panel に組み込み、ASReview 同様の「連続 N 件 exclude で停止推奨」を実装する。

#### 3.0 ASReview 調査結果（設計根拠）

ASReview LAB の実装を調査し、以下の設計方針を採用：

1. **停止基準**: 「連続 N 件 exclude（N Consecutive Irrelevant）」のみをメインで使用（デフォルトは100件）
2. **確率非表示**: レビュー中は `p(relevant)` を表示しない（バイアス防止）
3. **進捗可視化**: 停止基準に対する進捗バー（include でリセット）
4. **停止到達時ダイアログ**: 「追加レビュー」「終了」「閉じる」の選択肢

参照ファイル:

- `vendor/asreview/asreview/models/stoppers.py`
- `vendor/asreview/asreview/webapp/src/ProjectComponents/AnalyticsComponents/StoppingSuggestion.js`
- `vendor/asreview/asreview/webapp/src/ProjectComponents/ReviewComponents/StoppingReachedDialog.js`

#### 3.1 UI/UX 設計

**ML タブ全体レイアウト:**

```
┌─────────────────────────────────────────────────────┐
│ TiAb Review                                         │
│ [👤 手動] [🔬 ML] [🤖 AI]        進捗: 45 / 1,234   │
├─────────────────────────────────────────────────────┤
│ ← 戻る                                   ⚙️ ❓      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ 🎯 ML アシストスクリーニング                   │   │
│  │                                             │   │
│  │ 学習状態: include 23件 / exclude 156件       │   │
│  │                                             │   │
│  │ ───────── 停止基準 ─────────                │   │
│  │ [Set Threshold]  または [▼ 連続 exclude 50件] │   │
│  │                                             │   │
│  │ 進捗: ████████░░░░ 32 / 50                  │   │
│  │       (include で リセット)                  │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Title: Effect of...                         │   │
│  │ Authors: Smith J, et al. (2023)             │   │
│  │                                             │   │
│  │ Abstract: ...                               │   │
│  │                                             │   │
│  │ [DOI] [PubMed]                              │   │
│  ├─────────────────────────────────────────────┤   │
│  │ [✓ Include (i)]   [✕ Exclude (e)]           │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**停止基準設定ポップアップ:**

```
┌────────────────────────────────────┐
│ [カスタム] [パーセンテージ]         │  ← タブ切り替え
├────────────────────────────────────┤
│ データセットの割合を選択:           │
│ [1%] [2%] [5%] [10%]              │
│   50   100  250   500              │  ← 件数表示
│ [保存]                             │
└────────────────────────────────────┘
```

**停止到達時ダイアログ:**

```
┌───────────────────────────────────────────────┐
│ 停止基準に到達しました                          │
│ 次のアクションを選択してください                  │
├───────────────────────────────────────────────┤
│ 📄 20件追加でレビュー                          │
│    閾値を +20 して続行                         │
│                                               │
│ 📥 終了してエクスポート                         │
│    結果をエクスポート                           │
├───────────────────────────────────────────────┤
│ [閉じる]                        [終了]          │
└───────────────────────────────────────────────┘
```

#### 3.2 停止基準（Stopping Rule）

ASReview の `NConsecutiveIrrelevant` を TS で実装:

```typescript
interface StoppingRule {
  type: 'n_consecutive_irrelevant';
  threshold: number;  // 例: 50
  current: number;    // 連続 exclude カウント
}

function updateStoppingProgress(rule: StoppingRule, decision: 'include' | 'exclude'): StoppingRule {
  if (decision === 'include') {
    return { ...rule, current: 0 };  // リセット
  } else {
    return { ...rule, current: rule.current + 1 };
  }
}

function isStoppingReached(rule: StoppingRule): boolean {
  return rule.current >= rule.threshold;
}
```

#### 3.3 状態管理と永続化

`src/sidepanel/state.ts` に追加:

```typescript
interface MlState {
  status: 'idle' | 'training' | 'ready' | 'error';
  labeledCount: { include: number; exclude: number };
  stoppingRule: StoppingRule | null;
  ranking: string[];  // ref_id の配列（推薦順）
  lastUpdated: number;
}
```

永続化（`chrome.storage.local`）:

- `ml_stopping_rule_{spreadsheetId}`: 停止基準設定
- `ml_state_{spreadsheetId}`: 学習状態（ラベル数、進捗）

#### 3.4 Worker 連携

`src/lib/ml/worker.ts`:

```typescript
// メッセージ仕様
type WorkerMessage =
  | { type: 'init'; refs: RefRecord[]; labels: Map<string, Label> }
  | { type: 'updateLabel'; refId: string; label: Label }
  | { type: 'reset' };

type WorkerResponse =
  | { type: 'ready'; ranking: string[]; stats: LabelStats }
  | { type: 'updated'; ranking: string[]; stats: LabelStats }
  | { type: 'error'; message: string };
```

更新フロー:

1. ユーザーが判定を保存 → Sheets に書き込み
2. `debounce(300ms)` 後に Worker へ `updateLabel` 送信
3. Worker: NB 再学習 → ranking 再計算 → 結果返却
4. UI: ranking 更新 + 停止進捗更新

#### 3.5 ファイル構成

```
src/
├── lib/
│   └── ml/
│       ├── worker.ts          # Web Worker 本体
│       ├── worker-client.ts   # UI → Worker 通信ラッパー
│       ├── types.ts           # ML 関連型定義
│       └── stopping-rules.ts  # 停止基準ロジック
├── sidepanel/
│   ├── features/
│   │   └── ml/
│   │       ├── render.ts      # ML タブ描画
│   │       ├── actions.ts     # 判定アクション
│   │       ├── stopping.ts    # 停止基準 UI
│   │       └── dialogs.ts     # ダイアログ
│   └── state.ts               # mlState 追加
└── sidepanel.html             # ml-section 追加
```

#### 3.6 性能目標（ベンチマーク結果に基づく）

| 処理                | 目標    | ベンチマーク結果           |
| ------------------- | ------- | -------------------------- |
| 初回学習（3,000件） | 5秒以内 | CQ2 (3,400件): 1.4秒 ✅    |
| ラベル更新後再計算  | 1秒以内 | NB再学習のみ: 200-500ms ✅ |

TF-IDF のキャッシュにより、ラベル更新時は NB 再学習のみで対応可能。

#### 3.7 完了条件（受け入れ条件）

1. ML タブで文献が推薦順に表示される
2. include/exclude の保存後に推薦順が更新される（1秒以内）
3. 停止基準を設定でき、進捗バーが正しく更新される
4. include でカウンターがリセットされる
5. 停止到達時にダイアログが表示され、選択肢が機能する
6. Worker エラー時は UI が落ちず、エラー表示して手動モードに戻る
7. 3,000件規模でスクロール/次へ/前へが快適に動く

### Phase 4: 確率一致の検証を完了（ゴール）

1. Python baseline 出力と TS 出力が一致するまで差分を潰す（tokenization / idf / norm / NB）。
2. `npm run ml:verify` を安定化（再現可能・一発で比較できる）。
3. 既知の落とし穴（Unicode 正規化、空文字、欠損、改行、CSV quoting）をテストケース化する（最小限）。

---

## 7. リスクと対策

- **scikit-learn 互換 TF-IDF の厳密再現が難しい**→ まずは ASReview が実際に使っているパラメータ（`elas_u3`）だけに範囲を絞る。差分は baseline の `vocabulary/idf` を吐かせて追う。
- **ブラウザ内での性能（TF-IDF の fit が重い）**→ Web Worker、疎行列、キャッシュ（IndexedDB）で回避。学習は "ラベル更新時のみ" に限定。
- **ライセンス**
  → ASReview は Apache-2.0。コード/データ同梱時は NOTICE 等を含める。サンプルデータの再配布可否を個別確認する。

---

## Appendix: 調査結果の詳細

詳細な調査結果は以下を参照:

- 調査レポート: `.gemini/antigravity/brain/*/asreview_investigation_report.md`
- 参照実装: `vendor/asreview/`
