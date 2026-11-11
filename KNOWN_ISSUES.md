# 既知の不具合 / Known issues

TiAb Review の不具合のうち、判定や保存された値、論文用テキストやエクスポートの数値、Methods に書く記録（版・設定・プロンプト）に影響したものを、影響した版の範囲とともに載せます。表示の崩れや操作の不具合は CHANGELOG.md だけに載せます。自分の判定に記録された版は、Decisions タブの client_version 列で確かめられます（例: 0.48.0-human、web-0.42.2-human）。

This file lists TiAb Review bugs that affected decisions or stored values, numbers in the manuscript text or exports, or the records reported in Methods (versions, settings, prompts), with the range of versions affected. Display or usability bugs are listed only in CHANGELOG.md. The version that recorded each decision is in the client_version column of the Decisions tab (for example 0.48.0-human or web-0.42.2-human).

## 一覧 / Overview

| ID | 不具合 | 影響した版 | 判定や数値への影響 | 確かめ方 | 修正版 | 関連 |
| --- | --- | --- | --- | --- | --- | --- |
| KI-001 | ML の統計的停止基準（CMH）を選んでも、実際には「連続 Exclude 500件」の基準で動いていた | 拡張版 v0.8.1〜v0.48.0（CMH の導入 c64fd56 を含む最初の版が v0.8.1。ML タブは文献1,000件以上で CMH を案内） | 停止の提案は Exclude が500件続いたときだけ出た。読む件数が増える方向で、見落としを増やす方向ではない。CMH を使ったと Methods に書いた場合、その記述は実際の動作と違う | 範囲内の版で ML の停止基準を使い、残りを一括除外した: Decisions に `-ml-auto` の行があり、版が 0.48.0 以下なら、その一括除外は連続 Exclude 500件の基準による | v0.49.0 | Issue #227、PR #225 |
| KI-002 | Web 版でログイン切れの後の判定がブラウザ内に滞留し、滞留を送り直す処理が並走して同じ判定が重複して追記された | Web版 2026-07-08〜2026-09-03 の公開（client_version web-0.25.0〜web-0.42.2）。拡張版も v0.7.3〜v0.42.2 は送り直しの直列化が無い同じ作りだったが、重複追記が確認されたのは Web 版だけ | 滞留した判定はシートに届くまで、ほかのレビュアーや管理者の集計（進捗、κ、全文の候補、PRISMA の数値）に入らない（2026-09 の事例で264件）。重複した行は同じ判定・同じ日時なので、文献ごと・判定者ごとに最新の判定を採る集計では値は変わらない（推測）。Decisions の行数を数える集計と判定履歴の件数は増える（同事例で197件が393行） | Decisions で、client_version が `web-0.42.2` 以下で、`ref_id`・`reviewer_id`・`decision`・`decided_at` が同じ行が2行以上ある。滞留が残っていれば、当時と同じブラウザ・同じアカウントで今の Web 版を開くと「未送信」の件数が出る（件数の表示は v0.43.0 から） | v0.43.0（Web版は 2026-09-03 の公開） | PR #138、src/lib/AGENTS.md「2026-09 事故の要約」 |
| KI-003 | 全文の AI 判定で、Gemini が根拠の引用を途中で打ち切る（RECITATION）と、判定ごと失敗した | 拡張版 v0.21.0〜v0.50.0（開始は全文 AI 判定の導入版。確認できた範囲: 打ち切りを扱う分岐はこの間ずっと無かった） | 該当の文献で AI の判定が記録されず、再実行しても同じく失敗した。AI の票が欠けるので、AI が判定した件数が減り、合議（OR）に AI の票が入らない。記録された判定の値が誤るものではない | LLM_Executions の全文の実行で `failure_breakdown` に `llm` があり、エラーが「Gemini APIからの応答をJSONとしてパースできませんでした」 | v0.51.0 | Issue #254、PR #255 |
| KI-004 | 全文の AI 判定のプロンプトの版に、TiAb の版（`v1.0.0`）が記録されていた | 拡張版 v0.21.0〜v0.54.0 | 全文のプロンプトの文面は、版の記録が変わらないまま変わっていた。Methods に書いたプロンプトの版から、全文で使った文面を特定できない | 全文の AI 判定（Decisions の `screening_phase` が fulltext、`reviewer_id` が `llm:` で始まる行）の版が 0.54.0 以下。その期間の文面はコミット履歴の `src/lib/gemini-fulltext.ts` を判定日で引く | v0.55.0（以後 `fulltext-v2.0.0`） | PR #267、CHANGELOG v0.55.0 |
| KI-005 | 「失敗分をリトライ」が、通常の実行と違う生成設定（temperature 0）で送り、実行の記録（LLM_Executions）にも残らなかった | 拡張版 〜v0.54.0（開始版は特定していない。確認できた範囲: リトライの機能は v0.6.0 からある） | リトライで判定された文献だけ、通常の実行と生成設定が違う（Gemini 3 Flash Preview の通常は temperature 1.0・top-p 0.95）。その判定は実行の記録が無い孤立した判定になり、Methods の生成設定の記述がその文献には当てはまらない | Decisions の AI 判定のうち、`reviewer_id`（実行 ID）が LLM_Executions に無いもの | v0.55.0 | PR #267（コミット 45c856b）、CHANGELOG v0.55.0 |
| KI-006 | ML の停止基準で読まずに一括除外した文献を、人が判定した除外として数えていた | 論文用テキスト・画面の人数: 拡張版 v0.24.0〜v0.54.0（v0.24.0 は論文用テキストの導入版。一括除外の機能は v0.7.1 から） | 論文用テキストの Methods・Results で、読まずに除外した件数が人の除外に含まれ、分けて書かれなかった。画面の「人が判定した人数」にも数えた。チームの状態（除外など）と保存形式は変わらない | Decisions に `-ml-auto` の行がある。v0.55.0 以降で論文用テキストを作り直すと、読まずに除外した件数が別の文で出る | v0.55.0 | PR #268、CHANGELOG v0.55.0 |
| KI-007 | 論文用テキストの AI の文が、実際に送った設定でなく画面の設定値で書かれていた | 拡張版 v0.24.0〜v0.54.0（確認できた範囲: 論文用テキストの導入版から。AI の文が入った版は特定していない） | AI の文の生成設定が、送った値と違うことがあった。例: GPT-5.6 Terra / Luna は画面の設定が medium でも、一括判定は low を送っていた | 範囲内の版で作った論文用テキストの AI の文を、v0.55.0 以降で作り直して比べる | v0.55.0 | PR #267（コミット cbd7fc3）、CHANGELOG v0.55.0 |
| KI-008 | 読めるが書けないシート（閲覧者の権限など）で、判定が1件も保存されないまま判定を続けられ、完了と表示された | 拡張版・Web版 〜v0.57.0（開始版は特定していない。確認できた範囲: 未送信の保存は v0.7.3 からある） | その利用者の判定はブラウザの中にだけあり、シートに届かない。ほかのレビュアーと管理者の集計（κ、全文の候補、PRISMA の数値）にその人の判定が入らない。本人の画面は完了と表示された | 画面の「未送信」の件数が0でない。Decisions で自分の `reviewer_id` の行が、判定した件数より少ない。復旧は、オーナーに編集者の権限を付けてもらい「未送信」を押す（それまで拡張機能の削除、サイトデータの消去、アカウントの切り替えをしない） | v0.57.1 | Issue #271、PR #289 |

