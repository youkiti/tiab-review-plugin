# src/lib/ の仕様

このファイルは ../../AGENTS.md（リポジトリ根）から Issue #195 で切り出した詳細仕様です。
リポジトリ全体の規約・CRITICAL PROTOCOLS は [根の AGENTS.md](../../AGENTS.md) を参照してください。

## インポート規約

- **必須列**: `title`
- **欠損値**: 空白として取り込み
- **abstract制限**: 15,000文字を超える場合は超過分を切り取り（通常の抄録は500-2000文字程度）

### dedupe_key 生成ロジック

重複検出キーは以下のルールで生成:

```
dedupe_key = normalize(title).substring(0, 100) + "|" + year + "|" + normalize(firstAuthorLastName)
```

- `normalize()`: 小文字化、記号除去、空白正規化
- `year` または `firstAuthorLastName` が欠損の場合は空文字として扱う
- DOI が存在する場合は DOI を優先使用（完全一致）

### RIS インポートフィールドマッピング

| RIS タグ     | References 列 | 備考                   |
| ------------ | ------------- | ---------------------- |
| TI / T1      | title         | 必須                   |
| AB / N2      | abstract      |                        |
| PY / Y1      | year          | 年部分のみ抽出         |
| AU / A1      | authors       | セミコロン区切りで結合 |
| JO / JF / T2 | journal       | 優先順位: JO > JF > T2 |
| DO           | doi           |                        |
| AN（PubMed） | pmid          | ソースがPubMedの場合   |
| UR / L1      | url           |                        |
| DB           | source        |                        |

### ClinicalTrials.gov CSV インポートフィールドマッピング

| CSV カラム     | References 列 | 備考                                     |
| -------------- | ------------- | ---------------------------------------- |
| Study Title    | title         | 必須                                     |
| NCT Number     | pmid          | dedupe_key 生成に使用                    |
| Study URL      | url           |                                          |
| Start Date     | year          | 年部分のみ抽出                           |
| ―             | journal       | 固定値 "ClinicalTrials.gov"              |
| ―             | source        | 固定値 "ClinicalTrials.gov"              |
| その他全カラム | abstract      | `カラム名: 値` 形式で `\|` 区切り合成 |

### ICTRP XML インポートフィールドマッピング

| XML 要素           | References 列 | 備考                                   |
| ------------------ | ------------- | -------------------------------------- |
| Scientific_title   | title         | 必須                                   |
| TrialID            | pmid          | dedupe_key 生成に使用                  |
| web_address        | url           |                                        |
| Date_registration  | year          | 年部分のみ抽出                         |
| Source_Register    | source        | レジストリ名（REBEC, JPRN 等）         |
| ―                 | journal       | 固定値 "ICTRP"                         |
| その他臨床情報要素 | abstract      | `要素名: 値` 形式で `\|` 区切り合成 |

### 試験登録レコードのフルテキスト取得（レジストリスナップショット）

CTG/ICTRP由来のregistration行（上記2マッピング参照）は試験ID（NCT/jRCT/UMIN等）が pmid 列に入っており、通常論文向けのOA取得ウォーターフォール（`src/lib/fulltext-retriever.ts` の `iterateFulltextCandidates`。PMC OA → Europe PMC → Unpaywall → OpenAlex 等、pmid/doi前提）に入れても必ず `unavailable` で行き止まりになる。そのため `retrieveAndCacheFulltext()` は先頭で `isRegistrationRecord(ref)` を見て、trueならOAウォーターフォールへは一切入らず、登録内容を自己完結HTMLスナップショットにしてDriveへ保存する別経路（`retrieveRegistrationSnapshot()`）へ分岐する（レジストリ連携フェーズ1チャンク2パスA、Issue #118）。

- 試験ID抽出は `src/lib/registry-record.ts` の `extractTrialId()`（`NCT\d{8}` 完全一致なら `kind:'nct'`、それ以外の非空値は `kind:'other'`）
- `kind==='nct'` の場合、`src/lib/registry-api.ts` の `fetchCtgStudy()` で ClinicalTrials.gov API v2（`GET /api/v2/studies/{NCT}`）から詳細を取得してスナップショットに使う。取得失敗時は例外を投げず `null` を返す
- API失敗時（`null`）または `kind==='other'`（NCT以外のレジストリはAPI対象外）は、References に保存済みのフィールドだけでスナップショットを組み立てる。abstract列はCTG/ICTRPパーサが `ラベル: 値` を ` | ` 区切りで合成した文字列なので、`parseRegistryFieldsFromAbstract()` で逆変換する。この経路はネットワーク不要
- スナップショットHTML自体は `buildRegistrySnapshotHtml()`（外部CSS/JS/画像を一切参照しない自己完結HTML。埋め込み値は必ずHTMLエスケープする）、ファイル名は `buildRegistrySnapshotFileName()`（`buildPdfFileName()` と同じ命名規約で拡張子だけ `.html`）、Driveアップロードは `src/lib/drive-api.ts` の `uploadHtmlToDrive()`（`uploadPdfToDrive()` と同じmultipartアップロード処理を内部ヘルパーへ共通化）が担う
- Drive保存に失敗した場合は例外を外に投げず、原簿URL（`ref.url`）が `src/lib/registry-record.ts` の `isSafeHttpUrl()`（http/httpsのみを安全とみなすガード。元はHTML埋め込み専用のmodule-private関数だったが、この用途のため `export` した）を通れば `linked`、通らなければ（`javascript:`/`data:` 等の危険なスキームや相対URL・不正な値）または `ref.url` 自体が無ければ `none` にフォールバックする（一括取得ループを止めないため。既存OA経路の catch → `console.warn` の作法と同じ）。`ref.url` は References の url 列＝ユーザーが直接編集できるセル由来のため無検証で通してはいけない。この値はサイドパネルの `buildLinkBtn()` を経由して `chrome.tabs.create({ url })` にそのまま渡るため（描画側のガード追加は別スコープ。PR #122 レビュー指摘3、Issue #118 チャンク2）
- 通常の論文レコード（`isRegistrationRecord()` が false）の挙動はこの分岐追加前と変わらない
- パスB（論文候補探索）はチャンク2で実装済み（下記「試験登録レコードの論文候補探索」参照）。候補の表示・取り込み・References への行追加はチャンク3で実装済み（下記「論文候補の取り込み（Referencesへの追加）」参照）

### 試験登録レコードのフルテキストビューア表示（スナップショット）

上記で保存したHTMLスナップショットを `src/fulltext/fulltext.ts`（フルテキストビューア）で表示できるようにし、「PDFとして保存」導線を置く（レジストリ連携フェーズ1チャンク3c、Issue #118 実装内容10）。

