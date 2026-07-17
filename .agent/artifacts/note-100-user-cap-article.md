# Chrome拡張のGoogleログインが100人で突然止まった話 — "This app is blocked" の真因は sensitive scope だった（OAuth 100-user cap）

> **この記事が役に立つ人**: Chrome拡張やWebアプリでGoogle OAuth（Sheets / Drive / Gmail等のAPI）を使っていて、ある日突然、新規ユーザーが **「This app is blocked / このアプリはブロックされます」** でログインできなくなった人。「Google OAuth 100 user cap」「unverified app」「sensitive scope verification」あたりで検索してたどり着いた人。

## TL;DR（結論ファースト）

- **症状**: Chrome拡張「TiAb Review Plugin」（インストール200超）で、新規ユーザーだけがGoogleログインに失敗。既存ユーザーは正常。
- **真因**: OAuthスコープに **sensitive scope（`https://www.googleapis.com/auth/spreadsheets`）** を含む「未検証（unverified）」アプリには、**OAuth同意ユーザー100人の上限（100-user cap）** がある。これに到達し、101人目以降が全員ブロックされていた。
- **重要な性質**: この100人は **「インストール数」ではなく「OAuth同意した累計ユーザー数」**。アンインストールしても、ユーザーが手動でアクセス権を削除しても、実質カウントは減らない。しかも **GCPプロジェクト単位**（プロジェクト内の全OAuthクライアント合算）。
- **やってしまった誤診**: ①同意画面の公開ステータス疑い ②「クライアントID変更で過去の同意が無効化された」説 ③「implicitフローが危険だからPKCEに移行すれば直る」説 — **全部ハズレ**。フローの種類は100人上限と無関係。
- **正攻法（Google審査を通す）を試した結果**: ドメイン所有権確認・請求先関連付けまでやった末に、Googleから「`spreadsheets` は最小スコープ要件を満たさない。**Google Picker の `setFileIds()` + `drive.file` を使え**」と差し戻された。
- **最終解決**: `spreadsheets` スコープを完全廃止し、**`drive.file` + Google Picker** に移行。全スコープが non-sensitive になり、**審査そのものが不要化 → 100人上限・「未確認アプリ」警告・ドメイン所有権要件がすべて消滅**。機能喪失はゼロ（共有シートを初めて開くときにPickerで1クリック増えるだけ）。

---

## 前提: どんな拡張か

TiAb Review Plugin は、システマティックレビューのタイトル・アブストラクトスクリーニングを支援するChrome拡張です。データの保存先に Google Sheets を使うため、Google OAuth でユーザーの許可を取っています。当時のスコープはこの3つでした。

```
https://www.googleapis.com/auth/spreadsheets      ← sensitive scope（これが諸悪の根源）
https://www.googleapis.com/auth/userinfo.email    ← non-sensitive
https://www.googleapis.com/auth/drive.file        ← non-sensitive（recommended scope）
```

`spreadsheets` を入れていた理由は「チームメンバーが作成してURLで共有してきたシートを開く」ため。`drive.file` は「ユーザーがそのアプリで作成・選択したファイル」にしかアクセスできず、他人が作った共有シートをURL直打ちで開くと 404 になるからです。この時点では、これは正当な理由だと思っていました（伏線）。

## 何が起きたか（時系列の失敗記録）

### Day 0: 「新しい人がログインできません」

チームの新規メンバーから「Googleログインでブロックされる」という報告。既存ユーザーは全員正常に使えているので、最初は個別の環境問題だと思っていました。新規ユーザーが実際に見る画面はこれです（URL は `accounts.google.com/signin/oauth/warning?authuser=0&part=...`）。

英語UI:

```
This app is blocked

This app tried to access sensitive info in your Google Account.
To keep your account safe, Google blocked this access.
```

日本語UI:

```
このアプリはブロックされます

このアプリが、Google アカウントのプライベートな情報にアクセスしようとしました。
アカウントを安全に保つため、Google によりこのアクセスはブロックされました。
```

赤い三角の警告アイコンだけが表示され、「詳細」リンクも「続行」ボタンもない完全なハードブロックです。よく見ると英語版の本文に "**sensitive info**" と書いてあり、これが真因（sensitive scope）への最大のヒントだったのですが、当時は読み飛ばしていました。