## 項目 / Entries

### KI-001 ML の統計的停止基準（CMH）が働いていなかった / The CMH stopping rule did not take effect

**ja**

- 不具合: ML の統計的停止基準（CMH）を選んでも、実際には「連続 Exclude 500件」の基準で動いていた。
- 影響した版: 拡張版 v0.8.1〜v0.48.0（CMH の導入 c64fd56 を含む最初の版が v0.8.1。ML タブは文献1,000件以上で CMH を案内）。
- 判定や数値への影響: 停止の提案は Exclude が500件続いたときだけ出た。読む件数が増える方向で、見落としを増やす方向ではない。CMH を使ったと Methods に書いた場合、その記述は実際の動作と違う。
- 確かめ方: 範囲内の版で ML の停止基準を使い、残りを一括除外した: Decisions に `-ml-auto` の行があり、版が 0.48.0 以下なら、その一括除外は連続 Exclude 500件の基準による。
- 修正版: v0.49.0
- 関連: Issue #227、PR #225

**en**

- Bug: Even when the statistical stopping rule (CMH) was selected in the ML tab, the app actually ran the "500 consecutive Excludes" rule.
- Versions affected: extension v0.8.1 to v0.48.0 (v0.8.1 is the first version containing the CMH introduction, c64fd56; the ML tab recommends CMH for 1,000 or more references).
- Effect on decisions or numbers: A stop suggestion appeared only after 500 consecutive Excludes. This increased the number of references read; it did not increase missed records. If Methods states that CMH was used, that statement does not match what actually ran.
- How to check: You used the ML stopping rule in a version in this range and bulk-excluded the rest: if Decisions has rows with `-ml-auto` and the version is 0.48.0 or earlier, that bulk exclusion followed the 500-consecutive-Excludes rule.
- Fixed in: v0.49.0
- Related: Issue #227, PR #225