- 表示経路の判定は `src/lib/fulltext-display-mode.ts` の `resolveFulltextDisplayMode()`（UI非依存の純関数）に集約している。`record_type`（`isRegistrationRecord()` 経由）と `fulltext_status`/`fulltext_url` から `'registry_snapshot' | 'pdf' | 'linked' | 'unavailable' | 'not_retrieved'` を返す。`isRegistrationRecord(ref)` かつ `fulltext_status==='cached'` かつ `fulltext_url` があるときだけ `'registry_snapshot'` になり、既存の `showCachedPdf()`（PDF.js経路）には一切入らない。HTMLをPDF.jsに渡すと解析に失敗し、catch節の「Chrome内蔵ビュワー(iframe blob)へのフォールバック」に落ちて非サンドボックスの `ft-pdf-frame` に生HTMLが載ってしまうため、この暗黙のフォールバックに頼らず明示的に分岐させている
- **`showPdfForRef()` だけでなく `handleResolve()`（初回自動検索）の `outcome.kind==='cached'` 分岐も同じ判定で出し分けること。** `showCachedPdf()` の呼び出し元は複数あり、`showPdfForRef()` だけを直すと registration行の**初回**表示（一度も fetch していない状態から取得した直後）だけ旧経路（PDF.js→フォールバック）に残ってしまう。この抜け漏れはブリーフが名指ししていなかったが、`showCachedPdf()` の全呼び出し元を grep して見つけて塞いだ（`openLinkedInline()`/`uploadPdfFile()` からの呼び出しは対象外のまま据え置き。前者は registration行の 'linked' フォールバック時の別経路、後者はマジックナンバー検証済みの実PDFで、どちらも常にPDF経路で正しい）
- 表示は専用のサンドボックスiframe `#ft-snapshot-frame`（`fulltext.html`）に `srcdoc` でHTMLを流し込む（`showRegistrySnapshotFrame()`）。**sandbox属性は `allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox` で、`allow-scripts` は絶対に付けない。** スナップショットは `buildRegistrySnapshotHtml()` がエスケープ済みで生成するが、保存先はユーザーが編集し得るDriveファイルのため信頼できない前提で扱う。`allow-same-origin` は親から `frame.contentWindow.print()` を呼ぶために必要（「PDFとして保存」ボタン、`#ft-snapshot-print-btn`。既存の「このPDFを保存」＝ `ft-save-pdf-btn` とは別物）。`allow-scripts` と同時に付けるとsandboxが実質無効化されるが、scriptsを付けないため危険な組み合わせにはならない。既存の `ft-article-frame`（`sandbox="allow-scripts allow-same-origin ..."`）とは用途もsandbox設定も別物のため流用していない
  - **`allow-popups` / `allow-popups-to-escape-sandbox`（PR #124 レビュー指摘3）**: `buildRegistrySnapshotHtml()` が埋め込む原簿URLの `<a>` には `target="_blank" rel="noopener noreferrer"` を付けている。機序は次のとおり（Chromium 151 で実測した結果は下記「サンドボックス挙動の実機確認結果」を参照。ブラウザ実装差の可能性は残る）: 当初この属性が無く `#ft-snapshot-frame` に `allow-popups` 系を一切付けていなかったため、クリックするとサンドボックスiframe自身がその場で遷移していた。サンドボックス化された閲覧コンテキストが「自分自身」を遷移させることは常に許可されており、これは `allow-top-navigation`（トップレベルの閲覧コンテキストの遷移を制御する別のフラグ）の有無とは無関係に起こる。この遷移でスナップショット表示が消え、遷移先には sandbox が再適用（`allow-scripts` 無し）されて崩れた表示になり、ペインへ戻る手段が無くなっていた。`target="_blank"` を付けても `allow-popups` が無い場合は、HTML仕様の「sandboxed auxiliary navigation browsing context flag」が立っているため補助閲覧コンテキスト（新規タブ）の生成自体がブロックされる。**iframe内遷移へフォールバックするのではなく、リンクをクリックしても何も起きない**（ブラウザがコンソールにエラーを出す想定）。そのため `allow-popups` も要る。`allow-popups-to-escape-sandbox` は、サンドボックス化された閲覧コンテキストが開いた補助閲覧コンテキストへ sandbox が継承されると、`allow-scripts` の無い新規タブで遷移先が崩れるため、それを避ける目的で付けている。**ただし Chromium 151 の実測では、このトークンの有無で挙動は変わらなかった**（`allow-popups` だけでも新規タブは非サンドボックスになる。下記「サンドボックス挙動の実機確認結果」参照）。機序は特定できていないが、仕様どおり継承するブラウザ向けの保険として残している。**この組み合わせが安全な理由**: スナップショットHTMLに `allow-scripts` を付けない以上スクリプトは一切実行されないため `window.open` を programmatic に呼ぶ経路は存在せず、ポップアップはユーザーのアンカークリックのみから発生する。かつそのhrefは `isSafeHttpUrl()`（http/httpsのみ）を通ったものに限られる（`buildRegistrySnapshotHtml()` 側で保証済み）
  - **サンドボックス挙動の実機確認結果**（2026-08-27、Chromium 151 + Playwright で実測。以前ここには「この環境では実行検証できない」と書いていたが誤り。下記の方法で認証なしに検証できる）:
    - **検証方法**: dev ビルドを `--load-extension` で読み込み、`chrome-extension://<拡張ID>/fulltext/fulltext.html` を **`ref_id` クエリ無し**で開く。`initFulltextPage()` は `refId` が空なら `getAuthToken()` の**手前で** return するため、認証もスプレッドシートも無しに実CSP・実DOM・実sandbox属性の上でページが立ち上がる。あとは `page.evaluate()` で `#ft-snapshot-frame` に `srcdoc` を入れて直接叩けばよい（拡張ロードの雛形は `scripts/doc-screenshots/capture.mjs`）。ただし init が認証前に return する＝`wireSnapshotPrintButton()` 等の配線は張られていないので、ボタン起点で試すならハンドラ本体を張り直してからクリックする
    - **`contentWindow.print()`**: `allow-modals` があると無視されず `beforeprint` が発火し、印刷プレビューが実際に開く。印刷対象はスナップショットiframeの中身だけで、親ペインの判定パネルを巻き込まない（1ページ、送信先に「Microsoft Print to PDF」が選べる）。**対照実験**: `allow-modals` を外した iframe へ同じ呼び出しをすると `Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set.` が出て `beforeprint` は発火しない。modal 系APIの検証はこの対照が無いと成功側の観測が何も証明しないので必ず置くこと。なお `print()` は印刷プレビューでレンダラを同期ブロックするため `page.evaluate()` の戻り値では結果を取れない（`beforeprint` ハンドラの `console.log` で拾う。`page.click()` の ack がタイムアウトすること自体がプレビューが開いた傍証になる）
    - **原簿リンク**: 本番の sandbox 値で新規タブが開き、iframe 自身は遷移せずスナップショット表示が残る。**対照実験**: `allow-popups` を外すと新規タブは開かず `Blocked opening '<URL>' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.` が出る。**iframe内遷移へフォールバックはしない**（上記の想定どおりの挙動）
    - **`allow-popups-to-escape-sandbox` の効果は観測できなかった**: `allow-popups` のみでも新規タブは非サンドボックス（`document.location.origin` が遷移先そのもので、スクリプトも動く）になり、`allow-popups-to-escape-sandbox` を足しても変わらない。`<a>` の `rel="noopener noreferrer"` の有無でも変わらない（sandbox 2通り × rel 2通りの4通りすべて同じ結果）。機序は特定していない。仕様どおり継承するブラウザ向けの保険として残しているだけなので、**このトークンが実際に効いていることを前提にした変更をしないこと**
    - **`allow-scripts` を付けていないことの効果**: スナップショットHTMLに `<script>`・`<img onerror>`・`<svg onload>` を仕込んでも、いずれも実行されない（`document.title` も書き換わらない）
- Driveからの取得は `showCachedPdf()` と全く同じ作法（`extractDriveFileId()`/`downloadDriveFile()`、`pdfPrefetch` の先読み再利用、`token`/`isStale()` による取り違え防止）。`prefetchNeighbors()` は cached の隣接候補を中身に関わらず先読みするため、registration行の隣接候補でも二重ダウンロードは起きない。取得失敗時は無言の空ペインにせず、`showPdfAccessFailure()` と同じ `describePdfLoadFailure()` の分類を再利用しつつ、"PDF" と明記した既存文言だけをスナップショット向けに差し替えた専用パネル（`showRegistrySnapshotAccessFailure()`）を出す。**`buildPdfAccessFailurePanel()` 自体は変更せず複製した**（既存のPDF失敗UIへの影響をゼロにするため）
  - **0バイトのBlobも取得失敗として扱う（PR #124 レビュー指摘5）**: `showRegistrySnapshot()` の空ペイン防止ガードは `if (!blob || blob.size === 0)` で判定する。`null`/`undefined` と違い0バイトの `Blob` は truthy なので `if (!blob)` だけでは素通りしてしまい、`looksLikePdfBlob()`（先頭5バイト判定）も空文字のため `false`、`blob.text()` は `''` を返して `showRegistrySnapshotFrame('')` が `srcdoc=''` を設定しプレースホルダも隠すため、ペインが完全な空白になる「無言の空ペイン」が発生していた。0バイトはアップロード途中断やDrive側で中身が消えたファイルなどで起こりうる
- **実PDFで差し替えられた場合の安全網**: `isRegistrationRecord(ref)` は `record_type` というメタデータだけを見るため、ツールバーの「別のPDFをアップロード」でregistration行の `fulltext_url` が実PDFへ差し替えられていても `record_type` は `'registration'` のままで、`resolveFulltextDisplayMode()` は引き続き `'registry_snapshot'` を返す。この不整合はメタデータだけの純関数では解決できない（バイト列を見るにはfetchが要る）。そこで `showRegistrySnapshot()` は取得したバイト列の先頭が `%PDF`（`uploadPdfFile()` と同じマジックナンバー判定）なら、HTMLとして描画せず `showCachedPdf()`（通常のPDF経路）へ委譲する。`pdfPrefetch` の Promise は一度解決したBlobを返すだけなので、委譲しても二重ダウンロードにはならない。**純関数（メタデータ判定）と実行時のバイト列補正は責務を分けており、後者を前者に混ぜ込まない**
- ツールバー（`updateToolbarMode()`）は `fulltext_status==='cached' && fulltext_url` を `hasPdf` として「別のPDFをアップロード」「削除」を出す判定を持つが、これはスナップショット表示時も true になる。**どちらも隠さない**（削除はスナップショットを消して取り直す導線として、アップロードは登録内容のPDF＝プロトコル文書等で差し替える運用として、それぞれ実用上の意味がある）。ただし両ボタンの既定ラベルは「PDF」と明記しており表示中の中身（HTMLスナップショット）と食い違うため、`resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'` のときだけラベルをスナップショット向けの文言に差し替える。HTMLの既定ラベルは初回呼び出し時に記憶しておき、通常のPDF経路（registration行以外）では一切変えない
  - **`handleDeletePdf()` の後始末は必ず `updateToolbarMode()` に委ねる（PR #124 レビュー指摘4）**: 以前は `finally` で `delBtn.textContent = 'PDFを削除'` を直接ハードコードしており、`updateToolbarMode()` が設定したスナップショット向けラベルを削除失敗時に打ち消してしまっていた（スナップショットが表示されたままボタンだけ通常PDF向けラベルに戻る）。`finally` では `delBtn.disabled = false` のみ行い、ラベルの復元は `updateToolbarMode()` の呼び出し1本に一元化した（`defaultDeleteBtnLabel` を記憶しているため成功/失敗どちらのケースでも正しく出し分けられる）。判定（`resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'`）は `currentRef.fulltext_url`/`fulltext_status` を書き換える**前**、関数の先頭で行う（削除処理中に状態を変えるため、後回しにすると常に非スナップショット扱いになる）
  - **`window.confirm()` の文言もスナップショット表示中は出し分ける**: `resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'` のときだけ `fulltext_snapshotDeleteConfirm`（ja/en 追加済み）を使い、それ以外は従来の「このPDFをDriveから削除します」のまま
  - **既定ラベルのHTML i18n化は調査済み・未実施（本PRのスコープ外と判断）**: `src/lib/i18n.ts` に `data-i18n`/`data-i18n-title` 等を読んで `applyI18n()` で置換する仕組みが存在し `popup.html`/`sidepanel.html` では使われているが、`fulltext.html` は `data-i18n` 系属性を一切使っておらず `fulltext.ts` も `t()` しかimportしていない（`applyI18n()` 未呼び出し）。つまりこの2ボタンの既定ラベル（HTMLへ直書きした日本語）だけを `data-i18n` に乗せても、フルテキストビューア全体でこの仕組みを初めて使うことになり影響範囲が読めない。そのため既定ラベルは日本語ハードコードのまま据え置き、enロケールのユーザーには「スナップショット表示中は英語ラベル、通常PDF表示中は日本語の既定ラベル」という非対称が残る（HTMLのi18n基盤をフルテキストビューアへ新設するのは別スコープ）