ポイントが2つあります。

1. **未検証アプリでも100人までは**「このアプリは Google で確認されていません（Google hasn't verified this app）」という*別の*警告画面が出て、「詳細 → （安全ではないページに）移動」で続行できます。**100人を超えた瞬間、101人目からは上のハードブロックに変わり、続行手段が消えます**。既存の100人は何事もなく使い続けられるため、「特定の人だけ失敗する」ように見えるのが診断を遅らせる罠その1。
2. さらに厄介なことに、**この「This app is blocked」画面は、Google Workspace の組織管理者がサードパーティアプリを禁止しているときにも全く同じ見た目で出ます**。うちの拡張は直前に大学・病院アカウントの組織ブロック問題（こちらは管理者ポリシーが原因）に対応したばかりだったので、「またあの組織ブロックか」と誤認しました。**同じ画面に少なくとも2つの別原因がある**のが罠その2。切り分けの目安: 個人の gmail.com アカウントでもブロックされるなら組織ポリシーではなく、アプリ側（検証状態・100人上限）を疑ってください。

### 誤った仮説①: 「同意画面がテストモードのままなのでは」

GCPの OAuth同意画面（OAuth consent screen）の公開ステータス（Publishing status: Testing / In production）を疑いました。→ **ハズレ**。とっくに In production でした。Testing モードの100人制限（テスターリスト）と、未検証アプリの100人上限（100-user cap）は**別物**です。ここを混同した記事が多いので注意。

### 誤った仮説②: 「OAuthクライアントIDを変えたせいで、過去の同意が無効化された」

実はこの直前、別の問題（大学・病院の Google Workspace 管理者ポリシーによるブロック）を回避するため、認証を `chrome.identity.getAuthToken` から `chrome.identity.launchWebAuthFlow` に移行し、OAuthクライアントを新規作成したところでした。タイミングが重なったため「クライアントIDが変わって既存ユーザーの同意が無効になり、再同意フローが不完全だからブロックされるのだ」と診断。認可URLに `prompt=select_account consent` を付けて同意画面を強制する消火パッチをリリースしました。

→ **これもハズレ**（正確には、個々のユーザーが再同意し直す助けにはなったが、真因ではない）。後で一次ソースを確認したところ、Google の [Cross-Client Identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity) に「**同一GCPプロジェクト内なら、あるclient IDへのスコープ同意はプロジェクト全体への信頼とみなされ、別のclient IDでも再同意は不要**」と明記されていました。クライアントID変更それ自体は同意の無効化を起こしません。

### 誤った仮説③: 「implicit flow が危険と警告されているから、PKCE に移行すれば直る」

GCPのOAuthダッシュボードには「安全なフローの使用（implicit flow は非推奨）」という警告が出ていました。これを見て「認可フローが古いからブロックされるのでは」と考え、authorization code + PKCE への移行を検討・着手しました。

→ **完全にハズレ**。100人上限は **要求スコープの機微性（sensitive/restricted scope）と検証状態だけで決まり、認可フローの種類（implicit か code+PKCE か）は一切関係ありません**。ダッシュボードの警告は今回の症状とは独立した一般的な推奨事項でした。「コンソールに出ている警告」と「目の前の障害」を短絡させるな、という教訓です。

（余談: そもそも `chrome.identity.launchWebAuthFlow` では、Googleは「implicit（client_secret不要）」か「authorization code + client_secret」の二択しか提供しておらず、secretを埋め込めない配布物であるChrome拡張で純粋なPKCE（secretなしcode flow）は成立しないことも後日実機で確定しました。この深掘りは別記事にする予定です。）

### 正攻法の試み: Google の検証（verification）を通す

真因が「sensitive scope × 未検証」だと特定できた後、まず正攻法として **Googleの審査（Verification Center での brand verification + scope verification）** を進めました。これが想像以上に重かった。