### KI-002 Web 版で判定が重複して追記された / Duplicate decisions were appended in the web version

**ja**

- 不具合: Web 版でログイン切れの後の判定がブラウザ内に滞留し、滞留を送り直す処理が並走して同じ判定が重複して追記された。
- 影響した版: Web版 2026-07-08〜2026-09-03 の公開（client_version web-0.25.0〜web-0.42.2）。拡張版も v0.7.3〜v0.42.2 は送り直しの直列化が無い同じ作りだったが、重複追記が確認されたのは Web 版だけ。
- 判定や数値への影響: 滞留した判定はシートに届くまで、ほかのレビュアーや管理者の集計（進捗、κ、全文の候補、PRISMA の数値）に入らない（2026-09 の事例で264件）。重複した行は同じ判定・同じ日時なので、文献ごと・判定者ごとに最新の判定を採る集計では値は変わらない（推測）。Decisions の行数を数える集計と判定履歴の件数は増える（同事例で197件が393行）。
- 確かめ方: Decisions で、client_version が `web-0.42.2` 以下で、`ref_id`・`reviewer_id`・`decision`・`decided_at` が同じ行が2行以上ある。滞留が残っていれば、当時と同じブラウザ・同じアカウントで今の Web 版を開くと「未送信」の件数が出る（件数の表示は v0.43.0 から）。
- 修正版: v0.43.0（Web版は 2026-09-03 の公開）
- 関連: PR #138、src/lib/AGENTS.md「2026-09 事故の要約」

**en**

- Bug: In the web version, decisions made after the login expired stayed queued in the browser, and the process that resends the queue ran in parallel, so the same decision was appended more than once.
- Versions affected: web version published 2026-07-08 to 2026-09-03 (client_version web-0.25.0 to web-0.42.2). The extension from v0.7.3 to v0.42.2 had the same design, without serialized resending, but duplicate appends were confirmed only in the web version.
- Effect on decisions or numbers: Until queued decisions reached the sheet, they were not counted in other reviewers' or admins' aggregates (progress, kappa, full-text candidates, PRISMA numbers); 264 decisions in the 2026-09 case. Duplicated rows have the same decision and the same timestamp, so aggregates that take the latest decision per reference and reviewer are not changed (this is an inference). Aggregates that count Decisions rows, and the count of decision history entries, increased (197 decisions became 393 rows in the same case).
- How to check: In Decisions, look for two or more rows with the same `ref_id`, `reviewer_id`, `decision`, and `decided_at` whose client_version is `web-0.42.2` or earlier. If a queue remains, opening the current web version in the same browser with the same account as at that time shows the count of unsent decisions (the count is shown from v0.43.0).
- Fixed in: v0.43.0 (web version published on 2026-09-03)
- Related: PR #138, "2026-09 事故の要約" in src/lib/AGENTS.md

### KI-003 全文の AI 判定が RECITATION で失敗した / Full-text AI screening failed on RECITATION

**ja**