### 試験登録レコードの論文候補探索（Publication_Candidates タブ）

registration行から「その試験の結果論文（linked publication）」の候補を発見し、`Publication_Candidates` タブへ保存する（レジストリ連携フェーズ1チャンク2パスB、Issue #118）。**この探索パス自体は候補の保存までで、References への行追加は一切行わない**（候補の表示・取り込みはチャンク3で実装済み。下記「論文候補の取り込み（Referencesへの追加）」参照。**References に行を追加する経路をこの探索パスに作らないこと** — 取り込みは必ず「取り込む」ボタンの明示操作を経由する。詳細は次項）。

- 探索ロジックは `src/lib/publication-suggest.ts`（UI非依存）の `discoverPublicationCandidates()`。3戦略を**直列**で実行する（PubMed E-utilities がAPIキー無しで3 req/s上限のため並列にしない）:
  1. `ctgov_reference`: `fetchCtgStudy()` が返す `pmids`（CTGov `referencesModule` 由来。呼び出し側が渡す。fetch不要）。`referencesModule.references` は `type` が `BACKGROUND`/`RESULT`/`DERIVED` に分かれており、`fetchCtgStudy()` 側で `type`（trim・大文字化）が `'BACKGROUND'`（試験結果と無関係な背景文献）の参照だけを除外する（PR #122 レビュー指摘1、Issue #118 チャンク2）。`RESULT` のみのallowlistにはしていない: `DERIVED` は「PubMed側がそのNCT番号を参照している論文」で結果論文の主要な供給源、`RESULT` はスポンサーが手動登録した分しか入らないため、allowlistだと取りこぼしが大きい。`type` 欠落・未知の値（将来API側に新種別が増えた場合を含む）は残す側に倒す（後方互換）。同一PMIDが複数の参照エントリに現れる場合は重複排除し元の出現順を保つ
  2. `pubmed_id`: esearch（`buildPubmedIdQuery()` が組み立てる `"<試験ID>"[si] OR "<試験ID>"[tiab]` クエリ）
  3. `europepmc`: Europe PMC で検索（jRCT/UMIN 等、NCT以外にも有効）。1回目は抄録限定 `ABSTRACT:"<試験ID>"`（`buildEuropePmcQuery()`）で検索し、1回目が**成功して**0件のときだけ2回目として従来の全文検索 `"<試験ID>"` へフォールバックする（1件以上ヒットすれば2回目は発生させない。1回目が失敗＝非200・JSON不正・ネットワーク例外の場合はフォールバックせずこの戦略をスキップして空配列を返す。失敗を「0件だった」と同一視して広い全文検索へフォールバックすると、落ちているサービスへの負荷が倍になるうえ一過性の失敗から拾ったノイズ候補が Publication_Candidates シートへ永続化されてしまうため）。ClinicalTrials.gov/UMIN-CTR/ISRCTNの3レジストリ×各12試験=36ペア（PubMedの`[si]`から作った正解ペア、発行年2015-2022限定。索引ラグで recall が0に潰れるのを避けるため）で実測したところ、全文検索一本（旧実装）は recall 86%（31/36）・平均ヒット数9.0件だったのに対し、抄録限定+0件時フォールバック案は recall 89%（32/36）・平均ヒット数4.0件だった。全文検索は「本文中で試験IDに言及しただけ」の総説・論説・別試験まで拾ってノイズになる（実例: EOLIA試験(NCT01470703)でEurope PMC由来23件がヒットしたが1件も結果論文ではなかった）。抄録限定・全文検索は単独では recall 86%（31/36）で同値だが、取りこぼす対象が異なる: NCT04112121（正解PMID 40496603）はPubMed抄録に試験の登録番号が書かれていないため抄録限定では0件になり取りこぼすが、全文検索なら1件ヒットして拾える。逆にNCT03719521（正解PMID 38162283）は抄録限定なら17件に絞られ1ページ目に収まり拾えるが、全文検索だと38件ヒットし`pageSize=25`の1ページ目からあふれて取りこぼす。フォールバックを残すのは、この2つの検索方式が互いに違うケースを取りこぼしており、0件時だけ全文検索へフォールバックすることで両方の取り分を得られるため（NCT04112121を拾えるようになる一方、NCT03719521は抄録限定の1回目で既に拾えているためフォールバックは発生せずノイズも増えない）。`TITLE:"<id>"`のOR追加は36ペア中結果が変わったのが0件だったため見送った（試験IDは論文タイトルには出現しない）。`resultType=lite`・`pageSize=25` は両クエリ共通で明示する（pmid/doi/title/journalTitle/pubYearしか使わないため `core`（全文リンク・抄録込みの重いレスポンス）は使わない）。フォールバックの有無にかかわらず `strategy` は両経路とも `europepmc` のまま（新しい戦略値は追加していない）
- **上記36ペアの recall は「#118 が取りこぼす論文」を測った数字ではない**（Issue #119 の保留理由）。あの正解ペアは PubMed の `[si]` から作っているため、同じ `[si]` を引く戦略2（`pubmed_id`）が自明に当てる。逆に言えば「`[si]` に索引されていない論文」は最初から正解セットに入り得ないので、3戦略がどれだけ取りこぼすかはあの36ペアでは一切測れていない。**同じ理由で CTGov `referencesModule` から正解セットを作るのも不可**（戦略1 `ctgov_reference` が読むのがまさにそのフィールドで、`[si]` の鏡像になる）。独立な正解セットは、既発表SRの組み入れ研究表か、CTGov以外のレジストリの投稿者申告欄（jRCTの主たる公表論文、UMIN-CTRの結果の公表状況、ISRCTNのpublication citations）から作ること。測定スクリプトと手順は `experiments/registry-linkage/`（`scoring.ts` の `validateGroundTruth()` が循環する由来を実際に弾く。純関数のテストは `tests/registry-linkage-scoring.test.ts`）。なお戦略1はNCTにしか効かないため取りこぼしは非NCT層（jRCT/UMIN等、ICTRP XML取り込みで多く入る）へ偏りうる。全体を1つの数字にまとめると平均に埋もれるので層別で見ること
- **実測（2026-08-29、163ペア。jRCT 43ペアを追加）**: 全体35.6%（58/163）、層別で ctgov 17.5% / isrctn 23.3% / umin 25.0% / other 6.7% / **jrct 86.0%**（Issue #119 の閾値では全体・jrct単独とも `build_it`）。既存4層の数値は2026-08-28の120ペア測定と完全に一致（再現性の裏付け）。**jrctが突出して悪く、取りこぼし37件中34件が候補0件**。原因はjRCT IDがPubMedにほぼ索引されていないこと（`jRCT*[si]` 52件 vs `UMIN*[si]` 1,823件・`ISRCTN*[si]` 11,143件）。**jRCTレコードは43件中34件（79%）が「他の登録機関でのID番号」を申告しており、それを探索キーに加えるとjrctの取りこぼしが86.0%→39.5%まで下がる**（効くのはNCT副登録番号のみ〈取りこぼし9.5%〉。UMIN副登録番号は77.8%・JapicCTI副登録番号は100%取りこぼしで役に立たない）。詳細は `experiments/registry-linkage/FINDINGS.md` を参照
- **取りこぼし率35.6%は額面どおり受け取れない**: 163ペア全体の取りこぼし58件のうち、候補を1件も返せなかったのは38件（163ペア中23.3%）だけで、層別内訳はjrct 34 / isrctn 2 / umin 1 / other 1。**候補0件はほぼ全部jrct**であり、残る20件は候補は返したが1対1照合の正解論文と一致しなかったもの（同一試験の別の論文を返している例が多く、この照合方式では成功も取りこぼしに数える）。非jrct層では従来どおり「候補は出るが別論文」が取りこぼしの主体
- **戦略3（europepmc）の寄与は小さい**（単独で当てたのは105件中6件、候補を1件でも出したのは163ペア中26ペア。ただしjrct層に限れば発見6件のうち2件が戦略3）
- **副登録番号を第2の検索キーにする（Issue #134）**。主IDの3戦略が**生の候補を1件も返さなかったときだけ**、registration行が持つ副登録番号（他の登録機関でのID番号）で同じ3戦略をもう一巡する。判定は `dedupePublicationCandidates()` / `filterAlreadyImportedCandidates()` を通す**前**の件数で行う。取り出しは `src/lib/registry-record.ts` の `extractSecondaryTrialIds()`。`parseRegistryFieldsFromAbstract()` の結果を入力にする。**ラベル名ではなく登録番号のパターンで拾う。** ICTRP XML の副登録番号の要素名はレジストリごとに違い、このリポジトリでは実物（サンプルXML・テストフィクスチャ）を確認できていないため、ラベル決め打ちだと動かないリスクが高い。拾うパターンは `NCT\d{8}` / `ISRCTN\d{8}` / `UMIN\d{9}` / `JapicCTI-?\d+` / `jRCT(?:[a-z]\d{9}|\d{10})`。**jRCT IDは2形態ある**（種別文字ありなら数字9桁 `jRCTs011180014`、無しなら10桁 `jRCT2080223886`）。`C\d{9}`（UMIN-CTRの旧採番）は誤マッチのリスクが高く、実測でjRCTが申告していたUMIN番号は全件 `UMIN` 接頭辞付きだったため対象外にしている。自分自身の試験IDは除外し、上限3件で打ち切る（リクエストが青天井に増えるのを防ぐため）。副登録番号がNCTのときだけ `DiscoverPublicationCandidatesOptions.fetchCtgPmids` を呼んで戦略1（`ctgov_reference`）を使えるようにする（**ゲートが発火しなければ一度も呼ばれない遅延取得**）。副登録番号由来の候補は `trialId` にその副登録番号を入れる。`Publication_Candidates` の列を増やさずに「どのキーで見つけたか」を追えるようにするため（`candidate.trial_id` は `publication-candidates.ts` が書き込むだけでロジックからは読まれておらず、References行の `source` は発見元行から `extractTrialId()` するので影響しない）。`strategy` の新しい値は追加していない。**実測（Issue #131、jRCT 43ペア）**: 主IDのみだと取りこぼし **86.0%**、副登録番号を併用すると、**この実装（ゲート有り）では 44.2%**（発見 24/43。出荷コードを実ネットワークで43件へ流して実測。うち18件が副登録番号で当たり、ゲートが発火したのは 21/43、`fetchCtgPmids` の呼び出しは20回）。**ゲートを外せば 39.5%**（発見 26/43）まで下がるが、そのぶん副登録番号の探索が全件で走る。差の2件は、主IDで europepmc が別論文を1件返したせいでゲートが止まった `jRCTs061180082` / `jRCTs071180037`。**「86.0% → 39.5%」と書くとゲート無しの上限値を実装の成績として誤読させるので、実装の数字は 44.2% と書くこと**。追加リクエストが発生するのは主IDで候補0件だったペアだけ（測定時点で163ペア中38件＝23%）。効くのは**NCT副登録番号**（21件中19件を戦略1が当てる、取りこぼし9.5%）で、UMIN副登録番号は77.8%・JapicCTI副登録番号は100%取りこぼしだが、実行コストは同じなので種別で分岐はしていない
- 戦略1・2で集めたPMIDの書誌（title/journal/year/doi）は esummary に**1リクエストでまとめて**問い合わせる（PMIDごとに呼ばない）。esearch → esummary の eutils連続呼び出しの間だけ待機を入れる（既定350ms、テストでは`options.delayMs`で注入可能）。esearch/esummaryには `src/lib/fulltext-retriever.ts` の `enrichNcbiIds()` と同じ流儀で `tool: 'tiab-review-plugin'` と（`DiscoverPublicationCandidatesInput.email` が渡されていれば）`email` を申告する（NCBIのE-utilities利用規約）
- 各戦略の失敗（ネットワーク・非200・JSON不正）は例外を投げずその戦略だけスキップする。全滅時は空配列。出版年（`pubYear`/`pubdate`）が非数値の場合は `NaN` ではなく `undefined` にする（シートへ文字列 `"NaN"` を書かないため）
- 統合順は戦略の強い順（`ctgov_reference` → `pubmed_id` → `europepmc`）。`dedupePublicationCandidates()` は候補ごとにPMIDキーとDOIキーの**両方**を見て、どちらか一方でも既出なら重複として捨てる（esummaryでPMIDのみの候補へ後からDOIが補完されることがあるため、片方のキーだけでは同一論文を見逃す）。複数戦略で見つかった場合は先に見つかった側（＝より強い戦略）を残す。続けて `filterAlreadyImportedCandidates()` が既存References行のPMID/DOIと一致する候補を除外する
- CTGov の `referencesModule` 由来PMIDは、`retrieveRegistrationSnapshot()`（フルテキスト取得）が既に `fetchCtgStudy()` で取得済みのものを `FulltextFetchOutcome` の任意フィールド `registryPmids`（`cached`/`linked` のみ。`none` には無い）に載せて渡す。**CTG APIをスナップショット取得と論文候補探索で2回叩かないための配線**
- 呼び出し側は `src/sidepanel/features/fulltext/tab.ts` の一括検索（`handleBulkFetch`）・単発検索（`handleSingleFetch`）。`isRegistrationRecord(ref)` が true の行についてのみ探索する（email には `state.userEmail` を渡す）。UI文言・バッジ・完了サマリは変更していない
  - **一括検索は候補を`savePublicationCandidates()`へ即時保存しない**。registration行1件ごとに保存すると「ensure→全行読み取り→append」がそのまま行数倍のリクエストになり、Sheets APIの読み取りクォータ（ユーザーあたり毎分60読み取り）を容易に超える。既存の `pendingWrites`/`flush()`（fulltext_urlの5件ごとバッチ書き込み）と同じ流儀で `pendingCandidates` をため込み、`flush()` の中でまとめて `savePublicationCandidates()` を呼ぶ。URL書き込みと候補保存は互いに独立した try/catch を持ち、片方の失敗がもう片方を巻き込まない
  - `fulltext_url` の書き込み（`pendingWrites.push()` / `updateReferenceFulltextUrl()`）は、論文候補探索（最大3回のネットワーク往復）より**先に**行う。探索が遅くても本質的なURL保存が後回しにならないようにするため
  - 単発検索（`handleSingleFetch`）は1行だけなので `savePublicationCandidates()` を即時呼び出す（失敗は独立した try/catch で `console.warn` のみ）