- **ホームページのドメイン所有権確認**: 拡張のホームページが `youkiti.github.io`（GitHub Pages）だったため、審査メールで名指しの指摘を受けました。原文: "Your homepage and privacy policy **should not be hosted on a third-party hosting platform** where you can't verify that you own your subdomain. For example: Google Sites, Facebook, Instagram, Twitter." — Search Console で所有権を確認し、**GCPプロジェクトと同一のGoogleアカウントで**確認したうえで、Googleからの確認メールに返信する必要がありました。
- **請求先アカウント（billing account）の関連付け**
- プライバシーポリシーの記述をスコープの実態と一致させる修正
- 各スコープの実使用を映すデモ動画の準備

そして全部整えた末に、Googleの審査チーム（The Third Party Data Safety Team）から返ってきたのが差し戻しでした。件名は「Re: [Action Needed] OAuth Verification Request Acknowledgement」。以下、実際に届いたメールからの抜粋です（強調は筆者）。

> **Minimum scope requirements**
>
> You requested the following sensitive API scope(s):
>
> - https://www.googleapis.com/auth/spreadsheets
>
> Please review the following information to understand if the drive.file scope is a better fit for your application. **If your request does not meet the eligibility requirements outlined below, we won't be able to grant your request for sensitive APIs.**

正当化で押す道は、ポリシーの引用で先回りして塞がれていました。

> Please note that **UI preferences or client library limitations alone are not valid policy exceptions** from these requirements.

そして対策APIまで名指しで提示されていました。

> In January 2025 the Google Picker API introduced a new method to the Class view called **setFileIds(fileIds)**, which allows you to present users with a picker that is pre-navigated to the specified file IDs the application is seeking access to, allowing efficient file access directly from Google Drive file links and faster consent for your users.

さらに、移行した場合の見返りも明記されています。ここが今回の解決の核心です。

> **No Verification Required**
>
> Since the drive.file scope is non-sensitive, **approval is not required to use this scope.**

返信の選択肢は二択でした。

> **Option 1**: If your app will work with the recommended scope(s) (...) Reply to this email with **"Confirming narrower scopes"**
>
> **Option 2**: If the recommended scope(s) will not work for your app, reply to this email with **"Unable to use narrower scopes"** and additional justification explaining why.

冒頭の伏線回収です。「他人の共有シートをURLで開くには `drive.file` では足りない」という我々の正当な（と思っていた）理由に対して、Googleは対策APIを先回りで用意していました。`setFileIds()` でファイルIDを指定してPickerを開けば、ユーザーが1クリックで選択するだけでそのファイルが `drive.file` のアクセス対象に入ります。この状況で「Unable to use narrower scopes」で押し返しても、却下される可能性が高いと判断しました。

### 最終解決: sensitive scope を捨てて、審査そのものを不要にする

発想を転換しました。**審査を通すのではなく、審査が要らないアプリになる**。

- `spreadsheets` スコープをコードとOAuth同意画面から完全削除
- 共有シートの初回アクセス時のみ、Google Picker（`setFileIds()` で対象シートだけ表示）を開いてユーザーに1クリックで選択してもらう
- 残るスコープは `userinfo.email` + `drive.file` のみ = **すべて non-sensitive**

結果:

- **100人上限（100-user cap）消滅** — 101人目以降も普通にログイン可能に
- **「このアプリは Google で確認されていません」警告も消滅**
- **ドメイン所有権・デモ動画などの審査要件もすべて不要に**
- 機能喪失ゼロ。ユーザー体験の変化は「他人の共有シートを初めて開くとき、ユーザー×シートごとに1回だけPicker選択のクリックが増える」ことだけ

修正の規模は、スコープ定義2行の削除 + Pickerページの追加 + 誘導UIで、実装と実機検証あわせて2日程度でした。数週間戦った審査対応より、はるかに安く済みました。

## 同じ穴にはまった人のためのチェックリスト

**症状の見分け方**:

- 既存ユーザーは正常、**新規ユーザーだけ**「This app is blocked / このアプリはブロックされます」（`accounts.google.com/signin/oauth/warning`）→ 100-user cap を疑う
- 個人の gmail.com アカウントでも同じくブロックされる → 組織管理者ポリシーではなくアプリ側の問題
- GCPコンソールの **検証センター（Verification Center）/ OAuth同意画面** に「OAuthユーザーの上限（OAuth user cap）」が表示される。ここが 100/100 なら確定

