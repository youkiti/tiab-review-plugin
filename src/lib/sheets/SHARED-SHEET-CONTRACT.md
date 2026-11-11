# 他のアプリから読まれているシートの契約（契約 v1）

TiAb Review Plugin（以下 TiAb）が作るプロジェクトのスプレッドシートは、別リポジトリの Chrome 拡張 `youkiti/sr-data-extraction-plugin`（以下、抽出アプリ）から読まれている。抽出アプリは読み取りだけで、TiAb のシートには書かない。この文書は、抽出アプリが依存しているタブ・列・Config のキー・判定の規則と、TiAb 側でそれらを変えるときの決まりを定める。

列の定義の正本は `src/lib/sheets/schema.ts`。この文書の一覧は `tests/shared-sheet-contract.test.ts` が TiAb のコードと照合する。

## 1. 抽出アプリが読んでいるもの

抽出アプリの読み取りは `src/features/documents/tiabSheetReader.ts`、解釈は `src/features/documents/tiabReview.ts`（どちらも抽出アプリのリポジトリ）。

<!-- contract-dependencies:begin -->
```text
tabs = References, Decisions, Config, LLM_Runs, LLM_Executions
References = ref_id, title, year, authors, doi, pmid, fulltext_url, fulltext_set, related_ref_id, duplicate_of
Decisions = ref_id, reviewer_id, decision, decided_at, screening_phase, client_version
Config = fulltext_ai_active_round, fulltext_pool_rule, fulltext_assignment_status, key_opened
LLM_Runs = run_id, created_at, status, is_active
LLM_Executions = execution_id, execution_type, run_id
reserved_tabs = Meta, Documents, SchemaFields
```
<!-- contract-dependencies:end -->

- 列はヘッダー行（1行目）の名前で探し、知らない列は無視する。References の `ref_id`・`title`、Decisions の `ref_id`・`reviewer_id`・`decision` が無いと、抽出アプリは TiAb のシートではないとみなす
- `decision` は `include` / `exclude` / `maybe` / `pending` だけを読む
- References の `duplicate_of`、Config の `key_opened`、LLM_Runs と LLM_Executions は、抽出アプリの Issue youkiti/sr-data-extraction-plugin#480 で読み始める。LLM_Runs と LLM_Executions は AI を使っていないプロジェクトには無いので、抽出アプリはタブが無ければ「有効な AI 実行なし」として扱う
- `reserved_tabs` は抽出アプリのタブ名。抽出アプリは「References と Decisions があり、`reserved_tabs` が1つも無いシート」を TiAb のシートとみなす。TiAb はこの名前のタブを作らない

## 2. TiAb 側で変えるときの決まり

1. 1節の列とキーの名前を変えない・消さない
2. 列は末尾に足すだけにする（途中に挿入しない）
3. Config の1節のキーの値の形式と意味を変えない。`fulltext_assignment_status` は `none` / `configured`、`fulltext_pool_rule` は JSON `{version: 1, voters: string[], threshold: number}`、`fulltext_ai_active_round` は採用ラウンドの `reviewer_id`（`llm:` で始まる）、`key_opened` は小文字にして `true` なら開封（A 列が `key_opened` の最初の行を読む）
3b. LLM_Runs と LLM_Executions の1節の列の値の形式と意味を変えない。`is_active` は小文字にして `true` なら有効、`status` は `pending` とそれ以外（確定）、`created_at` は ISO 8601 の日時、`execution_type` の `batch_screening` は TiAb の一括判定、`run_id` は LLM_Runs と LLM_Executions で同じ値。TiAb の相の AI 判定の `reviewer_id` は、その実行の `execution_id` と同じ値
4. `decision` の値、`screening_phase` の値（`tiab` / `fulltext`、空は `tiab`）、`reviewer_id` の接頭辞（`llm:`・`adjudication:`）、`client_version` の末尾（`-human`・`-human-consensus`・`-human-adjudication`・`-ml`・`-ml-auto`・`-llm`）に値を足すときは、既存の値の意味を変えない
5. 3節の規則を変えるときは、PR の本文に「抽出アプリの `src/features/documents/tiabReview.ts` も直す必要がある」と書き、抽出アプリに Issue を立てる
6. 上の1〜4（3b を含む）を守れない変更が要るときは、10節の手順で契約の版を上げる

## 3. 採用判定の規則（2か所に実装がある）

最終判定が include の文献（採用リスト）を、TiAb と抽出アプリがそれぞれ計算している。どちらかを変えたら、もう片方も合わせる。