- **候補探索は取得状態（`fulltext_status`）から独立して何度でも再実行できる**（PR #122 レビュー指摘2、Issue #118 チャンク2）。`handleBulkFetch`（取得）の中でしか探索が走らない設計だと、registration行はスナップショット保存に成功した時点で `cached` になり二度と対象にならないため、PubMed等の一時障害やSheets書き込み失敗で候補が欠落するとUIから回復する手段が無くなる。対策として `features/fulltext/tab.ts` に `handleBulkSuggest()`（一括再探索）を独立ルーチンとして追加した:
  - 対象は `getVisibleFulltextCandidateList()` のうち `isRegistrationRecord(ref)` が true の行**全部**。`fulltext_status` は一切見ない（`cached`/`retrieved`/`unavailable`/`not_retrieved` のいずれでも対象）
  - **「候補行が既にあるか」で探索済みを推測する実装にはしていない**（未探索／候補0件／探索失敗を区別できず、候補0件の登録が永久に対象へ残り押すたびに外部APIを叩き続けることになるため）。代わりにユーザーが押したときだけ走る明示的な導線にし、`savePublicationCandidates()` の `filterNewCandidates()`（同一 `ref_id` かつ同一PMID/DOIの候補を除外）による冪等性を根拠に「何度再実行しても Publication_Candidates に重複行が増えない＝安全に繰り返せる」としている
  - NCTのときだけ `fetchCtgStudy()` を1回呼ぶ（取得時の `outcome.registryPmids` が手元に無い独立経路のため自前で取得する。既存の「取得と探索でCTG APIを2回叩かない」配線＝`retrieveRegistrationSnapshot()` → `outcome.registryPmids` は変更していない）。失敗時（`null`）は `ctgPmids: []` で続行する
  - `handleBulkFetch` と同じ `bulkRun` ガード・中止ボタンを共有するため、取得と再探索は同時に走らない
  - NCT判定・CTG呼び出し可否・`discoverPublicationCandidates()` 呼び出しの結合部分は `src/lib/publication-candidate-rerun.ts` の `discoverCandidatesForRerun()`（UI非依存の純関数、fetchCtg/discoverCandidatesを引数注入してテスト可能）に切り出している
  - 起動導線は `sidepanel.html` の `.fulltext-fetch-row` にあるボタン `#fulltext-suggest-btn`（`dom.ts` では `dom.fulltextSuggestBtn`。`getElement()` は要素が無いと例外を投げるため `sidepanel.html` に必ず存在させている）。`renderRetrievalSummary()` が registration行の件数でラベル（`fulltext_suggestBtn`）を更新し、件数0なら `hidden`、`bulkRun` 実行中（取得・再探索のどちらでも）は `disabled` にする。i18nキーは `fulltext_suggestBtn`/`fulltext_suggestProgress`/`fulltext_suggestDone`/`fulltext_candidateSaveError` の4本を追加した（ja/en両方）。候補そのものの表示・バッジ・取り込みはチャンク3のスコープのままで、このPRで足したUIは探索を起動するボタン1つだけ
- **保存失敗時にバッファを捨てない**（PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点））。以前の `handleBulkFetch` の `flush()` は `pendingCandidates.splice(0)` してから保存していたため、保存失敗の瞬間にバッファごと候補が消え `console.warn` にしか残らなかった。`src/lib/publication-candidate-rerun.ts` の `flushCandidateBuffer()`（コピーを渡して保存 → 成功時のみ `splice` で取り除く汎用ヘルパー）に統一し、`handleBulkFetch`・`handleBulkSuggest` の両方で使う。失敗時はバッファを保持し次のflush（5件ごと or 最終）で再送する。ただし `handleBulkSuggest` 側は閾値を5固定にすると、失敗でバッファが保持されたままになる都合で以降のループが毎行flushを呼び直してしまう（Sheetsが落ちている間、1行につき1回ずつ ensure→読み取り→append を空振りさせることになる）。そのため次の閾値を `nextCandidateFlushThreshold()`（成功なら基準値5、失敗なら「現在のバッファ長+5」を返す純関数）で決め、失敗したらさらに5件たまるまで再試行しない。ループ終了時の最終flushでも失敗して候補が残っている場合は `console.warn` だけで終わらせず `showToast()`（`fulltext_candidateSaveError`）で未保存件数を通知する。`pendingWrites`（`fulltext_url` の書き込み）側の挙動は変えていない（既に別try/catchでトーストを出している）
- 永続化は `src/lib/sheets/publication-candidates.ts` の `savePublicationCandidates()`。ensure → 既存行を読んで（`ensurePublicationCandidatesSheet()` を再度呼ばない内部専用の読み取りヘルパー経由）`filterNewCandidates()`（同一 `ref_id` かつ同一PMID/DOIの候補を除外）→ 残りを追記。**一括検索を2回流しても行が重複しない**ことがこのフィルタの目的。`getPublicationCandidates()`（チャンク3向けの公開読み取りAPI）は ensure してから読む従来どおりの実装のまま
- `Publication_Candidates` タブのヘッダー（この順）:

  | 列名 | 説明 |
  | --- | --- |
  | candidate_id | 候補ID（UUID） |
  | ref_id | 発見元のregistration行（References への FK） |
  | trial_id | `extractTrialId()` で取れた試験ID |
  | pmid | 候補論文のPMID（無ければ空） |
  | doi | 候補論文のDOI（無ければ空） |
  | title | 候補論文のタイトル |
  | journal | 候補論文のジャーナル名 |
  | year | 候補論文の出版年 |
  | strategy | `ctgov_reference` / `pubmed_id` / `europepmc`（詳細は表の下） |
  | status | `suggested` / `imported` / `dismissed`。`imported`/`dismissed` への更新は `publication-candidates.ts` の `updatePublicationCandidateStatus()`（チャンク3）が担う |
  | suggested_at | 発見日時（ISO 8601） |
  | decided_by | 決定者（email）。`updatePublicationCandidateStatus()` が書く（チャンク3） |
  | decided_at | 決定日時（ISO 8601）。同上 |
  | imported_ref_id | 取り込んで新規作成したReferences行の `ref_id`（`imported` のときのみ）。同上 |

  **`strategy` 列の想定外の値への備え**: `readPublicationCandidatesRows()`（`publication-candidates.ts`）はこの列を `value as PublicationCandidateStrategy` と無検証キャストで読むため、ユーザーがセルを直接編集/削除すると想定外の値が入りうる。`publication-candidate-panel.ts` の `STRATEGY_ORDER` 参照（並び替え用）と `publicationCandidateStrategyLabelKey()`（表示ラベル用）はどちらもこれに備えたフォールバックを持つ: 前者は未知の戦略を `Number.MAX_SAFE_INTEGER` 扱いにして末尾へ寄せる（素の `undefined - undefined` はNaNになりsortの結果が実装依存になるため）、後者は `pubCandidate_strategyUnknown` を返す（default分岐が無いとundefinedを返しUIに文字列"undefined"がそのまま出る）。PR #124 レビュー指摘4