- 不具合: 全文の AI 判定で、Gemini が根拠の引用を途中で打ち切る（RECITATION）と、判定ごと失敗した。
- 影響した版: 拡張版 v0.21.0〜v0.50.0（開始は全文 AI 判定の導入版。確認できた範囲: 打ち切りを扱う分岐はこの間ずっと無かった）。
- 判定や数値への影響: 該当の文献で AI の判定が記録されず、再実行しても同じく失敗した。AI の票が欠けるので、AI が判定した件数が減り、合議（OR）に AI の票が入らない。記録された判定の値が誤るものではない。
- 確かめ方: LLM_Executions の全文の実行で `failure_breakdown` に `llm` があり、エラーが「Gemini APIからの応答をJSONとしてパースできませんでした」。
- 修正版: v0.51.0
- 関連: Issue #254、PR #255

**en**

- Bug: In full-text AI screening, when Gemini cut off its quoted evidence partway (RECITATION), the whole judgment failed.
- Versions affected: extension v0.21.0 to v0.50.0 (the start is the version that introduced full-text AI screening; the confirmed range is that no branch handling the cut-off existed during this period).
- Effect on decisions or numbers: No AI decision was recorded for the affected references, and rerunning failed the same way. Because the AI vote is missing, the number of AI-judged references is lower and the AI vote is absent from the consensus (OR). The recorded decision values are not wrong.
- How to check: In LLM_Executions, a full-text run has `llm` in `failure_breakdown` and the error is "Gemini APIからの応答をJSONとしてパースできませんでした" (the Gemini API response could not be parsed as JSON).
- Fixed in: v0.51.0
- Related: Issue #254, PR #255

### KI-004 全文のプロンプトの版が TiAb の版で記録された / The full-text prompt version was recorded as the TiAb version

**ja**

- 不具合: 全文の AI 判定のプロンプトの版に、TiAb の版（`v1.0.0`）が記録されていた。
- 影響した版: 拡張版 v0.21.0〜v0.54.0。
- 判定や数値への影響: 全文のプロンプトの文面は、版の記録が変わらないまま変わっていた。Methods に書いたプロンプトの版から、全文で使った文面を特定できない。
- 確かめ方: 全文の AI 判定（Decisions の `screening_phase` が fulltext、`reviewer_id` が `llm:` で始まる行）の版が 0.54.0 以下。その期間の文面はコミット履歴の `src/lib/gemini-fulltext.ts` を判定日で引く。
- 修正版: v0.55.0（以後 `fulltext-v2.0.0`）
- 関連: PR #267、CHANGELOG v0.55.0

**en**

- Bug: The prompt version recorded for full-text AI screening was the TiAb version (`v1.0.0`).
- Versions affected: extension v0.21.0 to v0.54.0.
- Effect on decisions or numbers: The wording of the full-text prompt changed while the recorded version stayed the same. The prompt version reported in Methods does not identify the wording used for full text.
- How to check: A full-text AI decision (a Decisions row whose `screening_phase` is fulltext and whose `reviewer_id` starts with `llm:`) has a version of 0.54.0 or earlier. For the wording in that period, look up `src/lib/gemini-fulltext.ts` in the commit history by the decision date.
- Fixed in: v0.55.0 (recorded as `fulltext-v2.0.0` from then on)
- Related: PR #267, CHANGELOG v0.55.0

### KI-005 「失敗分をリトライ」の生成設定と記録 / Generation settings and records of "retry failed"

**ja**

- 不具合: 「失敗分をリトライ」が、通常の実行と違う生成設定（temperature 0）で送り、実行の記録（LLM_Executions）にも残らなかった。
- 影響した版: 拡張版 〜v0.54.0（開始版は特定していない。確認できた範囲: リトライの機能は v0.6.0 からある）。
- 判定や数値への影響: リトライで判定された文献だけ、通常の実行と生成設定が違う（Gemini 3 Flash Preview の通常は temperature 1.0・top-p 0.95）。その判定は実行の記録が無い孤立した判定になり、Methods の生成設定の記述がその文献には当てはまらない。
- 確かめ方: Decisions の AI 判定のうち、`reviewer_id`（実行 ID）が LLM_Executions に無いもの。
- 修正版: v0.55.0
- 関連: PR #267（コミット 45c856b）、CHANGELOG v0.55.0