| 規則 | TiAb | 抽出アプリ（`tiabReview.ts`） |
| --- | --- | --- |
| 最新行への畳み込み: `(ref_id, reviewer_id, screening_phase)` ごとに `decided_at` 最大、同じなら下の行 | `src/lib/sheets/decisions.ts` の `collapseToLatestDecisions()` | `resolveAdoptedReferences()` の `latestKey()` |
| 重複として除外した文献（`duplicate_of` が空でない）は対象外 | `src/lib/reference-status.ts`（`isLogicallyDeleted()`） | `resolveAdoptedReferences()` が `duplicateOf` のある文献とその判定を除く（youkiti/sr-data-extraction-plugin#480 で対応。9節） |
| キーの開封前は、他のレビュアーの人の判定を使わない | `src/lib/sheets/decisions.ts` の `filterDecisionsForBlind()`、`src/lib/blind-visibility.ts`、`src/lib/sheets/config.ts` の `getKeyOpenedStatus()` | `readTiabSheet()` の `keyOpened` が false なら採用リストを計算しない（youkiti/sr-data-extraction-plugin#480 で対応。9節） |
| TiAb の相の AI 判定は有効な Run の実行の分だけ: `is_active` かつ確定の Run のうち `created_at` が最新の1件、その Run の `batch_screening` の実行 | `src/lib/sheets/llm-history.ts` の `selectActiveLlmRun()`・`selectActiveBatchIds()` | `selectActiveTiabLlmIds()`（youkiti/sr-data-extraction-plugin#480 で対応。9節） |
| 全文の AI 判定は `fulltext_ai_active_round` のラウンドだけ | `src/lib/decision-aggregate.ts` の `buildAllFulltextDecisionsMap()` | `resolveAdoptedReferences()` |
| 裁定票（`reviewer_id` が `adjudication:`、相は `fulltext`）があれば、最新の裁定票の判定を採る | `src/lib/fulltext-consensus.ts` の `computeFulltextConsensus()` | `resolveAdoptedReferences()` |
| 合議（`-human-consensus`）は人の判定として最新行の規則で効く | `src/lib/client-version.ts` の `isHumanDecision()` | 特別扱いなし（同じ結果） |
| 裁定票が無ければ、裁定以外の全判定者の OR 合議（include が1人でもいれば include） | `src/lib/fulltext-results-summary.ts` | `resolveAdoptedReferences()` |
| 全文の候補に入らない文献は採用しない。候補の判定は、畳み込み済みの判定と有効な Run の AI 判定で行う | `src/lib/fulltext-candidates.ts` の `isProjectFulltextCandidateRef()`、`src/lib/fulltext-pool.ts` | `isProjectFulltextCandidateRef()`・`countIncludeVotes()` に、畳み込み済みの判定と有効な Run の AI 判定だけを渡す（youkiti/sr-data-extraction-plugin#480 で対応。9節） |

TiAb の結果画面で利用者が判定者のチェックを外した状態はシートに残らない。シートから計算するときは、既定の全判定者で計算する。

## 4. 行と文献の指し方

- 文献は `ref_id` で指す。中身に意味の無い文字列として扱う（いまは取り込み時に UUID を作る）
- 行番号を覚えない。TiAb は Decisions の行を書き換え（ML の自動判定・AI 判定）、消す（全文の AI 判定のラウンドの削除）。References の行も、取り込み元のファイルを削除すると消える

## 5. 盲検

TiAb の盲検は、シートの権限ではなく、読み手のアプリが守る決まりで成り立っている。Config の `key_opened` が小文字にして `true` でない間（キーやタブが無ければ未開封）に使ってよい Decisions の行は、`reviewer_id` が自分のメールアドレスと一致する行と、`llm:` で始まる行だけ。採用リストは他のレビュアーの判定を使うので、開封後にだけ計算する。

## 6. 認証

スコープは `userinfo.email` と `drive.file`。`drive.file` の付与は「GCP プロジェクト × ユーザー × ファイル」の単位で、Drive の共有では付与されない。TiAb と別の GCP プロジェクトのアプリは、各ユーザーがそのアプリの Picker でシートを1回選ぶ（抽出アプリはこの形）。

## 7. 他のアプリが TiAb のシートに書き始めるときの条件

現在、TiAb のシートに書くアプリは無い。書き始める前に、この文書に次を足して契約の版を上げる。

- TiAb のタブ（`src/lib/sheets/schema.ts` のタブ名と `Annotations`）には書かない。TiAb の書き込みは列の位置で行を組み立て、Decisions の行番号をキャッシュして書き換え、`ensureHeaders()` が References の1行目を書き直すことがある。他のアプリが行や列を足すと、TiAb が別の行を上書きしたり、TiAb の新しい列が使えなくなったりする
- 書くのは、そのアプリ専用の接頭辞で始まる名前のタブだけにし、接頭辞をこの文書に登録する
- 同じ GCP プロジェクトに置くかを決める。同じにすると選び直しが要らなくなるが、OAuth の同意画面と API の割り当てを TiAb と共有する

## 8. Annotations タブ

予約の名前。TiAb は現在このタブを作らず、読み書きもしない。抽出アプリも使っていない。

## 9. 既知の食い違い（TiAb dc4e7be、抽出アプリ 4af7456）

1〜3 は抽出アプリの Issue youkiti/sr-data-extraction-plugin#480 で解消する（解消前の状態は次のとおり）。解消したら、この節の該当の項目を「解消済み（抽出アプリの版・PR）」に書き換える。

1. 抽出アプリは `duplicate_of` を読まないので、重複として除外した文献を採用しうる
2. 抽出アプリは `key_opened` を読まないので、開封前でも全員の判定から採用リストと件数を出す。youkiti/sr-data-extraction-plugin#480 の後は、開封前は採用リストも件数も出さない
3. 抽出アプリの候補の判定は生の全行を使うため、過去に一度 include した文献や、有効でない Run の AI 判定も数える

4・5 は、抽出アプリが仕様として変えないと決めた違い。どちらも TiAb のシートを TiAb だけで使っている限り起きない。

4. 同じ `decided_at` の行では、抽出アプリは上の行を残す（TiAb は下の行）。TiAb の `decided_at` はミリ秒まで入るので、同じ判定者が同じ文献に同じ時刻で2行書くことは通常起きない
5. 同じ名前の列が2つあると、抽出アプリは左の列を読む（TiAb は右の列）。抽出アプリはセルの前後の空白も除く。TiAb は同じ名前の列を作らないので、利用者が手で列を足した場合にだけ起きる

## 10. 契約の版

- この文書の題の「契約 v1」が版。シートには版を記録しない
- 2節の1〜4を守れない変更をするときは、そのときに Config へ `tiab_schema_version` を足して `2` を書き、この文書を「契約 v2」にする。`tiab_schema_version` が無いシートは v1 とみなす。読み手のアプリは、知らない版のシートでは読み込みを止めて利用者に知らせる
- 列を末尾に足すだけの変更は版を上げない