- **タブ欠落時の自動作成・列欠落時の末尾追記は `ensurePublicationCandidatesSheet()` が担う。`ensureLlmRunsSheet()` と完全に同じ ensure パターン**（ヘッダー欠落は末尾へ追記、タブ欠落は `addSheet` → ヘッダー append、それ以外の例外は再送出）
- **列は末尾追記のみ**の規約（References/Decisions/LLM_Executions と同趣旨）。新しい列は必ず配列の末尾に足し、`src/demo/seed.ts` の `PUBLICATION_CANDIDATES_HEADERS` ミラーも必ず追従させること（`tests/publication-candidates-headers.test.ts` がドリフトを検出する）
- ステータス更新（`imported` / `dismissed`）・候補のReferencesへの取り込みはチャンク3で実装済み（`src/lib/publication-import.ts` / `src/lib/publication-candidate-panel.ts` / `src/sidepanel/features/fulltext/publication-candidates.ts`。下記「論文候補の取り込み（Referencesへの追加）」参照）

### 書誌重複の検出とレビュー（Duplicate_Candidates タブ）

取り込み時にスキップしなかった重複候補ペア（正規化タイトル一致、source が不一致な試験ID一致）を、人が「統合する／別々の文献だ」を決めるまで記憶しておくタブ（Issue #145 チャンク2）。検出そのものの設計判断（自動スキップを絞る理由、PMID/DOI/試験ID/タイトルの4本キーを和集合で見る方式）は上記データ設計の総論を参照。**検出結果を実際にここへ流す配線と、ペアを見比べて決めるレビューUIはチャンク3（Issue #147）で実装済み。** 純関数層は `src/lib/duplicate-review.ts`、UI層は `src/sidepanel/features/duplicate-review.ts`（設計判断は下記）。

- 検出ロジックは `src/lib/duplicate-detect.ts`（UI非依存の純関数）。`buildMatchKeys()` が1件の Reference から pmid/trialId/doi/title の4本のキーを作り（`normalizeDoi()` は `^10\.\d{4,9}/` で検証済みのDOIのみ、DOIの接頭辞剥がし自体は `src/lib/doi.ts` の `stripDoiPrefix()` に委譲する）、どれか一つでも既出なら一致とみなす和集合方式を取る。取り込み時フィルタ本体（`partitionIncomingReferences()`、自動スキップとレビュー候補の振り分け）は `src/lib/duplicate-import-filter.ts`
- `Duplicate_Candidates` タブのヘッダー（この順、`DUPLICATE_CANDIDATES_HEADERS`）:

  | 列名 | 説明 |
  | --- | --- |
  | candidate_id | 候補ID（UUID） |
  | ref_id_a | 先に存在していた側の ref_id |
  | ref_id_b | 後から来た側の ref_id |
  | match_type | `pmid` / `doi` / `trialId` / `title`（`DuplicateMatchType`。一致したキーの種別） |
  | match_key | 一致したキーの値（正規化後） |
  | status | `suggested`（検出直後、未決）/ `merged`（どちらかを残すと決めた。`kept_ref_id` に残す側の ref_id が入る）/ `dismissed`（「別々の文献だ」と決めた。再スキャンでも二度と提示しない） |
  | suggested_at | 検出日時（ISO 8601） |
  | decided_by | 決定者（email）。`updateDuplicateCandidateStatus()`（チャンク3、Issue #147で配線済み。呼び出し元は `src/sidepanel/features/duplicate-review.ts`）が書く |
  | decided_at | 決定日時（ISO 8601）。同上 |
  | kept_ref_id | 残す側の ref_id（`status: 'merged'` のときのみ埋まる）。同上 |

- **ペアキーは順序非依存**: `normalizePairKey()`（`duplicate-detect.ts`）が2つの ref_id を辞書順にソートしてから連結するため、`ref_id_a`/`ref_id_b` の向きが逆でも同じペアとして扱える。同じ試験・同じ論文の組が「Aから見てB」「Bから見てA」の両方向で検出されても二重登録されない
- **冪等フィルタ `filterNewDuplicatePairs()`**（`duplicate-detect.ts`）は `saveDuplicateCandidates()` が保存直前に使う。`Publication_Candidates` の `filterNewCandidates()` との違いは、キーが ref_id 1本ではなく「2つの ref_id の組」であること。`status` は見ない（`dismissed`/`merged` になった組も既出として弾く。一度決着した組を再スキャンのたびに再提示しないことがこの関数の存在理由そのもの）
- 6点セットの永続化関数（`src/lib/sheets/duplicate-candidates.ts`、`Publication_Candidates` 系と同型）: `ensureDuplicateCandidatesSheet()`（タブ欠落時の自動作成・列欠落時の末尾追記）/ `migrateDuplicateCandidatesHeaderColumns()`（ヘッダー不足列の末尾追記。ensure 経路と読み取り経路の共有ロジック）/ `readDuplicateCandidatesRows()`（内部専用の読み取り。シート全列を読み、自分が読んだ全幅ヘッダー行で不足列の追記 PUT も行う）/ `saveDuplicateCandidates()`（ensure → 既存行読み取り → `filterNewDuplicatePairs()` → 追記）/ `getDuplicateCandidates()`（チャンク3向けの公開読み取りAPI。まず読む→範囲エラー（`isSheetMissingError()`）時だけ ensure して読み直す。**例外を握りつぶさずそのまま投げる**。`getPublicationCandidates()` とは流儀が違う。0件と取得失敗を呼び出し元が区別できないと、レビューUIが「未確認候補0件」という事実と異なる表示をキャッシュ経由で出し続けるため。Issue #147 外部レビュー指摘）/ `updateDuplicateCandidateStatus()`（`status`/`decided_by`/`decided_at`/`kept_ref_id` の更新）
- **列は末尾追記のみ**の規約（References/Decisions/LLM_Executions/Publication_Candidates と同趣旨）。新しい列は必ず配列の末尾に足し、`src/demo/seed.ts` の `DUPLICATE_CANDIDATES_HEADERS` ミラーも必ず追従させること

**レビューUIの設計判断（チャンク3、Issue #147）**:

- **純関数層とUI層の分離**: 計算ロジックは `src/lib/duplicate-review.ts`（`resolveSurvivor()` / `diffReferenceFields()` / `scanReferencesForDuplicatePairs()` / `isAutoApplicableCandidate()` / `isPairAlreadySettled()` / `arePairRefsMutuallyDeleted()` / `chooseMutualDeletionSurvivor()` / `chooseKeptRefId()` / `planBulkApply()`。テストは `tests/duplicate-review.test.ts`）に置き、DOM/state に依存するUIは `src/sidepanel/features/duplicate-review.ts` に分離した。`fulltext-consensus.ts` / `prisma-identification.ts` と同じ方針
- **論理削除済みの相手を辿り直す**: `partitionIncomingReferences()` が既存インデックスに論理削除済みの行も含めている帰結として、候補の相手が論理削除済みの行になることがある。`resolveSurvivor()` が `duplicate_of` を辿って「残っている側」を返す。循環・参照先欠落・深さ上限（100 hops）は `broken` として返し、UIは壊れたペアを黙って隠さず「左を残す」「右を残す」だけ無効化して「別々の文献」は残す（後者は `Duplicate_Candidates` タブしか触らないため安全に実行でき、これが無いと壊れたペアがアプリ内から永久に片付けられなくなる。`deleteReferencesBySourceFile()` は行を物理削除するため、この状態は実際に作れる）
- **書き込み順序は `setDuplicateOf()` → `updateDuplicateCandidateStatus()` で固定**。逆にすると、候補は決着済みなのに References の行が生きている＝重複除去が黙って失われる状態を作りうる。この順序なら後者が失敗しても行は正しく除外済みで、次回 `isPairAlreadySettled()` が survivor の収束として検出できる。後者だけ失敗したときは「除外は適用したが候補の記録更新に失敗した」旨を事実どおり表示する
- **適用の直前に読み直す**: References・Duplicate_Candidates・Decisions をボタン押下時点で再取得し、`isPairAlreadySettled()` が true なら書き込まずスキップして「他のレビュアーが処理済み」と表示する（`features/fulltext/publication-candidates.ts` の `handleImportCandidate()` と同じ理由の前例に倣う）。警告に使う判定件数も再取得したものを使う（描画時点の値を使うと、モーダルを開いたまま他のレビュアーが判定を付けた場合に警告が出ない）。加えて、`setDuplicateOf()` 呼び出し直前に**残す側（keepRefId）が fresh なデータで既に論理削除されていないか**も見る。既に削除済みなら書き込まない（「消された行を指す duplicate_of」を新たに作ってしまうため。Issue #147 外部レビュー指摘）
- **同時更新はロック機構で防がず、書き込み後の再検証と決定的修復で収束させる**（Issue #147 外部レビュー指摘）: Google Sheets の values API には条件付き更新（CAS）が無く、クライアント間の真の排他制御・書き込みの直列化は実装できない。2人のレビュアーが同じ組を同時に開き、一方が「左を残す」、他方が「右を残す」を選ぶと、両者とも `suggested` を読んだ後に書き込めてしまい、`duplicate_of[A]=B` と `duplicate_of[B]=A` が並ぶ（相互削除）。`isLogicallyDeleted()` が両方 true になり、その文献がレビューから丸ごと消える。
  - **`isPairAlreadySettled()` は `arePairRefsMutuallyDeleted()` を `status` の短絡より前に見る**。相互削除を `merged`/`dismissed` 扱いで覆い隠すと、二度と修復のきっかけが無くなるため。`resolveSurvivor()` の `broken` 全般（物理削除・循環等）は対象にしない（`dismissed` 済みの無関係な組まで毎回蒸し返してしまうため）。相互に指し合っている状態だけに絞って検出し、既存の broken 表示経路にそのまま乗せて人に見せる
  - `applyPairDecision()` は `setDuplicateOf()` 成功直後に References を読み直し、`arePairRefsMutuallyDeleted()` が true なら `chooseMutualDeletionSurvivor()`（ref_id の辞書順のみで決める。競合した両クライアントが同じ答えを計算できることが唯一の要件）で生存者を決め、生存者の `duplicate_of` を空に戻しつつ相手側を生存者へ書き直す。修復したこと・修復自体が失敗したことは両方トーストで知らせる（黙って直さない）