**en**

- Bug: "Retry failed" sent requests with generation settings different from a normal run (temperature 0), and left no record in the run log (LLM_Executions).
- Versions affected: extension up to v0.54.0 (the start version has not been identified; the confirmed range is that the retry feature has existed since v0.6.0).
- Effect on decisions or numbers: Only the references judged by a retry have generation settings different from a normal run (for Gemini 3 Flash Preview, a normal run uses temperature 1.0 and top-p 0.95). Those decisions are orphaned, with no run record, and the generation settings described in Methods do not apply to those references.
- How to check: AI decisions in Decisions whose `reviewer_id` (the run ID) is not in LLM_Executions.
- Fixed in: v0.55.0
- Related: PR #267 (commit 45c856b), CHANGELOG v0.55.0

### KI-006 読まずに一括除外した文献が人の除外に数えられた / References bulk-excluded unread were counted as human exclusions

**ja**

- 不具合: ML の停止基準で読まずに一括除外した文献を、人が判定した除外として数えていた。
- 影響した版: 論文用テキスト・画面の人数: 拡張版 v0.24.0〜v0.54.0（v0.24.0 は論文用テキストの導入版。一括除外の機能は v0.7.1 から）。
- 判定や数値への影響: 論文用テキストの Methods・Results で、読まずに除外した件数が人の除外に含まれ、分けて書かれなかった。画面の「人が判定した人数」にも数えた。チームの状態（除外など）と保存形式は変わらない。
- 確かめ方: Decisions に `-ml-auto` の行がある。v0.55.0 以降で論文用テキストを作り直すと、読まずに除外した件数が別の文で出る。
- 修正版: v0.55.0
- 関連: PR #268、CHANGELOG v0.55.0

**en**

- Bug: References bulk-excluded without reading by the ML stopping rule were counted as exclusions made by a human.
- Versions affected: manuscript text and on-screen counts: extension v0.24.0 to v0.54.0 (v0.24.0 introduced the manuscript text; the bulk-exclusion feature has existed since v0.7.1).
- Effect on decisions or numbers: In the Methods and Results of the manuscript text, the number of references excluded unread was included in the human exclusions and was not reported separately. The on-screen count of references judged by humans also included them. The team's status (excluded and so on) and the storage format are unchanged.
- How to check: Decisions has rows with `-ml-auto`. If you regenerate the manuscript text in v0.55.0 or later, the number excluded unread appears in a separate sentence.
- Fixed in: v0.55.0
- Related: PR #268, CHANGELOG v0.55.0

### KI-007 論文用テキストの AI の文が画面の設定値で書かれた / The AI sentences in the manuscript text used on-screen settings instead of the settings actually sent

**ja**

- 不具合: 論文用テキストの AI の文が、実際に送った設定でなく画面の設定値で書かれていた。
- 影響した版: 拡張版 v0.24.0〜v0.54.0（確認できた範囲: 論文用テキストの導入版から。AI の文が入った版は特定していない）。
- 判定や数値への影響: AI の文の生成設定が、送った値と違うことがあった。例: GPT-5.6 Terra / Luna は画面の設定が medium でも、一括判定は low を送っていた。
- 確かめ方: 範囲内の版で作った論文用テキストの AI の文を、v0.55.0 以降で作り直して比べる。
- 修正版: v0.55.0
- 関連: PR #267（コミット cbd7fc3）、CHANGELOG v0.55.0

**en**

- Bug: The AI sentences in the manuscript text were written from the on-screen settings, not from the settings actually sent.
- Versions affected: extension v0.24.0 to v0.54.0 (the confirmed range starts at the version that introduced the manuscript text; the version in which the AI sentences were added has not been identified).
- Effect on decisions or numbers: The generation settings in the AI sentences sometimes differed from the values sent. For example, GPT-5.6 Terra and Luna sent low for batch screening even when the on-screen setting was medium.
- How to check: Regenerate the AI sentences of a manuscript text made in a version in this range with v0.55.0 or later, and compare.
- Fixed in: v0.55.0
- Related: PR #267 (commit cbd7fc3), CHANGELOG v0.55.0