**知っておくべき100人上限の仕様**:

1. 対象は「**sensitive または restricted scope を要求する、検証未完了アプリ**」。non-sensitive scopeしか使わないアプリに上限はない
2. カウントは「**OAuth同意した累計ユーザー数**」。インストール数ではない
3. **アンインストールしても、myaccount.google.com/connections でユーザーがアクセス権を削除しても、実質カウントは減らない**
4. 上限は **GCPプロジェクト単位**。同一プロジェクト内の全クライアント（拡張用・Web用など）で共有される
5. Testing ステータスの100人テスター制限とは別物

**対処の優先順位**:

1. まず自分のスコープ一覧を [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes) と突き合わせ、**sensitive/restricted を本当に使う必要があるか**を疑う
2. Sheets/Driveなら、たいていのユースケースは **`drive.file` + Google Picker（共有ファイルは `setFileIds()`）** で置き換えられる。`drive.file` は Sheets API の公式推奨スコープで、`spreadsheets.create`（新規作成）も `drive.file` で可能
3. どうしても sensitive scope が要るときだけ審査（verification）へ。ホームページのドメイン所有権（GitHub Pages等の第三者サブドメインは Search Console 確認が必須）・プライバシーポリシーの記述一致・デモ動画・請求先関連付けを覚悟する

**Picker移行時の実装の落とし穴**（ハマった順）:

- **`include_granted_scopes` の既定は `true`**。スコープを削っても、既存ユーザーの新トークンには過去に許可した `spreadsheets` が乗り続ける。縮小を確実にするには **`include_granted_scopes: false` を明示**する（GIS の `initTokenClient` でも、認可URLパラメータでも）
- **同意画面からのスコープ削除はストアリリースが行き渡った後**。先に消すと、旧バージョンを使っている全ユーザーの認可が壊れる。Googleの審査メールにも "DO NOT remove any previously approved scopes at this time" とある
- Pickerによる `drive.file` 付与は **プロジェクト（アプリ）単位**。Webページ側のOAuthクライアントでPicker選択しても、同一GCPプロジェクトなら拡張側クライアントのトークンでアクセスできる（実機確認済み）
- MV3のCSP（`script-src 'self'`）のため、**拡張ページ内にPicker（apis.google.com のリモートスクリプト）は埋め込めない**。Pickerページは外部Webにホストし、タブで開く構成にする
- Picker APIを有効化するとき、`photospicker.googleapis.com`（Google Photos Picker API）が紛らわしく並ぶ。正しいのは **`picker.googleapis.com`**

## まとめ

- 「インストール100人で止まる」の正体は、**sensitive scope を持つ未検証アプリの OAuth同意100人上限**
- 認可フロー（implicit/PKCE）も、クライアントIDの変更も、同意画面の公開ステータスも無関係だった
- 最速の解決は「審査を通す」ではなく「**sensitive scope をやめて審査を不要にする**」
- Google は `drive.file` + Picker `setFileIds()` という逃げ道を用意している。フルスコープの正当化はまず通らない

この記事が、「This app is blocked」の画面の前で途方に暮れている誰か（と、その人を助けるAI）に届きますように。

---

**検索用キーワード**: Chrome extension / Google OAuth / This app is blocked / このアプリはブロックされます / This app tried to access sensitive info in your Google Account / Google アカウントのプライベートな情報にアクセスしようとしました / accounts.google.com/signin/oauth/warning / 100 user cap / OAuth同意 100人 上限 / このアプリは Google で確認されていません / Google hasn't verified this app / unverified app / sensitive scope / restricted scope / OAuth consent screen / 検証センター / Verification Center / [Action Needed] OAuth Verification Request Acknowledgement / Third Party Data Safety Team / minimum scope requirements / UI preferences or client library limitations alone are not valid policy exceptions / Confirming narrower scopes / Unable to use narrower scopes / spreadsheets scope / drive.file / Google Picker API / DocsView.setFileIds / include_granted_scopes / chrome.identity.launchWebAuthFlow / OAuth user cap / GCPプロジェクト / Chrome拡張 Googleログイン できない