- **判定件数の表示はブラインド配慮で集計値のみ**: レビュアー名・判定値は出さない。警告・一括適用の判断に使うのは「総数 − AI判定数」（AI判定は `isLlmDecision()` / `isMlDecision()`）。`client_version` が空の古い行はAIと判定できないため人の判定として数える（意図した安全側の倒し方）。`decision` が `'pending'` または空の行は未判定として数えない（`decision-summary.ts` の `buildReviewerDecisionMap()` と同じ扱い）
- **一括適用は連結成分単位で解決する（`planBulkApply()`）**（Issue #147 外部レビュー指摘。旧実装は候補ごとに独立して `chooseKeptRefId()` を呼んでいた）: `scanReferencesForDuplicatePairs()` は設計としてバケット先頭と各後続をペアにするため、同一DOIの3件 A/B/C からは A–B と A–C の2ペアが出る（C(n,2) を避けるための意図的な設計）。候補ごとに独立して残す側を決めて全更新をそのまま `setDuplicateOf()` へ渡すと、非AI判定数が A=0/B=1/C=2 のとき `duplicate_of[A]` へ B と C を続けて書き込むことになり、`updateReferenceColumnByRefId()`（ref_id で重複排除しない）が後勝ちで片方を失ううえ、両候補が `merged` になって `filterNewDuplicatePairs()` が二度と再提示しないため B–C の真の重複が恒久的に見えなくなる。`planBulkApply()` は対象候補を Union-Find で連結成分にまとめ、成分ごとに生存者を1件だけ決め、**各 ref_id を最大1回だけ更新する**。生存者の決定規則は上から順に適用: 1. 非AI判定数が最も多いもの / 2. 同数ならその成分の辺の中で `refIdA` として現れた回数が多いもの（＝先に存在していた側） / 3. なお同数なら ref_id の辞書順で最小のもの。2件だけの成分（判定数同数）では `chooseKeptRefId()` の「同数なら `refIdA`」と同じ結果になる（`chooseKeptRefId()` 自体は個別レビューの「左を残す/右を残す」用に残っている）
- **`isAutoApplicableCandidate()` は source 一致を `Duplicate_Candidates` の列に持たない**。source は References 側の値なので適用時点で引き直せば足り、スキーマ変更を避けた
- **導線は2つ**: 取り込み直後のモーダル（`handleRISImport()` が `saveDuplicateCandidates()` の後に呼ぶ。未確認の候補が0件なら開かない）と、TiAbスクリーニング画面の独立セクション（`renderSourceFilters()` の冒頭で `renderDuplicateReviewSection()` を呼ぶ。`sourceFiles` が0件でも出す必要があるため早期returnより前）。セクションは `sidepanel.html` を触らず `dom.sourceFiltersSection` の直前へ動的に挿入する
- **「あとでまとめて確認」**: 押すとセッション中は取り込み直後の自動モーダルを出さなくなり、どこから再開できるかを必ず案内する（連続インポート中にレビューを強制しないため）。セクションのボタンからの明示操作はフラグに関係なく必ず開く
- **再スキャン**: `scanReferencesForDuplicatePairs()` が References 全件を対象に4本のキーでバケットを作り、バケット内の2件目以降を先頭とペアにする（全組み合わせ C(n,2) にしない。n が大きいと件数が爆発してレビューが実用にならない）。既出の組の除外は `saveDuplicateCandidates()` 内部の `filterNewDuplicatePairs()` に任せる。新規0件でも必ずトーストを1行出す
- **モーダルの一度の描画上限は50組**。超過分は「残りは片付けると出る」旨を案内する（1組につき10行の比較テーブルを作るため、数百組を一度に描くと狭いサイドパネルで重くなる）
- **`normalizeSource()` は `duplicate-detect.ts` に一元化**（trim + 小文字化）。取り込み時のtrialId自動スキップ判定とレビューUIの自動適用判定が同じ正規化を使う必要があるため。`isLogicallyDeleted()` と同じ理由で、呼び出し元ごとのコピーを作らない
- **`src/sidepanel/` 配下は Web版（`docs/app/`）にも入る**ため、このUIモジュールは `chrome.*` API を一切使わない。Web版では `initModal()` が呼ばれず ✕ ボタンが未配線のため、モーダルのフッターには自前の閉じるボタンを置き `hideModal()` を直接呼ぶ
- **`setDuplicateReviewDeps()` は `bootstrap.ts` の `bootstrapCommon()` から呼ぶ**（拡張版 `sidepanel.ts` 単体からではない。Issue #147 外部レビュー指摘）: このUIは `bootstrap.ts` → `screening/filters.ts` → `duplicate-review.ts` の連鎖でWeb版バンドル（`docs/app/`）にも入るため、拡張版エントリだけで依存注入すると Web版では `deps` が `null` のまま残り、統合・一括適用のたびに `dupReview_depsMissing`（「この画面では自動反映できません」）が出て一覧が更新されない。すぐ隣の `screeningFilters.setFilterDependencies({ loadDataAndShowScreening: project.loadDataAndShowScreening })` と全く同じ依存を渡すだけなので並べて置く。`src/webapp/index.ts` には足さない（拡張専用機能を import しない方針で意図的に最小化されているファイルのため）
- **取り込み直後のセクション件数キャッシュを無効化する**（Issue #147 外部レビュー指摘）: `handleRISImport()`（`import-export.ts`）が `saveDuplicateCandidates()` 成功直後に、export した `invalidatePendingCountAndRerenderSection()` を呼ぶ。初回ロードで0件が一度キャッシュされると `pendingCount === null` ガードにより以後どのボタンも押さない限り古い値のまま固定される。`openDuplicateReviewModal({ fromImport: true })` は未確認候補が0件だとモーダルを出さないため、モーダル任せにせず保存成功時に必ず呼ぶ（保存失敗時は呼ばない。古い値のほうがまだましなため）
- **比較テーブルの差異判定は空白を正規化してから比較する**（`diffReferenceFields()` 内の `normalizeForDiff()`。Issue #147 外部レビュー指摘）: PubMed の `.nbib` は継続行結合（`parseRIS()`）で二重スペースを作るため、raw値を trim しただけの比較だと字句的に同一のタイトルでも常に `differs: true` になり比較テーブルのハイライトが機能しなくなる。表示に使う `valueA`/`valueB` は raw のまま返し、`differs` の判定にだけ `\s+` → 半角スペース1個の正規化を適用する。マッチング側（`duplicate-detect.ts` の `normalizeTitle()`）は既に空白を潰しているため影響しない。パーサ（`parseRIS()`）側は影響範囲が広いため触らない
- **相互削除ペアの手動回復（「修復する」ボタン）**（Issue #147）: `arePairRefsMutuallyDeleted()` が true の broken ペアに限り出す。生存者決定・書き込みは `repairMutualDeletion()`（`applyPairDecision()` の書き込み直後の自動修復と共有。二重実装しない）が担い、押す前に References を再読み込みして既に修復済みでないかを確認する。物理削除等、相互削除でない通常の broken には出さない（生存者を安全に決められないため）
- **`applyPairDecision()` の `deps.reloadAfterApply()` は個別の try/catch で包む**（Issue #147 外部レビュー指摘）: 外側の catch-all にそのまま流すと、`setDuplicateOf()`/`updateDuplicateCandidateStatus()` 自体は成功しているのに `dupReview_refreshError`（「候補データの取得に失敗しました」）という事実と異なる文言が出てしまう。専用の `dupReview_reloadAfterApplyFailed` を出す

### 論文候補の取り込み（Referencesへの追加）

候補（`Publication_Candidates` の1行）をReferencesへ実際に取り込む処理（レジストリ連携フェーズ1チャンク3、Issue #118 実装内容7・8）。**References に行が追加される経路は、`src/sidepanel/features/fulltext/publication-candidates.ts` の「取り込む」ボタン（`handleImportCandidate()`）だけ。** 一括検索・再探索・自動処理からは1行も追加しない（探索パス側の制約は上記「試験登録レコードの論文候補探索」参照）。