### KI-008 書けないシートで未送信のまま完了と表示された / Screening continued and showed as complete on a sheet the user could read but not write

**ja**

- 不具合: 読めるが書けないシート（閲覧者の権限など）で、判定が1件も保存されないまま判定を続けられ、完了と表示された。
- 影響した版: 拡張版・Web版 〜v0.57.0（開始版は特定していない。確認できた範囲: 未送信の保存は v0.7.3 からある）。
- 判定や数値への影響: その利用者の判定はブラウザの中にだけあり、シートに届かない。ほかのレビュアーと管理者の集計（κ、全文の候補、PRISMA の数値）にその人の判定が入らない。本人の画面は完了と表示された。
- 確かめ方: 画面の「未送信」の件数が0でない。Decisions で自分の `reviewer_id` の行が、判定した件数より少ない。復旧は、オーナーに編集者の権限を付けてもらい「未送信」を押す（それまで拡張機能の削除、サイトデータの消去、アカウントの切り替えをしない）。
- 修正版: v0.57.1
- 関連: Issue #271、PR #289

**en**

- Bug: On a sheet the user could read but not write (for example with viewer permission), the user could keep screening with no decision saved at all, and the screen showed completion.
- Versions affected: extension and web version up to v0.57.0 (the start version has not been identified; the confirmed range is that saving unsent decisions has existed since v0.7.3).
- Effect on decisions or numbers: That user's decisions exist only in the browser and do not reach the sheet. They are not included in other reviewers' or admins' aggregates (kappa, full-text candidates, PRISMA numbers). The user's own screen showed completion.
- How to check: The "unsent" count on screen is not 0. In Decisions, the rows for your own `reviewer_id` are fewer than the number of decisions you made. To recover, ask the owner to give you editor permission and press "unsent" (until then, do not remove the extension, clear site data, or switch accounts).
- Fixed in: v0.57.1
- Related: Issue #271, PR #289

## 付録: 版とコミットの対応 / Appendix: versions and commits

v0.57.2 までは git タグがありません。この表は、main 上で package.json の版が初めてその値になったコミットです。ストアに提出した zip のビルド元と同一であることは確かめていません。v0.57.2 より後の版は、リリースのコマンドが merge commit に vX.Y.Z のタグを打ちます（この表には足しません）。

Versions up to v0.57.2 have no git tags. This table lists, for each version, the first commit on main where package.json had that version. It has not been verified that these are the exact sources of the zip files submitted to the Chrome Web Store. Versions after v0.57.2 are tagged vX.Y.Z on the merge commit by the release command (and are not added to this table).

