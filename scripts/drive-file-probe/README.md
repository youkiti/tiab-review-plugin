# Drive File Probe

Google Drive OAuth スコープ `drive.file` の付与挙動を実機で測定するための、汎用的に使い回せるハーネスです。

## これは何のためのハーネスか

`drive.file` の付与単位は「アプリ × ユーザー × ファイル」です。付与される経路は次の3つだけで、
**Drive の共有は付与経路に含まれません**。

1. アプリが作成したファイル
2. ユーザーが Google Picker で選択したファイル
3. Drive UI の「アプリで開く」で開いたファイル

したがって Drive UI で手作業に作っただけのフォルダ/ファイルは、自分が所有していても
アプリのアクセストークンからは 404 になります。これを利用すると、単一の Google アカウントだけで
「このファイルはアプリに付与されているか」を測定できます。

**このハーネスが存在する理由は、付与が不可逆だからです。** 一度 Picker で選ぶと元に戻せません。
「測定の順序を間違える」「ベースラインを測り忘れる」といったミスは、そのフィクスチャを
二度と使えなくします。手作業で都度 DevTools を叩いて確認するのは事故のもとなので、
サインイン→ベースライン測定→中断判定→Picker操作→再測定、という手順そのものを
スクリプトで固定し、順序ミスを構造的に防ぐのがこのハーネスの目的です。

最初の測定シナリオは「Google Picker でフォルダを選択したとき、`drive.file` の付与がそのフォルダ配下の
ファイルにも及ぶか」（GitHub Issue #60）です（`scenarios/folder-cascade.mjs`）。

## シナリオ一覧

- **`folder-cascade`**（`scenarios/folder-cascade.mjs`）: Google Picker でフォルダを選択したとき、
  `drive.file` の付与がそのフォルダ配下のファイルにも及ぶか（カスケードするか）を測定する
  （GitHub Issue #60）。必要な `--input`: `folderId`（未付与フォルダのID）, `fileId`（フォルダ内の
  未付与PDFのID）。
- **`upload-to-ungranted-folder`**（`scenarios/upload-to-ungranted-folder.mjs`）: アプリに
  `drive.file` 未付与のフォルダを `parents` に指定して、ファイルを新規作成できるかを測定する
  （AGENTS.md の「`drive.file` の 403/404 は『無い』ではなく『このユーザーに未付与』」セクションで
  説明されている、共同研究者がフルテキストPDFをアップロードできない問題の直し方を実測してから
  決めるための実験）。必要な `--input`: `folderId`（未付与フォルダのID）。
- **`copy-to-ungranted-folder`**（`scenarios/copy-to-ungranted-folder.mjs`）: アプリに
  `drive.file` 未付与のフォルダを `parents` に指定して、`files.copy` でファイルを複製できるかを
  測定する（GitHub Issue #68）。`upload-to-ungranted-folder` は `files.create`（multipart upload）で
  検証済みだが、`files.copy` は別エンドポイントのため未検証。実装側の該当箇所は
  `src/lib/drive-api.ts` の `copyPdfToFulltextFolder()`。必要な `--input`: `folderId`（未付与フォルダの
  ID）, `sourceFileId`（複製元となる未付与PDFのID）。

## 前提

- リポジトリルートの `.env` に次の3つが設定されていること（`.env.example` 参照）。
  - `WEB_OAUTH_CLIENT_ID` ... Web版用 OAuth クライアントID（種別: ウェブ アプリケーション）
  - `PICKER_API_KEY` ... Google Picker API キー
  - `GCP_PROJECT_NUMBER` ... GCP プロジェクト番号
  - いずれも欠けていると `serve.mjs` がサーバー起動時に日本語メッセージで即座に失敗します。
  - なお `node run.mjs --list` だけなら `.env` が無くても動作します（ローカルサーバーを起動しないため）。
- 実 Chrome（Google Chrome）がインストール済みであること。Playwright 同梱の Chromium は
  Google のサインインで弾かれやすいため、このハーネスは意図的に `channel: 'chrome'` で
  実 Chrome を起動します（フォールバックしません）。

## フィクスチャの作り方（重要）