- 行の組み立ては `src/lib/publication-import.ts` の `buildImportedPublicationReference()`（UI非依存の純関数。`crypto.randomUUID()`/`new Date()` は呼ばず、呼び出し側から `refId`/`importedAt` を注入する）が担う。`record_type='article'`（確定値）、`related_ref_id`＝発見元registration行の `ref_id`、`source`＝`Registry linkage (試験ID)` 形式（試験IDは registrationRef から `extractTrialId()` で取る。取れない場合は `buildRegistrySnapshotHtml()` の「(不明)」表記に合わせて `Registry linkage (不明)` とする）、`dedupe_key` は `import-helpers.ts` の `generateDedupeKey()` をそのまま使う（重複実装しない）。`url` は `src/lib/external-record-url.ts` の `buildDoiUrl()`/`buildPubmedUrl()` で組み立てる（doi優先→pmid→どちらも無ければ空文字。`features/fulltext/tab.ts` の `recordPageUrl()` と同じ規則を再利用しており、あちらもこの2関数を呼ぶ薄いラッパーに切り出し済み）。`screening_set` は発見元registration行の `screening_set` を担当割り振りの状態で分岐せず無条件でコピーする（空でコピーすると担当割り振り済みプロジェクトで `getReferenceAssignmentSet()` が `'unassigned'` と解決し、非管理者の `state.references` から取り込み行が丸ごと落ちるため。PR #124 レビュー指摘1）
  - **この `screening_set` コピーの帰結（ユーザーが明示的に選んだ設計）**: 取り込んだ論文行は発見元registration行と**同じ担当グループのTiAbスクリーニングキューに未判定として並ぶ**。`src/lib/team-progress.ts` の `computeTeamProgress()` は `refs.filter((r) => assigned.has(refSetOf(r)))` で各メンバーの `tiabTotal`（TiAb分母）を数えるため、**そのグループの担当者のTiAb分母が取り込み件数だけ増え**、誰かが実際にTiAb判定するまで未消化のまま残る。検討した代替案は「`screening_set` を空（`unassigned`）のままにし、代わりに `related_ref_id` 非空の行を担当フィルタの対象外にする」というものだった。`unassigned` は既に「誰の担当セットでもない＝進捗の分母にも入らない」と定義されている（`src/sidepanel/features/assignment.ts` の `describeSetReviewers()` 参照）ためTiAb分母は動かないが、担当フィルタの意味論に例外（「`unassigned` だが表示だけはされる」）を持ち込むことになる。**前者（無条件コピー）を採用したのはユーザーの明示的な選択であり、「取り込んだ論文も人がTiAb判定すべき対象である」という判断に基づく。** `fulltext_set` を `resolveImportedFulltextSet()` でコピーしている既存実装（次の箇条書き）とも対称的な設計
- 取り込み後、担当割り振りが `configured` のときだけ registration行の `fulltext_set` を新規行へコピーする。コピーすべき値の判定は `src/lib/publication-import.ts` の `resolveImportedFulltextSet()`（純関数）に切り出してあり、実際の書き込み（`updateReferenceFulltextSets()`）は呼び出し側が行う
- `handleImportCandidate()` の実行順序:
  1. **重複チェック**: `state.allReferences`（担当フィルタ前の全件）を押した瞬間にもう一度見て、同一PMIDまたは同一DOIの行が既にあれば、Referencesへ行を追加せず候補を `dismissed` にして終了する（探索時点の `filterAlreadyImportedCandidates()` とは別に、探索から取り込みまでの間に References が変わりうるため、押した瞬間にもう一度見る必要がある）。担当フィルタ済みの `state.references` を見ると、非管理者が「他のレビュアーが既に取り込んだ論文」を検出できず二重取り込みしてしまう（PR #124 レビュー指摘2）。判定は `src/lib/publication-candidate-panel.ts` の `isPublicationCandidateAlreadyImported()` が `filterAlreadyImportedCandidates()`（`publication-suggest.ts`）を最小限のシム経由で再利用する（判定ロジックを独自実装しない）
  2. `crypto.randomUUID()`/`new Date().toISOString()` を呼び出し側で用意し `buildImportedPublicationReference()` へ注入 → `addReferences()` で1行追加
  3. `resolveImportedFulltextSet()` が非空を返すときだけ `updateReferenceFulltextSets()` で新規行の `fulltext_set` を書く（空文字を書きに行く無駄なリクエストは出さない）
  4. `updatePublicationCandidateStatus()`（`publication-candidates.ts`）で候補を `imported`/`decided_by`/`imported_ref_id` に更新
  5. `reloadReferences()`（`features/fulltext/ai.ts`）で state を更新
  6. 新規行に対して単発OA検索を自動起動する（`fetchSingleFulltextForRef()`。`handleSingleFetch()` からボタン要素前提の見た目更新を切り離して独立させた関数）。この関数は内部の catch で例外を握りつぶし正常returnするため、呼び出し側は戻り値（`Promise<boolean>`。成功=true）で失敗を検出する。取り込みフローからは `{ reloadCandidates: false, suppressErrorToast: true }` を渡し、内部の `fulltext_sheetSaveError` トーストを止めて、失敗を7の完了トーストへ一本化する（PR #124 レビュー指摘3。ボタン起点の `handleSingleFetch()` は options を渡さないため従来どおり内部トーストが出る）
  7. 候補キャッシュ（`features/fulltext/tab.ts` のモジュールローカルキャッシュ）を再読込・再描画する
- **部分失敗への備え**: 手順2（`addReferences`）が成功した直後に、候補ID→新規`ref_id`の対応を `features/fulltext/publication-candidates.ts` のモジュールローカルMap（`importedRefIdByCandidateId`）へ記録する。その後3〜6のいずれかが失敗して候補が `status='suggested'` のまま残っても、同じ候補へ再度「取り込む」を押されたときはこの記録を最優先で見て、`addReferences()` を呼び直さず（＝Referencesへの二重追加を避け）記録済みの `ref_id` で残りのステップだけをやり直す。4（ステータス更新）に成功すればこの記録は不要になり削除する。この記録が無い場合（例: ブラウザ再起動でモジュール状態が失われた）でも、1の重複チェックが References 上の同一PMID/DOIを検出するため二重追加そのものは常に防がれるが、その場合候補は `dismissed` として決着する（誰がいつ取り込んだ行か特定できず `imported_ref_id` を安全に紐付けられないため。行自体は失われない）
- **「ステータス更新(4)は成功したが fulltext_set 更新(3)が失敗した」場合には復旧導線が無い。** 候補は `imported` になりパネル・バッジから消えるため、UIから「担当グループが未設定のまま」に気付いて再操作する手段が構造的に無い。実害は `fulltext_set` が空のままになることに限られる（`related_ref_id` が非空のため、フルテキスト候補一覧・共有分母には引き続き載る＝候補自体を見失うわけではない。次の箇条書き参照）。管理者が手動で担当割り振りを再生成するか、シートを直接編集するしかない
- 完了トーストの「もう一度『取り込む』を押すと再試行できます」という案内は、それが実際に成り立つ場合（手順4のステータス更新自体が失敗して候補が `suggested` のまま残っている）だけに出す。手順4が成功して候補がパネルから消えるケースでは別の文言（再試行を促さない）を出す（`pubCandidate_importPartialRetryable` / `pubCandidate_importPartialNoRetry`）。多段階処理の完了メッセージを作るときは、それぞれの失敗パターンで案内の内容が実際に成り立つかを個別に確認すること（この教訓は「取り込む」経路だけでなく「対象外」経路にも及ぶ。下記 `handleDismissCandidate()` 参照。PR #124 レビュー指摘6ではこの教訓が「対象外」側に反映されておらず「取り込む」側だけ直っていた）
- 「対象外」ボタン（`handleDismissCandidate()`）は `updatePublicationCandidateStatus()` を `status='dismissed'` で呼ぶだけで References には一切触れないが、2点のガードを持つ:
  - **`importedRefIdByCandidateId` に記録がある候補は対象外にできない**（PR #124 レビュー指摘5）。上記「部分失敗への備え」の状態（`addReferences()` は成功したが手順4のステータス更新が失敗し候補が `suggested` のまま）でこのガードが無いまま「対象外」を押すと、`imported_ref_id` が空のまま `status='dismissed'` が書かれ、既に作られたReferences行を指す候補が消える。その行はPublication_Candidatesから辿れなくなる一方、`related_ref_id` は非空のためフルテキスト候補一覧・共有分母には載り続け孤児化する。記録があればシートへ書き込まずに中断し `pubCandidate_dismissBlockedAlreadyAdded` トーストで「取り込む」を押し直すよう促す
  - **ステータス更新と `reloadPublicationCandidates()` を別tryに分ける**（PR #124 レビュー指摘6）。1つのtryで包むと、書き込み自体は成功したのに再読込だけ失敗したケースでも `pubCandidate_dismissError`（「対象外への更新に失敗しました」）が出て事実と異なる報告になる。ステータス更新が成功したかを別フラグで持ち、再読込のみ失敗したときは `pubCandidate_dismissReloadFailed`（「対象外にしました（一覧の再読込に失敗しました）」）を出す。**この再読込失敗トーストの発火経路は後続ターンで実際に到達可能になった**: `features/fulltext/tab.ts` の `loadPublicationCandidates()` は当初、内部で自分のエラーを `console.warn` するだけで再送出しない実装だった（`createAsyncCoalescer` の factory 自身がtry/catchで握りつぶすため）ため呼び出し元から失敗を検出できなかったが、`Promise<void>` → `Promise<boolean>`（成功/読み込み不要=true、Sheets読み込み失敗=false）へ改め、`suppressErrorToast?: boolean`（既定false）オプションを追加した。既定では失敗時に自前で `fulltext_candidateLoadError` トーストを出すが、`handleDismissCandidate()` は `{ suppressErrorToast: true }` を渡してこれを止め、戻り値が `false` のときだけ `pubCandidate_dismissReloadFailed` を出す（try/catchによる検出から戻り値による検出へ変更）。`deps.reloadPublicationCandidates` の型もこれに合わせて `(options?: { suppressErrorToast?: boolean }) => Promise<boolean>` にした