| 版 | コミット | 日付 |
| --- | --- | --- |
| v0.1.0 | c34559c | 2025-12-26 |
| v0.2.0 | 845959c | 2025-12-28 |
| v0.3.1 | c07d237 | 2025-12-29 |
| v0.5.0 | 4fd12ac | 2025-12-31 |
| v0.6.0 | 633d49a | 2025-12-31 |
| v0.6.1 | 58ef968 | 2025-12-31 |
| v0.6.2 | 48e5c07 | 2025-12-31 |
| v0.7.0 | ea74319 | 2026-01-02 |
| v0.7.1 | 7f9d3d7 | 2026-01-02 |
| v0.7.2 | 2172c9e | 2026-01-03 |
| v0.7.3 | 4c25d9c | 2026-01-03 |
| v0.7.4 | a8c9cc5 | 2026-01-06 |
| v0.8.0 | d169788 | 2026-01-12 |
| v0.8.1 | df22790 | 2026-02-15 |
| v0.9.0 | 351e749 | 2026-03-18 |
| v0.9.1 | 7477e98 | 2026-03-26 |
| v0.10.0 | 7d4c198 | 2026-03-29 |
| v0.12.0 | 3009230 | 2026-04-29 |
| v0.13.0 | 6964144 | 2026-04-29 |
| v0.14.0 | 715354f | 2026-04-30 |
| v0.16.0 | 52aef0a | 2026-05-08 |
| v0.16.1 | f21cca5 | 2026-05-08 |
| v0.17.0 | 4cd64f7 | 2026-05-11 |
| v0.18.0 | 2f95141 | 2026-05-15 |
| v0.18.1 | 11742be | 2026-05-18 |
| v0.18.2 | 27f01cb | 2026-05-20 |
| v0.20.0 | 5e08eb7 | 2026-05-24 |
| v0.20.1 | 2ddb566 | 2026-05-26 |
| v0.20.2 | 4a688cc | 2026-05-30 |
| v0.20.3 | b2bacad | 2026-05-30 |
| v0.21.0 | 618609a | 2026-06-29 |
| v0.22.0 | 518b100 | 2026-06-30 |
| v0.22.1 | 94f3c40 | 2026-06-30 |
| v0.23.0 | 231938e | 2026-07-01 |
| v0.23.1 | df20566 | 2026-07-02 |
| v0.24.0 | 3ad902c | 2026-07-07 |
| v0.25.0 | cd1bff2 | 2026-07-08 |
| v0.26.0 | ed80fa9 | 2026-07-12 |
| v0.27.0 | 2ade8f7 | 2026-07-15 |
| v0.28.0 | c5269c1 | 2026-07-16 |
| v0.29.0 | 7e23a7c | 2026-07-18 |
| v0.29.1 | aa9b780 | 2026-07-18 |
| v0.30.0 | c2955e9 | 2026-07-21 |
| v0.31.0 | e731797 | 2026-07-27 |
| v0.32.0 | b22b258 | 2026-07-29 |
| v0.33.0 | d1a51e7 | 2026-08-01 |
| v0.33.1 | 54af87e | 2026-08-01 |
| v0.33.2 | a56caac | 2026-08-03 |
| v0.34.0 | ef3cf1b | 2026-08-05 |
| v0.35.0 | fcae6c5 | 2026-08-06 |
| v0.36.0 | 7d77e8e | 2026-08-10 |
| v0.36.1 | 5c015e2 | 2026-08-10 |
| v0.37.0 | 7c97436 | 2026-08-11 |
| v0.37.1 | 5d1e7da | 2026-08-11 |
| v0.37.2 | 87229f8 | 2026-08-12 |
| v0.37.3 | 62cf371 | 2026-08-17 |
| v0.37.4 | 370a4aa | 2026-08-18 |
| v0.38.0 | a9514d3 | 2026-08-20 |
| v0.39.0 | 3908d46 | 2026-08-24 |
| v0.40.0 | da8e2f4 | 2026-08-24 |
| v0.41.0 | 8f8a234 | 2026-08-26 |
| v0.42.0 | b66ef32 | 2026-08-27 |
| v0.42.1 | 7c56173 | 2026-08-28 |
| v0.42.2 | c0250a5 | 2026-08-29 |
| v0.43.0 | 90c8bfa | 2026-09-03 |
| v0.44.0 | 45b6da2 | 2026-09-04 |
| v0.44.1 | 76becda | 2026-09-07 |
| v0.45.0 | b9255e5 | 2026-09-09 |
| v0.46.0 | 5441f16 | 2026-09-17 |
| v0.47.0 | 43fb508 | 2026-09-24 |
| v0.48.0 | ee20aaa | 2026-10-01 |
| v0.49.0 | d9d3062 | 2026-10-01 |
| v0.50.0 | 6519eca | 2026-10-02 |
| v0.51.0 | c48f00d | 2026-10-07 |
| v0.52.0 | 696c7ed | 2026-10-10 |
| v0.53.0 | 49d46b5 | 2026-10-15 |
| v0.54.0 | 10234b6 | 2026-10-16 |
| v0.55.0 | b5ef8ad | 2026-10-20 |
| v0.56.0 | 287b524 | 2026-10-31 |
| v0.57.0 | e90560e | 2026-11-07 |
| v0.57.1 | 0a00128 | 2026-11-07 |
| v0.57.2 | dc4e7be | 2026-11-09 |