測定用のフォルダ・PDF は、**必ず Drive UI（drive.google.com）で手作業に作成してください**。
拡張機能やこのハーネス経由で作ってはいけません。作った瞬間にそのアプリへ付与されてしまい、
「未付与のベースライン」が成立しなくなります。

付与は不可逆なので、一度使ったフィクスチャは同じ目的の測定には二度と使えません。
`probe-01` 〜 `probe-05` のように、あらかじめ複数のフォルダ（それぞれに未付与の PDF を1本ずつ）を
まとめて作っておくと、やり直しのたびに新しく作り直す手間が減ります。

必要なフィクスチャはシナリオによって異なります。

- `folder-cascade`: 未付与のフォルダ1つ + その配下に未付与の PDF を1本。
- `upload-to-ungranted-folder`: 未付与の**空のフォルダ**1つのみ（PDF は不要）。このシナリオは
  フォルダへファイルを新規作成できるかを測るだけなので、あらかじめ中身がある必要はありません。
- `copy-to-ungranted-folder`: 未付与の**空**フォルダ1つ + **別の場所にある**未付与 PDF 1本。
  PDF はコピー先フォルダの中に置かないでください（既に中にあるファイルをコピーしても
  「未付与フォルダを parents に新規指定できるか」の測定にならないため）。
  コピー元 PDF は自分のマイドライブに置いてください（Picker の既定ビューがマイドライブなので、
  共有アイテム側に置くと選択時に見つけられず手間取るため。また、実際の取り込みフロー（アプリの
  本番機能）でも取り込む側は自分の Drive にある PDF を選ぶため、そちらの方が実条件にも合います）。

## 実行例

```bash
# シナリオ一覧を表示する（.env が無くても動く）
node scripts/drive-file-probe/run.mjs --list

# folder-cascade シナリオを実行する
node scripts/drive-file-probe/run.mjs --scenario folder-cascade --profile owner \
  --input folderId=<未付与フォルダのID> --input fileId=<フォルダ内の未付与PDFのID>

# copy-to-ungranted-folder シナリオを実行する
node scripts/drive-file-probe/run.mjs --scenario copy-to-ungranted-folder --profile owner \
  --input folderId=<未付与フォルダのID> --input sourceFileId=<複製元の未付与PDFのID>
```

- `--profile <name>`: 永続プロファイルディレクトリ `profile/<name>/` を使う（既定 `default`）。
  同じ名前を指定すれば、次回以降は Google のサインイン状態がブラウザプロファイルに
  キャッシュされているため無人（またはほぼ無人）で進みます。**初回のみ**、ブラウザ上で
  手動のサインイン・スコープ同意が必要です。
- `--input k=v`: シナリオが要求する入力値。複数指定できます。
- `--output-dir <dir>`: 出力先（既定 `output/<timestamp>/`）。
- `--keep-open`: 終了時にブラウザ・ローカルサーバを閉じずに残す。

やり直したいとき（別アカウントで測る、認可状態をリセットする等）は `profile/<name>/` を
削除してください。ただしフィクスチャ（フォルダ・PDF）は使い回せません。付与は不可逆なので、
Drive UI で新しく作り直してから再実行してください。

## 出力

実行すると `output/<timestamp>/` に2ファイルを書き出します。

- `report.md`: 実行内容を時系列でまとめた日本語 Markdown レポート。測定結果は表形式、
  Picker操作・質問応答は地の文で記録されます。中断した場合は末尾に `[中断] <理由>` が入ります。
- `raw.json`: `report.md` の元になった生データ（シナリオID・入力・全ログ・タイムスタンプ）。

## Picker はセレクタで自動操作しない

Picker は `docs.google.com` を読み込むクロスオリジンの iframe です。中身を Playwright の
セレクタで自動操作しようとしないでください（そもそも別オリジンなので操作できません）。
`ctx.pick()` は「ボタンを押して Picker を開き、案内文をターミナルに表示して、
人間が操作し終える（`pickResult` が入る）まで待つ」だけの設計にしてあります。

## 新しいシナリオの書き方

`scenarios/<id>.mjs` に、次の形の default export を追加してください。