- **`related_ref_id` が非空の行は無条件でフルテキスト候補になる**（実装内容9）。取り込んだ論文行はTiAb票を一切持たない（通常のTiAbスクリーニングを経ないため）ので、`fulltext_set`・プールルール・TiAb Include票のいずれで判定してもフルテキスト候補プールから落ちてしまう。`src/lib/fulltext-candidates.ts` の `isFulltextCandidateRef()` / `isProjectFulltextCandidateRef()` / `isSharedFulltextPoolMember()` はいずれも、`related_ref_id` が非空なら（poolRule評価より先に）無条件で候補として扱う分岐を持つ。`isSharedFulltextPoolMember()` はIssue本文が名指ししていない（他の2関数のみ名指し）が、「全員で一致すべき分母」という要件と矛盾しないため（`related_ref_id` の非空はユーザー非依存の属性）同じ扱いにした
  - **落とし穴（実際に踏んだ）**: 上記3関数の引数型は `ref: Pick<Reference, 'fulltext_set' | 'related_ref_id'>` のように `Reference` を絞り込んだ型を取る。チーム進捗集計用の `src/lib/team-progress.ts` の `TeamProgressRef`（`Reference` をさらに絞り込んだ最小形）が最初 `related_ref_id` を持っておらず、`src/sidepanel/features/team-progress.ts` 側で `ReferenceWithStatus` から `TeamProgressRef` を組み立てる2箇所が `related_ref_id` を運んでいなかった。`Pick<Reference, ...>` はoptional同士だと構造的に適合してしまうため、`related_ref_id` を落とした絞り込み型を渡してもtypecheckは通ってしまい（コンパイラはフィールドが無いことを検出できない）、`isSharedFulltextPoolMember()` の分岐は本番で一度も発火しなかった。詳細・一般化した教訓は下記「テスト・作業ツリーの落とし穴」参照

### EndNote XML インポートフィールドマッピング

EndNote 公式 DTD に準拠（`<source-app name="EndNote">` を含む XML）。各テキスト値は `<style face="..." font="..." size="...">value</style>` でラップされているが `Element.textContent` で取得する。

| XML 要素                            | References 列 | 備考                                                                                                          |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `titles > title`                  | title         | 必須                                                                                                          |
| `contributors > authors > author` | authors       | セミコロン区切りで結合（10名超は `et al.` を付与）                                                          |
| `dates > year`                    | year          | 年部分のみ抽出                                                                                                |
| `periodical > full-title`         | journal       | 第1優先                                                                                                       |
| `titles > secondary-title`        | journal       | `full-title` が無い場合のフォールバック                                                                     |
| `volume`                          | volume        | "6(2)" 形式の場合は volume="6", issue="2" に分離（Embase 経由のエクスポート対応）                             |
| `number`                          | issue         | 標準の EndNote エクスポートではこちらに号が入る。第1優先                                                      |
| `pages`                           | pages         |                                                                                                               |
| `isbn`                            | issn          | EndNote DTD は ISSN 専用フィールドを持たないため `<isbn>` に格納される。ISSN形式（XXXX-XXXX）の場合のみ採用 |
| `electronic-resource-num`         | doi           | 末尾の `[doi]` 等のサフィックスは除去                                                                       |
| `accession-num`                   | pmid          | `remote-database-name` が PubMed の場合のみ。Embase 等の場合は誤マッチ防止のため未設定                      |
| `urls > related-urls > url`       | url           | 最初の1件                                                                                                     |
| `abstract`                        | abstract      | 15,000 文字に制限                                                                                             |
| `remote-database-name`            | source        | 例: "Embase", "PubMed"。空なら "EndNote"                                                                      |

### オフライン同期の方針

- **キュー永続化**:
  - **小規模（100件未満）**: `chrome.storage.local` を使用（5MB制限）
  - **大規模**: IndexedDB を使用（容量制限なし）
- **キュー内の重複排除**: 送信前に同一 `ref_id` + `reviewer_id` + `screening_phase`（省略時 `tiab`）の未送信項目はキュー内で最新の1件へ置き換える（`decision_id` はDecisionsタブ追記専用化に伴い判定イベントごとに新規発番されるため、このキーで同一性を判定する。詳細は `src/sidepanel/utils/offline-queue.ts` の `upsertDecision`）
- **同期順序**: `decided_at` の昇順で送信し、失敗時は次回再試行
- **冪等性**: ML自動判定・LLM判定は既存行への upsert のため再送しても重複しない。human判定・ML手動確認判定は追記専用のため、内容が直前の保存と完全一致する場合のみ保存側のスナップショットキャッシュ（60秒TTL、詳細は `decisionContentCache`）で重複追記を防げる。それを超える間隔での再送（長時間オフライン後のflushなど、サーバ側の書き込み成功をクライアントが確認できずに再試行するケース）は重複行を生みうる既知のトレードオフ
- **flush の直列化**: `src/sidepanel/utils/offline-queue.ts` の `flushDecisionQueue` は queueKey（spreadsheetId::userEmail）ごとにコールセーサーで直列化する。flush 中に新たに `enqueueDecision` された項目は、書き戻し時にキューを再読込してから送信済み分だけを取り除く実装のため消えない。合流した呼び出しは同じ結果（最後の失敗 `lastError` を含む）を受け取るため、対話的flushとバックグラウンドflushが合流しても失敗種別がどちらの呼び出し元にも届く（PR #138 レビュー指摘対応）
- **読み込み時の反映**: `loadDataAndShowScreening`（`src/sidepanel/features/project.ts`）はサーバから取得した文献一覧に、`getQueuedDecisions` で読んだ未送信キューを `src/lib/queued-decisions-merge.ts` の `mergeQueuedDecisions`（純関数）で重ねてから画面へ渡す。オフラインキュー退避中の判定はサーバ側（Decisionsタブ）にまだ書き込まれていないため、これをしないと再読み込みのたびに「未評価」に戻って見えてしまう。読み込み時のマージは、キー開封後は `detectConflict`（`decision-aggregate.ts`。互換窓口 `sheets-api.ts` からも `export` 済み）で不一致状態（`hasConflict`/`status`）も再計算する（PR #138 レビュー指摘対応）
- **未送信バッジ**: `src/sidepanel/features/unsent-queue.ts` がツールバーの未送信件数バッジ（クリックで送信。認証切れなら対話的な再ログインを挟んで1回だけ再試行）と、判定保存の共通ロジック（`saveDecisionOrQueue`）を提供する。TiAb判定・ML確認判定の両方（`screening/actions.ts` / `ml/actions.ts`）がここへ委譲する
- **保存失敗の分類**: `src/lib/save-failure.ts` の `classifySaveFailure` が保存失敗を `'auth'`（ログイン切れ、再ログインで直る可能性がある）/ `'offline'` / `'other'`（権限不足等、再ログインでは直らない）に分類する。判定クリック直後の保存失敗が `'auth'` の場合はキューへ積む前にその場で再ログインを試し、成功すれば1回だけ保存を再試行する
- **2026-09 事故の要約**: Web版（GIS認証、トークンはメモリ上で1時間のみ）でログイン切れ後の判定保存が軒並みオフラインキューへ退避される一方、ユーザーはそれに気づかず判定を続け、退避先のブラウザプロファイルで264件が滞留した。加えて、この滞留を解消しようとした複数回の flush が並走し、60秒TTLのスナップショットキャッシュを超える間隔で同一判定が再送されたことで、197件が重複追記（393行）された。上記の直列化・画面反映・バッジ・分類はこの事故の再発防止として追加したもの

### エラーハンドリング

- **OAuth失効**: `chrome.storage.session` のトークンキャッシュを破棄し revoke した上で、サイレント `launchWebAuthFlow`（`prompt=none`）による再取得を促す。再ログイン促進、作業続行不可の明示、オフラインキューへ退避
- **権限不足**: 権限不足メッセージ＋シート共有設定への導線、読み取り専用モードへフォールバック
- **クォータ超過**: 指数バックオフ（初回1秒、最大32秒）でリトライ、手動再試行ボタン

### セキュリティガイドライン

- **トークンのサニタイズ**: ログ出力前に `token.substring(0, 8) + '...'` で省略
- **本番ビルド**: `console.log` を除去（webpack/esbuild の drop 設定）
- **ストレージ方針**: センシティブデータは可能な限りメモリ/セッションに置き、永続化が必要な場合は保存前にアプリ側で暗号化

### ローカルデータ管理

- **キャッシュクリア**: シート切り替え時に自動削除
- **ログイン切替**: emailごとに別ストレージキーで分離

## 型定義

```typescript
// types.ts

export interface Reference {
  ref_id: string;           // UUID
  title: string;
  abstract?: string;
  year?: number;
  authors?: string;
  journal?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  source?: string;
  imported_at?: string;     // ISO 8601
  imported_by?: string;     // email
  dedupe_key?: string;
}

export interface Decision {
  decision_id: string;      // UUID
  ref_id: string;
  reviewer_id: string;      // email
  decision: 'include' | 'exclude' | 'maybe';
  reason?: string;          // exclude時必須
  // labels?: string[];     // 廃止 (互換性のため残存するが使用しない)
  note?: string;
  decided_at: string;       // ISO 8601
  client_version?: string;
  source_url?: string;
}

export interface ReviewerState {
  email: string;
  spreadsheetId: string;
  lastSyncedAt?: string;
  offlineQueue: Decision[];
}

export type DecisionStatus = 'pending' | 'include' | 'exclude' | 'maybe';

export interface ReferenceWithStatus extends Reference {
  myDecision?: Decision;
  status: DecisionStatus;
}
```