```js
export default {
  id: 'my-scenario',            // ファイル名（拡張子抜き）と一致させる
  title: '日本語のタイトル',      // --list に表示される
  inputs: ['someId'],           // --input で要求する必須キー（--list にも表示される）
  async run(ctx) {
    await ctx.signIn();
    // ...
  },
};
```

`ctx` が提供する API:

| メソッド | 説明 |
| --- | --- |
| `ctx.input` | `--input` で渡された値のオブジェクト（`{ folderId: '...' }` 等）。 |
| `await ctx.signIn()` | `#signin` ボタンをクリックしてサインインする。`window.__probe.state.signedIn` が `true` になるまで最大5分ポーリングで待つ。完了するとメールアドレスを返す。 |
| `await ctx.measure(label, targets)` | `window.__probe.measure(targets)` をページ内で実行し、結果を記録してターミナルにも表で出す。`targets` は `[{ label, kind, id }]`（`kind` は `'meta'` / `'media'` / `'list'`）。戻り値は `[{ label, kind, id, status, ok, body }]`。 |
| `await ctx.upload(label, { folderId, name, content })` | `window.__probe.uploadFile({ folderId, name, content })` をページ内で実行し、結果を記録してターミナルにも表で出す。戻り値は `{ status, ok, body }`（成功時の `body` は `{ id, name, webViewLink }`）。 |
| `await ctx.copy(label, { sourceFileId, folderId, name, appProperties })` | `window.__probe.copyFile({ sourceFileId, folderId, name, appProperties })` をページ内で実行し、結果を記録してターミナルにも表で出す。戻り値は `{ status, ok, body }`（成功時の `body` は `{ id, name, parents, webViewLink }`）。 |
| `await ctx.pick(options, instruction)` | `#open-picker` をクリックして Picker を開く。`instruction`（日本語）をターミナルへ表示し、`window.__probe.state.pickResult` が入るまで最大5分ポーリングで待つ。`options` は `{ selectFolder, mimeTypes, parentId }`。キャンセルされていたら例外を投げる。 |
| `await ctx.ask(question)` | ターミナルから人間に一行入力させ、trim して返す。 |
| `ctx.note(text)` | `report.md` へ地の文として追記する。 |
| `ctx.fail(message)` | 前提が崩れたときに測定を中断する。`report.md` に `[中断] <message>` を残して処理を止める（クラッシュとしては扱わない）。 |

`window.__probe.measure()` の `kind` を3種類に分けている理由は、`src/lib/drive-api.ts` の
`folderExists()`（metadata GET、114行目付近）と `downloadDriveFile()`（`alt=media`、78行目付近）が
別々のAPI呼び出しであり、付与範囲の検証では「メタデータだけ見えて実体は読めない」といった
ズレが起きうるかを区別して観測する価値があるためです。`'list'` はフォルダ配下の一覧取得
（カスケード検証の本題）に使います。

## 落とし穴（実装・拡張時に踏まないよう共有）

1. **`127.0.0.1` ではなく `localhost:8080` でなければ動かない。** OAuth クライアントの承認済み
   JavaScript 生成元と Picker API キーのリファラー制限に `http://localhost:8080` が
   登録されているため。
2. **GIS のトークン取得ポップアップはユーザージェスチャ起点でないとブロックされる。**
   `page.evaluate()` から直接 `requestAccessToken()` を呼ばず、ページ上のボタンを
   `page.click()` で押す設計にしている。
3. **Picker には `setDeveloperKey(PICKER_API_KEY)` と `setAppId(GCP_PROJECT_NUMBER)` の
   両方が要る。** 片方でも欠けると付与が起きない。
4. **`include_granted_scopes` の既定は `true`。** 明示的に `false` にしないと、過去に許可した
   全スコープが引き継がれてしまい測定が無意味になる。
5. **アクセストークンをログ・レポート・コンソール・`window` の観測可能な場所に一切出力しないこと。**
   メールアドレスは出してよい。
6. Picker は `docs.google.com` のクロスオリジン iframe。中身をセレクタで自動操作しようとしない。
7. **測定中にアクセストークンが期限切れになり 401 が出ても、フィクスチャは無駄にならない。**
   付与はアクセストークンではなく「アプリ × ユーザー × ファイル」の組でサーバ側に記録されるため、
   サインインし直して測り直せばよい。
