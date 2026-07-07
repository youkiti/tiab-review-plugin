# TiAb Review Webアプリ版 要件定義書 兼 実装指示書

- 作成日: 2026-07-07
- ステータス: ドラフト（レビュー待ち）
- 対象リポジトリ: tiab-review-plugin（作成時点 v0.24.0）
- 決定済み方針: スコープ=TiAb判定＋表示系フル / デプロイ=docs/app/コミット / オンライン前提（PWAは第2段階） / **LLM実行機能はWeb版に載せない**
- 想定読者: 本リポジトリを初めて触る開発者。本書の Part II はタスク単位でそのまま着手できる粒度で書いている

---

# Part I: 要件定義

## 1. 背景と目的

TiAb Review は現在 Chrome 拡張機能としてのみ提供されており、レビュアーは PC の Chrome でしか判定作業ができない。データベースは研究ごとの Google Spreadsheet であり、拡張機能は Sheets API を `fetch` + Bearer トークンで直接呼んでいる（サーバーレス構成）。

本プロジェクトは、**サーバーを持たずに**（GitHub Pages の静的配信のみで）スマホ・タブレット・任意のブラウザから人手スクリーニングを可能にする Web アプリ版を追加する。

### 目的

1. レビュアーがスマホのスキマ時間に TiAb スクリーニングを進められるようにする
2. Chrome 以外のブラウザ・OS のレビュアーが参加できるようにする
3. 拡張機能版と同一のスプレッドシートを共有し、双方の判定・進捗が相互反映される状態を保つ

### 非目的（明確にやらないこと）

- Web 版での LLM スクリーニングの**実行**（Gemini / OpenRouter API 呼び出し、APIキーの入力・保存）
- PDF ビューア・フルテキストスクリーニング（第2段階以降で検討）
- EndNote / RIS / CSV のインポート UI（プロジェクト作成・文献取り込みは拡張機能版で行う前提）
- 独自バックエンドサーバーの構築（Vercel / Firebase / GAS 等は使わない）

## 2. スコープ

### 2.1 第1段階（本書の対象）

| # | 機能 | 含む/含まない | 備考 |
|---|------|------------|------|
| 1 | Google アカウント認証（既存と同一スコープ） | ✅ 含む | GIS Token Client 方式（FR-1） |
| 2 | プロジェクト（スプレッドシート）への接続・切り替え | ✅ 含む | 新規作成は含まない |
| 3 | 論文リスト表示・検索・ステータスフィルター・タームフィルター | ✅ 含む | 共有コードで無改修 |
| 4 | 人間の Include / Exclude / Maybe 判定の保存 | ✅ 含む | FR-3 |
| 5 | AI判定結果の**表示**（確信度・理由・エビデンスハイライト） | ✅ 含む | シート読み取りのみ。LLM実行不要（FR-4） |
| 6 | キーワードハイライト（表示＋編集） | ✅ 含む | FR-5 |
| 7 | コンフリクト表示・ブラインド開閉・レビュアーフィルター | ✅ 含む | FR-6 |
| 8 | チーム進捗パネル | ✅ 含む | FR-7 |
| 9 | 担当割り振り（assignment）の表示・自分の担当分フィルター | ✅ 含む | 割り振り変更は拡張のみ |
| 10 | 通信失敗時の判定再送（オフラインキュー） | ✅ 含む | FR-10 |
| 11 | 共有（メール招待） | ✅ 含む | 共有コードで無改修（chrome非依存を確認済み） |
| 12 | LLM 実行・APIキー管理 | ❌ 拡張専用 | Web バンドルにコード自体を含めない |
| 13 | フルテキスト画面・PDF・「フルテキストを開く」ボタン | ❌ 拡張専用 | 第2段階候補 |
| 14 | RIS インポート / CSV・RIS エクスポート / 論文用テキスト | ❌ 第1段階では非表示 | コードは chrome 非依存だが、モバイルでの動作検証コスト削減のため初期リリースでは UI を隠す |
| 15 | ML / ASReview 連携 | ❌ 拡張専用 | |
| 16 | プロジェクト新規作成（シート初期化） | ❌ 拡張専用 | 未初期化シート接続時は案内を表示 |
| 17 | PWA（ホーム画面追加・オフラインキャッシュ） | ❌ 第2段階 | |

### 2.2 拡張機能版との線引きの原則

> **スプレッドシートに新しいデータを生成する側（LLM実行・PDF取り込み・インポート）は拡張機能専用。スプレッドシート上のデータを読み書きする側（判定・表示・進捗）は共有コードとし、Web 版にも載せる。**

この線引きはデータ層で既に成立している。例: AI ハイライトは LLM を呼ぶのではなく、Decisions タブの `reviewer_id = llm:*` 行の `note` 列 JSON を読んで描画しているだけ（`src/sidepanel/features/screening/render.ts:254-276`）。

線引きは口約束にせず、ESLint ルールと CI の両ターゲットビルドで機械的に強制する（NFR-5、Task 7）。

## 3. 機能要件

### FR-1: 認証（Google Identity Services）

- Web 版は GIS の Token Client 方式（`google.accounts.oauth2.initTokenClient`）でアクセストークンを取得する
- スコープは現行拡張機能（`src/manifest.json` の `oauth2.scopes`）と**完全に同一**の3つ。**増やさない**（OAuth 再審査回避のため）:
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/drive.file`
- 初回ログインはユーザー操作（ログインボタンのタップ）起点でのみ認可ポップアップを開く（iOS Safari のポップアップブロック対策）
- トークンは `expires_in` を記録し、期限の 60 秒前を過ぎていたら API 呼び出し前にサイレント再取得（`prompt: ''`）する
- サイレント再取得が失敗した場合は例外を投げ、UI はログイン画面（既存のログインボタン）に戻す。このとき未送信の判定はオフラインキュー（FR-10）に残っており消えない
- レビュアー識別は現行と同じく userinfo API のメールアドレス（`getUserEmail()` は無改修で流用）

**受入基準**
- [ ] iOS Safari / Android Chrome / PC Chrome でログインでき、メールアドレスが表示される
- [ ] ログインから1時間以上経過した後の判定保存が、サイレント再取得または再ログイン1タップで成功する
- [ ] ページリロード後、Googleセッションが生きていればログインボタン1タップ（ポップアップ表示なしまたは瞬時閉鎖）で復帰する
- [ ] 未保存の判定がトークン失効で消えない

### FR-2: プロジェクト接続

- スプレッドシート URL / ID 貼り付けで接続（既存 `project.ts` の検証ロジックを流用）
- 最近使ったプロジェクト一覧（`sheets-api.ts` の `LocalRecentSheet`）をプラットフォームストレージに保持
- 未初期化シートに接続した場合は「拡張機能版でプロジェクトを作成してください」と案内し、判定画面に進ませない
- 「新規作成」ボタンは Web 版では非表示

**受入基準**
- [ ] 拡張機能版で作成済みのシートに URL 貼り付けで接続できる
- [ ] 2回目以降はドロップダウンから再接続できる
- [ ] 未初期化シートで案内メッセージが表示される

### FR-3: TiAb 判定の保存

- Include / Exclude / Maybe、理由、メモを Decisions タブに保存（既存 `saveDecision` を流用）
- `client_version` は `web-{バージョン}-human` 形式（例: `web-0.25.0-human`）とする
  - 既存の判定種別判定関数 `isHumanDecision()`（`src/lib/client-version.ts`）は `includes('-human')` で判定するため**後方互換が保たれる**ことを確認済み
  - `web-` プレフィックスにより、後からスプレッドシート上で Web 版経由の判定を識別できる（論文化時の分析用）
- 保存後の画面挙動（自動遷移等）は拡張機能版と同一

**受入基準**
- [ ] Web 版の判定が拡張機能版のチーム進捗・コンフリクト表示に反映される（逆方向も）
- [ ] Decisions タブの `client_version` が `web-*-human` である
- [ ] 再判定の上書きルールが拡張機能版と同一

### FR-4: AI 判定結果の表示

- `reviewer_id = llm:*` 行の確信度・理由・エビデンスハイライト（オレンジ）を既存ロジック（`render.ts` / `reviewer-utils.ts`）で描画
- 「閾値確定済みで有効な AI 判定のみ」ルール（`isActiveConfirmedLlmDecision`）をそのまま流用
- AI ハイライト ON/OFF トグルも現行どおり

**受入基準**
- [ ] 同一論文で拡張機能版と同一箇所がハイライトされる
- [ ] LLM 判定が存在しないプロジェクトでもエラーなく動作する

### FR-5: キーワードハイライト

- Config のキーワード読み取り・表示・編集を現行どおり提供（`getHighlightKeywords` / 既存の保存関数を流用）

**受入基準**
- [ ] 拡張機能版で設定したキーワードが同色でハイライトされる
- [ ] Web 版で編集したキーワードが拡張機能版に反映される

### FR-6: コンフリクト・ブラインド・レビュアーフィルター

- Config の `key_opened` を読み、現行と同じ表示制御・コンフリクトバナー・レビュアーフィルターを提供

**受入基準**
- [ ] ブラインド ON で他者の判定が見えない
- [ ] ブラインド OFF で判定不一致にコンフリクト表示が出る

### FR-7: チーム進捗パネル

- 現行のチーム進捗表示を提供。判定保存イベントの即時反映は `chrome.runtime.onMessage` の代わりにページ内 EventTarget（プラットフォームアダプタの messaging）で実現
- 他レビュアーの判定はリフレッシュ操作での反映でよい（リアルタイム同期は要求しない）

**受入基準**
- [ ] 自分の判定保存が進捗表示に即時反映される

### FR-8: 担当割り振りの表示

- Assignments を読み「自分の担当分」フィルターを提供（割り振り変更 UI は非表示）

**受入基準**
- [ ] 拡張機能版で割り振った担当が Web 版のフィルターに反映される

### FR-9: モバイル UI

- サイドパネル UI（縦長レイアウト）をベースに以下のみ調整:
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` の追加
  - 判定3ボタン（Include/Exclude/Maybe）のタップターゲットを高さ 44px 以上にし、画面下部に固定（親指リーチ圏）
  - iOS セーフエリア対応（`env(safe-area-inset-bottom)` を下部固定バーの padding に加算）
- 新規デザインは起こさない。追加 CSS は `webapp.css` 1ファイルに隔離し、既存 CSS は変更しない

**受入基準**
- [ ] 幅 375px（iPhone SE 相当）で横スクロールなしに判定作業が完結する
- [ ] 判定3ボタンが下部固定で片手操作できる

### FR-10: 通信失敗時の再送

- 既存 `offline-queue.ts` を流用する。同ファイルは既に IndexedDB フォールバック実装済みで、chrome 依存は小容量時の `chrome.storage.local` 高速パス3箇所のみ（アダプタ経由に置換）
- 保存失敗した判定はキューに積み、`online` イベント／次回起動時に自動再送（既存の `flushDecisionQueue` フローを流用）
- 未送信件数を UI に表示する

**受入基準**
- [ ] 機内モードで判定 → 解除後に自動送信されシートに反映される
- [ ] 未送信件数が UI に表示される

## 4. 非機能要件

### NFR-1: セキュリティ
- LLM API キーを一切扱わない（入力欄も設けない）。`storage.ts` の暗号化コード（`chrome.runtime.id` 依存）は Web バンドルに含めない
- アクセストークンはメモリ保持のみ。localStorage / IndexedDB に保存しない
- localStorage に保存するのは: 最近のプロジェクト一覧・UI 設定・未送信キューのみ

### NFR-2: Sheets API クォータ
- 読み書きとも 60 回/分/ユーザーの範囲で動作すること。既存 `sheets-api.ts` のバッチ・キャッシュ戦略を変更しない

### NFR-3: 対応環境
- iOS Safari（iOS 16+）、Android Chrome、PC の Chrome / Edge / Firefox 最新版

### NFR-4: 既存機能の非破壊
- 拡張機能版のビルド成果物（dist/）・リリースフロー（`npm run release`）の挙動を変えない
- 既存ヘルプページ（docs/ 直下）の URL・内容を変えない
- Part II の Task 1〜2（リファクタ）は拡張機能の動作が完全に同一であることを devビルド手動確認で担保する

### NFR-5: 線引きの機械的強制
- ESLint: 許可リスト（§Task 7）以外のファイルでの `chrome` グローバル参照を error にする
- CI: PR ごとに拡張ビルドと Web ビルドの両方を実行し、失敗時はマージ不可
- この2つにより「表示系の新機能はリリース時に自動で Web 版に載る」状態を保証する

## 5. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| GIS トークン失効（約1時間、リフレッシュトークンなし） | 作業中断・判定消失 | 期限管理＋サイレント再取得（FR-1）＋オフラインキュー（FR-10）で判定を保全 |
| iOS Safari のポップアップブロック | ログイン不能 | 認可ポップアップは必ずユーザータップ起点。自動リトライでポップアップを開かない |
| `drive.file` スコープの制約（アプリが開いたファイルのみ Drive API 対象） | 最近使ったシート一覧が Drive から取れない | 拡張機能版と同じ設計（ローカル保存の `LocalRecentSheet`）を流用するので影響なし。シート本体へのアクセスは `spreadsheets` スコープで行われる |
| 共有コードへの chrome 依存混入で Web ビルド破損 | 「自動追従」が崩れる | NFR-5（ESLint + CI 両ビルド） |
| docs/app/ コミットによる diff 汚染 | レビューしづらい | Web ビルド成果物は独立コミット（`chore: deploy web app vX.Y.Z`）に分離 |
| 拡張版と Web 版の同時書き込み | 判定の重複 | Decisions は行追記型で競合しにくい。既存の重複解決ルールを流用し、新規の排他制御は設けない |

---

# Part II: 実装指示書

## 0. 前提知識（最初に読むこと）

### 0.1 現状のアーキテクチャ

- ビルド: TypeScript + webpack（`webpack.config.js` 1ファイル、エントリ4つ: service-worker / popup / sidepanel / fulltext）
- 主 UI: `src/sidepanel/sidepanel.html`（912行） + `src/sidepanel/sidepanel.ts`（344行、イベント配線のみ）+ `src/sidepanel/features/*`（機能実装）
- データ層: `src/lib/sheets-api.ts`（3,086行）。**API 呼び出しはすべて `fetch` + `Authorization: Bearer <token>`** で、chrome 依存はトークン取得とローカルキャッシュのみ
- 認証: sidepanel → `chrome.runtime.sendMessage({type:'GET_AUTH_TOKEN'})` → `src/background/service-worker.ts` が `chrome.identity.getAuthToken` で取得して返す
- i18n: `src/lib/i18n.ts` の `t()` が `chrome.i18n.getMessage` をラップ。翻訳データは `src/_locales/{ja,en}/messages.json`

### 0.2 chrome 依存の全数調査結果（2026-07-07 実測）

**共有したいコードに残っている chrome 依存は以下で全部**である（これ以外の `src/background/`, `src/popup/`, `src/fulltext/`, LLM/ML 系ファイルは Web ビルドに含めないので対象外）:

| ファイル | 行 | API | 用途 |
|---|---|---|---|
| `src/lib/sheets-api.ts` | 101, 140 | `chrome.runtime.sendMessage` | トークン取得（GET_AUTH_TOKEN / FORCE_REAUTH） |
| `src/lib/sheets-api.ts` | 216, 241 | `chrome.storage.local` | 最近使ったシート一覧の保存 |
| `src/lib/i18n.ts` | 14 | `chrome.i18n.getMessage` | 翻訳 |
| `src/lib/client-version.ts` | 20 | `chrome.runtime.getManifest` | バージョン取得（chrome 不在時は 'unknown' を返すガード実装済み） |
| `src/sidepanel/features/auth.ts` | 90, 95-96 | `chrome.storage.local.clear`, `chrome.identity.*` | ログアウト |
| `src/sidepanel/features/project.ts` | 166, 328, 509 | `chrome.storage.local` | 接続情報・設定のキャッシュ |
| `src/sidepanel/features/settings.ts` | 104, 118 | `chrome.storage.local` | ユーザー設定 |
| `src/sidepanel/features/team-progress.ts` | 123 | `chrome.runtime.onMessage` | 判定保存イベント受信 |
| `src/sidepanel/utils/offline-queue.ts` | 94, 110, 115 | `chrome.storage.local` | キューの小容量高速パス（IndexedDB 併用実装済み） |
| `src/sidepanel/sidepanel.ts` | 233-234 | `chrome.runtime.getURL`, `chrome.tabs.create` | フルテキストページを開く（Web 版では機能ごと非表示） |
| `src/sidepanel/features/screening/actions.ts` | ※ | （保存後の進捗通知に sendMessage を使っている場合あり。Task 2 で確認して messaging アダプタへ） | |

拡張専用として Web バンドルから除外するファイル（chrome 依存を持つが**改修不要**）:
`src/background/*`, `src/popup/*`, `src/fulltext/*`, `src/lib/gemini-api.ts`, `src/lib/llm-provider.ts`, `src/lib/llm-processor.ts`, `src/lib/providers/*`, `src/lib/storage.ts`（APIキー暗号化）, `src/lib/pdf-image-only.ts`, `src/sidepanel/features/llm/*`, `src/sidepanel/features/ml/*`, `src/sidepanel/features/fulltext-tab.ts`, `src/sidepanel/features/fulltext-results.ts`, `src/sidepanel/features/fulltext-ai.ts`, `src/sidepanel/features/fulltext-assignment-ui.ts`, `src/sidepanel/features/import-export.ts`, `src/sidepanel/features/manuscript.ts`

### 0.3 作業の全体像と PR 分割

| PR | 内容 | 拡張機能への影響 |
|---|---|---|
| PR-1 | Task 1〜2: プラットフォームアダプタ導入＋既存コードの置換（**純リファクタ**） | 動作同一（devビルドで手動確認必須） |
| PR-2 | Task 3〜6: Web 実装・webapp エントリ・webpack web ターゲット・モバイル CSS | なし（新規ファイルのみ） |
| PR-3 | Task 7〜8: ESLint ルール・CI・リリーススクリプト統合・受入テスト | なし |

OAuth クライアント登録（Task 9）は GCP コンソールでの手作業。PR-2 の動作確認前に済ませる必要がある（リポジトリオーナーが実施）。

---

## Task 1: プラットフォームアダプタの新設

### 1.1 インターフェース定義

新規ファイル `src/platform/types.ts`:

```ts
/** 拡張機能版と Web 版で差し替えるプラットフォーム機能の抽象 */
export interface PlatformAdapter {
    /** OAuth アクセストークンを取得（必要ならサイレント再取得） */
    getAuthToken(): Promise<string>;
    /** トークンを破棄して再認可（スコープ変更・権限エラー時） */
    forceReauth(): Promise<string>;
    /** ログアウト（トークン破棄・キャッシュ削除） */
    clearAuth(): Promise<void>;

    /** key-value ストレージ（chrome.storage.local 互換のオブジェクト単位 get/set） */
    storageGet(keys: string[]): Promise<Record<string, unknown>>;
    storageSet(items: Record<string, unknown>): Promise<void>;
    storageRemove(keys: string | string[]): Promise<void>;
    storageClear(): Promise<void>;

    /** ページ内/拡張内メッセージング（チーム進捗の即時更新に使用） */
    onMessage(listener: (message: unknown) => void): void;
    emitMessage(message: unknown): void;

    /** i18n: chrome.i18n.getMessage 互換 */
    getMessage(key: string, substitutions?: string[]): string;

    /** 別画面/外部URLを開く */
    openExternal(url: string): void;

    /** client_version 用のバージョン文字列（例: '0.25.0' / 'web-0.25.0'） */
    getVersionString(): string;

    /** 機能フラグ。共有 UI はこれを見て拡張専用機能を非表示にする */
    readonly capabilities: {
        llm: boolean;          // LLMタブ・LLM設定
        ml: boolean;           // MLタブ
        fulltext: boolean;     // フルテキストタブ・「フルテキストを開く」ボタン
        importExport: boolean; // RISインポート・エクスポートメニュー
        createProject: boolean;// プロジェクト新規作成ボタン
    };
}
```

新規ファイル `src/platform/index.ts`（シングルトン保持）:

```ts
import type { PlatformAdapter } from './types';

let impl: PlatformAdapter | null = null;

/** 各エントリポイントの先頭（他モジュールの副作用より前）で必ず呼ぶ */
export function setPlatform(p: PlatformAdapter): void {
    impl = p;
}

export function platform(): PlatformAdapter {
    if (!impl) throw new Error('Platform not initialized. Call setPlatform() at the entry point.');
    return impl;
}
```

### 1.2 Chrome 実装

新規ファイル `src/platform/chrome/index.ts`。**既存コードからロジックを移すだけで、新しい挙動を書かないこと**:

- `getAuthToken` / `forceReauth`: 現在の `sheets-api.ts:99-111, 138-150` の `chrome.runtime.sendMessage` 実装をそのまま移動
- `clearAuth`: 現在の `auth.ts:90-100`（`chrome.storage.local.clear` + `chrome.identity.removeCachedAuthToken` + `clearAllCachedAuthTokens`）を移動
- `storageGet/Set/Remove/Clear`: `chrome.storage.local` の薄いラッパー
- `onMessage/emitMessage`: `chrome.runtime.onMessage.addListener` / `chrome.runtime.sendMessage`（fire-and-forget。応答は使わない）
- `getMessage`: `chrome.i18n.getMessage(key, substitutions)` を返す（現在の `i18n.ts:10-17` と同一）
- `openExternal`: `chrome.tabs.create({ url })`
- `getVersionString`: `chrome.runtime.getManifest().version`
- `capabilities`: すべて `true`

### 1.3 完了条件（DoD）

- [ ] `npm run typecheck` / `npm run lint` / `npm run test` が通る
- [ ] この時点では既存コードは未変更（アダプタは未使用）。拡張機能の挙動変化なし

---

## Task 2: 既存コードのアダプタ置換（純リファクタ）

各エントリポイントの**最初の import** でプラットフォームを注入する。`src/sidepanel/sidepanel.ts` の先頭に追加:

```ts
import { setPlatform } from '../platform';
import { chromePlatform } from '../platform/chrome';
setPlatform(chromePlatform);
// （既存の import より前に評価される必要があるため、必ずファイル先頭に置く）
```

同様に `src/fulltext/fulltext.ts` と `src/popup/popup.ts` の先頭にも追加する（共有モジュールが `platform()` を呼ぶため）。`src/background/service-worker.ts` は共有モジュールを import していないので不要。

### 2.1 置換箇所一覧（この表の順に1ファイルずつ）

| ファイル | 変更内容 |
|---|---|
| `src/lib/sheets-api.ts` | `getAuthToken()` / `forceReauth()` の中身を `platform().getAuthToken()` / `platform().forceReauth()` 呼び出しに変更（export シグネチャは維持し、呼び出し元は無改修）。`getLocalRecentSheets` / `rememberLocalRecentSheet`（216, 241行）の `chrome.storage.local` を `platform().storageGet/Set` に変更 |
| `src/lib/i18n.ts` | `t()` 内の `chrome.i18n.getMessage(key, subs)` を `platform().getMessage(key, subs)` に変更 |
| `src/lib/client-version.ts` | `getClientVersion()` の manifest 参照を `platform().getVersionString()` に変更。ただし**Node 実験環境から import されている**ため、`platform()` が throw したら従来どおり `'unknown'` を返す try-catch を入れる |
| `src/sidepanel/features/auth.ts` | `handleLogout` 内（90-100行）を `platform().storageClear()` + `platform().clearAuth()` に変更 |
| `src/sidepanel/features/project.ts` | 166, 328, 509 行の `chrome.storage.local` を `platform().storageGet/Set` に変更 |
| `src/sidepanel/features/settings.ts` | 104, 118 行を同様に変更 |
| `src/sidepanel/features/team-progress.ts` | 123 行の `chrome.runtime.onMessage.addListener` を `platform().onMessage()` に変更 |
| 判定保存後の進捗通知（`chrome.runtime.sendMessage({type:'team-progress:decision-saved',...})` を送っている側。`src/fulltext/fulltext.ts:737` と、TiAb 側の該当箇所を grep で特定） | `platform().emitMessage(...)` に変更 |
| `src/sidepanel/utils/offline-queue.ts` | 94, 110, 115 行を `platform().storageGet/Set/Remove` に変更 |
| `src/sidepanel/sidepanel.ts` | 233-234 行（フルテキストを開く）: `chrome.runtime.getURL(...)` で URL を作る部分は拡張専用機能なので、`platform().capabilities.fulltext` が false なら早期 return。URL 生成と `chrome.tabs.create` は現状のまま残してよい（このリスナーは Task 4 で拡張専用配線に移すため） |

**注意**: `src/lib/storage.ts`（APIキー暗号化）は**置換しない**。拡張専用のまま残す（Web バンドルに含めないため触る必要がない）。

### 2.2 完了条件（DoD）

- [ ] `git grep -n "chrome\." src/lib/sheets-api.ts src/lib/i18n.ts src/sidepanel/features/auth.ts src/sidepanel/features/project.ts src/sidepanel/features/settings.ts src/sidepanel/features/team-progress.ts src/sidepanel/utils/offline-queue.ts` の結果が 0 件（client-version.ts は try-catch 内のみ許容）
- [ ] `npm run dev` で devビルドし、以下を手動確認（拡張機能の挙動が完全に同一であること）:
  - ログイン → プロジェクト接続 → 判定保存 → チーム進捗反映
  - ログアウト
  - 言語表示（日本語 UI が出ること = i18n アダプタ経由で動いていること）
  - フルテキストページを開く → 判定保存 → サイドパネルの進捗即時反映（messaging アダプタ経由）
  - 機内モード判定 → 復帰で再送（offline-queue アダプタ経由）

---

## Task 3: Web プラットフォーム実装

### 3.1 認証 `src/platform/web/auth.ts`

GIS（Google Identity Services）の Token Client を使う。`index.html` に `<script src="https://accounts.google.com/gsi/client" async defer></script>` を入れる（Task 5 の HTML 変換で注入）。

型定義: `npm i -D @types/google.accounts` を追加。

```ts
// ビルド時に webpack DefinePlugin で注入（Task 6）
declare const __WEB_OAUTH_CLIENT_ID__: string;

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
].join(' ');

let accessToken: string | null = null;
let expiresAt = 0; // epoch ms

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

function ensureClient(): google.accounts.oauth2.TokenClient {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: __WEB_OAUTH_CLIENT_ID__,
        scope: SCOPES,
        callback: (resp) => {
            const p = pending; pending = null;
            if (!p) return;
            if (resp.error) { p.reject(new Error(resp.error)); return; }
            accessToken = resp.access_token;
            expiresAt = Date.now() + Number(resp.expires_in) * 1000;
            p.resolve(resp.access_token);
        },
        error_callback: (err) => {
            const p = pending; pending = null;
            p?.reject(new Error(err.type)); // 例: popup_closed / popup_failed_to_open
        },
    });
    return tokenClient;
}

function requestToken(promptValue: '' | 'consent'): Promise<string> {
    return new Promise((resolve, reject) => {
        if (pending) { reject(new Error('auth in progress')); return; }
        pending = { resolve, reject };
        ensureClient().requestAccessToken({ prompt: promptValue });
    });
}

/** 期限内ならメモリのトークンを返し、切れていたらサイレント再取得 */
export async function getAuthToken(): Promise<string> {
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    return requestToken(''); // Googleセッションが生きていればポップアップなしで返る
}

export async function forceReauth(): Promise<string> {
    accessToken = null; expiresAt = 0;
    return requestToken('consent');
}

export async function clearAuth(): Promise<void> {
    if (accessToken) {
        await new Promise<void>((r) => google.accounts.oauth2.revoke(accessToken!, () => r()));
    }
    accessToken = null; expiresAt = 0;
}
```

**実装上の注意**
- トークンは**メモリのみ**（NFR-1）。localStorage に書かないこと
- 起動時の自動ログイン試行（`auth.ts` の `initApp` が `getAuthToken()` を呼ぶ）は、Google セッションがあればサイレントに成功する。失敗した場合は既存フローどおりログインボタン表示になるので、Web 用の特別処理は不要
- `error_callback` の `popup_failed_to_open` はポップアップブロック。reject すれば既存の `handleLogin` の catch がエラートーストを出す

### 3.2 ストレージ `src/platform/web/storage.ts`

localStorage ベースで `chrome.storage.local` 互換の get/set を実装:

```ts
const PREFIX = 'tiab:'; // github.io はオリジンをリポジトリ間で共有しないが、衝突予防に付ける

export async function storageGet(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw !== null) { try { out[key] = JSON.parse(raw); } catch { /* 壊れた値は無視 */ } }
    }
    return out;
}

export async function storageSet(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    }
}

export async function storageRemove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(PREFIX + key);
}

export async function storageClear(): Promise<void> {
    // PREFIX 付きキーだけ消す（他アプリのデータを消さない）
    Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
}
```

### 3.3 メッセージング `src/platform/web/messaging.ts`

```ts
const bus = new EventTarget();

export function onMessage(listener: (message: unknown) => void): void {
    bus.addEventListener('message', (e) => listener((e as CustomEvent).detail));
}

export function emitMessage(message: unknown): void {
    bus.dispatchEvent(new CustomEvent('message', { detail: message }));
}
```

### 3.4 i18n `src/platform/web/i18n.ts`

`chrome.i18n.getMessage` 互換を自前実装する。翻訳データはビルドに直接バンドルする:

```ts
import ja from '../../_locales/ja/messages.json';
import en from '../../_locales/en/messages.json';

type Entry = { message: string; placeholders?: Record<string, { content: string }> };
type Messages = Record<string, Entry>;

const lang: Messages = navigator.language.toLowerCase().startsWith('ja') ? (ja as Messages) : (en as Messages);
const fallback: Messages = ja as Messages; // manifest の default_locale と揃える

export function getMessage(key: string, substitutions: string[] = []): string {
    const entry = lang[key] ?? fallback[key];
    if (!entry) return '';
    let msg = entry.message;
    if (entry.placeholders) {
        for (const [name, def] of Object.entries(entry.placeholders)) {
            // content は "$1" 形式。placeholders 名は大文字小文字を区別しない
            const idx = parseInt(def.content.replace('$', ''), 10) - 1;
            const value = substitutions[idx] ?? '';
            msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
        }
    }
    return msg;
}
```

- `tsconfig.json` に `"resolveJsonModule": true` がなければ追加する
- 既存 `t()` は「見つからなければキー名を返す」仕様なので、アダプタが `''` を返したときの扱いは `i18n.ts` 側の既存ロジック（`message || key`）に任せる

### 3.5 Web アダプタ本体 `src/platform/web/index.ts`

```ts
import type { PlatformAdapter } from '../types';
import * as auth from './auth';
import * as storage from './storage';
import * as messaging from './messaging';
import { getMessage } from './i18n';

declare const __APP_VERSION__: string; // DefinePlugin で package.json の version を注入

export const webPlatform: PlatformAdapter = {
    getAuthToken: auth.getAuthToken,
    forceReauth: auth.forceReauth,
    clearAuth: auth.clearAuth,
    storageGet: storage.storageGet,
    storageSet: storage.storageSet,
    storageRemove: storage.storageRemove,
    storageClear: storage.storageClear,
    onMessage: messaging.onMessage,
    emitMessage: messaging.emitMessage,
    getMessage,
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
    getVersionString: () => `web-${__APP_VERSION__}`,
    capabilities: {
        llm: false, ml: false, fulltext: false, importExport: false, createProject: false,
    },
};
```

### 3.6 完了条件（DoD）

- [ ] `npm run typecheck` が通る（この時点で Web エントリは未作成でもよい）
- [ ] 単体テスト: `getMessage` のプレースホルダ置換（`$1`、named placeholder、大文字小文字）を `npm run test` の枠組みでテスト追加

---

## Task 4: Web エントリポイントと配線の共通化

### 4.1 sidepanel.ts の分割

現在の `src/sidepanel/sidepanel.ts` は「共有できる配線」と「拡張専用の配線」が混在している。次の2ファイルに分割する:

**新規 `src/sidepanel/bootstrap.ts`**（共有配線）— 現在の sidepanel.ts から以下を移動:
- 依存注入ブロック（`auth.setAuthDependencies` 〜 `reviewerFilter.setReviewerFilterDependencies`。ただし `llm.setHandleBack` / `llm.setLoadDataAndShowScreening` は除く）
- DOMContentLoaded 内の共通リスナー: i18n 適用、オフラインキュー flush、Auth、Project、Settings（assignment 系含む）、Sharing、Screening Actions/Filters/Keywords、Key Toggle、AI ハイライト、Back、Store 初期化、チーム進捗（`setupTeamProgressListeners`）、タブ切替のうち screening タブ
- `initApp()` 呼び出し

`bootstrap.ts` は `export function bootstrapCommon(): void` として公開し、**DOMContentLoaded の登録は各エントリ側で行う**（bootstrap 自体は副作用なし）。

`capabilities` による UI 制御を bootstrapCommon 内に追加:

```ts
const caps = platform().capabilities;
if (!caps.ml) dom.tabMlBtn?.classList.add('hidden');
if (!caps.llm) dom.tabLlmBtn?.classList.add('hidden');
if (!caps.fulltext) {
    document.getElementById('tab-fulltext')?.classList.add('hidden');
    dom.btnOpenFulltext?.classList.add('hidden');
}
if (!caps.importExport) {
    dom.importBtn?.classList.add('hidden');
    dom.exportBtn?.classList.add('hidden');
}
if (!caps.createProject) dom.createBtn?.classList.add('hidden');
```

（`hidden` クラスが既存 CSS にあるか確認し、なければ `display:none` のユーティリティを追加。設定画面内の LLM/ML 関連ブロックは Task 6 の `webapp.css` で `body.web-app` スコープでも隠す。）

**既存 `src/sidepanel/sidepanel.ts`**（拡張エントリ）— 残すもの:
- `setPlatform(chromePlatform)`（ファイル先頭）
- `bootstrapCommon()` 呼び出し
- 拡張専用配線: LLM（`llm.setupLlmEventListeners`、`llm.setHandleBack` 等）、ML（`initMlHandlers` ほか ML 系全部）、フルテキスト（`setupFulltextTabListeners`、`btnOpenFulltext` の chrome.tabs 処理）、Import/Export、Manuscript モーダル

**分割の検証**: 分割前後で `npm run dev` の拡張機能の全機能が動くこと（Task 2 と同じ手動チェックリスト＋LLM タブ・ML タブ・フルテキストタブ・インポート/エクスポート）。

### 4.2 Web エントリ `src/webapp/index.ts`

```ts
import { setPlatform } from '../platform';
import { webPlatform } from '../platform/web';
setPlatform(webPlatform);

import { bootstrapCommon } from '../sidepanel/bootstrap';

document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('web-app');
    bootstrapCommon();
});
```

**重要**: `src/webapp/index.ts` から到達可能な import グラフに LLM/ML/フルテキスト/import-export 系モジュールが**入らない**ことを確認する（入っていると `chrome.*` 参照や不要コードがバンドルされる）。確認方法: `npx webpack --mode production --env target=web --json > stats.json` して stats 内に `gemini-api` 等が含まれないこと。bootstrap.ts が誤ってそれらを import していたら分割をやり直す。

### 4.3 完了条件（DoD）

- [ ] 拡張機能: 分割後も全機能が動く（手動チェックリスト）
- [ ] Web: バンドルに LLM/ML/fulltext モジュールが含まれない（stats.json で確認）

---

## Task 5: Web 用 HTML の生成

`sidepanel.html`（912行）を**複製しない**。webpack の CopyPlugin `transform` で拡張用 HTML から Web 用 `index.html` を機械生成する（HTML に新機能が追加されたとき Web 版に自動反映させるため）。

変換ルール（Task 6 の webpack 設定内に実装）:

| 対象 | 変換 |
|---|---|
| `<head>` 直後 | `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` を挿入 |
| `<link rel="stylesheet" href="sidepanel.css">` | そのまま（CSS も docs/app/ へコピー）。直後に `<link rel="stylesheet" href="webapp.css">` を追加 |
| `<script src="sidepanel.js"></script>` | `<script src="https://accounts.google.com/gsi/client" async defer></script>\n<script src="app.js"></script>` に置換 |
| `<body>` | `<body class="web-app">` に置換（JS 到達前の FOUC 防止。JS 側でも付与するが二重で問題ない） |

実装例（文字列置換で十分。HTML パーサは不要）:

```js
function transformSidepanelHtml(content) {
    let html = content.toString('utf8');
    html = html.replace('<head>', '<head>\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    html = html.replace('<link rel="stylesheet" href="sidepanel.css">',
        '<link rel="stylesheet" href="sidepanel.css">\n    <link rel="stylesheet" href="webapp.css">');
    html = html.replace('<script src="sidepanel.js"></script>',
        '<script src="https://accounts.google.com/gsi/client" async defer></script>\n    <script src="app.js"></script>');
    html = html.replace('<body>', '<body class="web-app">');
    return html;
}
```

**置換が1件もヒットしなかったら例外を投げる**こと（サイレントに古い形式で出力されるのを防ぐ。将来 sidepanel.html の該当行が書き換わったらここで気づける）。

---

## Task 6: webpack Web ターゲットとモバイル CSS

### 6.1 webpack.config.js

既存の `module.exports = (env, argv) => {...}` を分岐させる。**既存の返り値（拡張設定）は1文字も変えない**:

```js
module.exports = (env, argv) => {
    if (env && env.target === 'web') {
        return buildWebConfig(argv);
    }
    return buildExtensionConfig(env, argv); // ← 既存の中身をそのまま関数に切り出す
};
```

`buildWebConfig` の要件:

```js
const packageJson = require('./package.json');

function buildWebConfig(argv) {
    const isProduction = argv.mode === 'production';
    const webClientId = process.env.WEB_OAUTH_CLIENT_ID?.trim();
    if (isProduction && !webClientId) {
        throw new Error('WEB_OAUTH_CLIENT_ID が未設定です。.env に Web アプリ用 OAuth クライアントIDを設定してください。');
    }
    return {
        entry: { app: './src/webapp/index.ts' },
        output: {
            path: path.resolve(__dirname, 'docs/app'),
            filename: '[name].js',
            clean: true, // docs/app はビルド成果物専用ディレクトリとして全消去してよい
        },
        module: { /* 既存拡張設定と同じ ts-loader ルールを流用 */ },
        resolve: { /* 既存と同じ extensions / alias */ },
        plugins: [
            new webpack.DefinePlugin({
                __WEB_OAUTH_CLIENT_ID__: JSON.stringify(webClientId ?? ''),
                __APP_VERSION__: JSON.stringify(packageJson.version),
            }),
            new CopyPlugin({
                patterns: [
                    {
                        from: 'src/sidepanel/sidepanel.html',
                        to: 'index.html',
                        transform: transformSidepanelHtml, // Task 5
                    },
                    { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel.css' },
                    { from: 'src/sidepanel/styles', to: 'styles' },
                    { from: 'src/webapp/webapp.css', to: 'webapp.css' },
                    { from: 'src/icons/icon128.png', to: 'icon128.png' }, // favicon 用
                ],
            }),
        ],
        optimization: { splitChunks: false },
        devtool: isProduction ? false : 'source-map',
    };
}
```

注意点:
- `_locales` はコピー不要（Task 3.4 で JSON をバンドルに取り込むため）
- `webpack` の require（`const webpack = require('webpack')`）をファイル先頭に追加
- TypeScript 側のグローバル宣言: `src/webapp/globals.d.ts` に `declare const __WEB_OAUTH_CLIENT_ID__: string; declare const __APP_VERSION__: string;` を置く

### 6.2 npm scripts（package.json）

```jsonc
{
    "build:web": "webpack --mode production --env target=web",
    "dev:web": "webpack --mode development --env target=web",
    "watch:web": "webpack --mode development --watch --env target=web",
    // 既存 release の末尾に web ビルドを連結
    "release": "npm run bump && npm run build:release && npm run build:web",
    "release:minor": "npm run bump:minor && npm run build:release && npm run build:web"
}
```

リリース手順書 `.agent/workflows/release.md` に「`docs/app/` の差分を `chore: deploy web app vX.Y.Z` として**単独コミット**する」手順を追記する。

### 6.3 モバイル CSS `src/webapp/webapp.css`

すべて `body.web-app` スコープで書く（拡張版 CSS に影響ゼロ）:

```css
/* 判定3ボタンを画面下部に固定（FR-9） */
body.web-app .decision-buttons {  /* ← 実際のクラス名は sidepanel.html で確認して合わせる */
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
    background: var(--bg-color, #fff);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
    z-index: 100;
}
body.web-app .decision-buttons button { min-height: 44px; }

/* 下部固定バーに隠れないよう本文に余白 */
body.web-app #screening-section { padding-bottom: 96px; }

/* 拡張専用の設定ブロックを非表示（LLM/ML/エクスポート等。IDは sidepanel.html を見て列挙） */
body.web-app #llm-settings-section,
body.web-app #ml-settings-section { display: none !important; }
```

（セレクタ名は実装時に `sidepanel.html` の実 ID/クラスに合わせること。存在しないセレクタを書いても気づけないため、**実機で非表示になっていることを目視確認**する。）

### 6.4 ローカル開発・動作確認手順

1. `.env` に `WEB_OAUTH_CLIENT_ID=<Task 9 で作成した Web クライアントID>` を追記
2. `npm run dev:web` → `docs/app/` に出力される
3. `npx http-server docs/app -p 8080`（または `python -m http.server 8080 -d docs/app`）
4. `http://localhost:8080` を開く（**`http://localhost:8080` を OAuth クライアントの承認済みオリジンに登録しておくこと**。`127.0.0.1` はダメ、`localhost` で開く）
5. スマホ実機確認: PC と同一 LAN でもオリジン不一致で認証不可のため、実機確認は GitHub Pages にデプロイした後に行う（`https://youkiti.github.io` が登録済みオリジン）

### 6.5 完了条件（DoD）

- [ ] `npm run build`（拡張）の dist/ 出力が本タスク前と同一（`git diff --stat` 等で確認）
- [ ] `npm run build:web` が成功し、`docs/app/index.html` `app.js` `sidepanel.css` `styles/` `webapp.css` が生成される
- [ ] localhost でログイン→接続→判定保存が通しで動く

---

## Task 7: 線引きの機械的強制（ESLint + CI）

### 7.1 ESLint

共有コードでの `chrome` グローバル参照を禁止する。許可リスト（= 拡張専用ファイル）:

```
src/platform/chrome/**
src/background/**
src/popup/**
src/fulltext/**
src/lib/storage.ts
src/lib/gemini-api.ts
src/lib/llm-provider.ts
src/lib/llm-processor.ts
src/lib/providers/**
src/lib/pdf-image-only.ts
src/sidepanel/sidepanel.ts        （拡張エントリ）
src/sidepanel/features/llm/**
src/sidepanel/features/ml/**
src/sidepanel/features/fulltext-*.ts
src/sidepanel/features/import-export.ts
src/sidepanel/features/manuscript.ts
```

設定例（プロジェクトの ESLint 設定形式に合わせて調整）:

```js
// 共有コード（デフォルト）: chrome 禁止
{
    files: ['src/**/*.ts'],
    rules: {
        'no-restricted-globals': ['error', {
            name: 'chrome',
            message: '共有コードで chrome API を直接使わない。src/platform/ のアダプタを経由すること（Web版ビルドが壊れる）。',
        }],
    },
},
// 拡張専用ファイル: 許可
{
    files: [/* 上の許可リスト */],
    rules: { 'no-restricted-globals': 'off' },
},
```

導入時に `npm run lint` が全ファイル通ること（違反が出たら、それは Task 2/4 の置換漏れなので修正する）。

### 7.2 CI（GitHub Actions）

新規 `.github/workflows/build-check.yml`:

```yaml
name: build-check
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
      - run: npm run dev            # 拡張ビルド（dev。OAUTH_CLIENT_ID 不要）
      - run: npm run dev:web        # Webビルド（dev。WEB_OAUTH_CLIENT_ID 不要）
```

（dev モードはクライアントID未設定でも警告のみでビルドが通る設計になっていることを確認。web 側も production のみ throw する実装にしてある＝Task 6.1）

### 7.3 完了条件（DoD）

- [ ] 共有コードに試しに `chrome.storage` と書くと lint error になる
- [ ] PR で両ビルドが走り、どちらかを壊すと CI が落ちる

---

## Task 8: デプロイと受入テスト

### 8.1 デプロイ手順（初回）

1. `npm run build:web`（production。`.env` に `WEB_OAUTH_CLIENT_ID` 必須）
2. `git add docs/app && git commit -m "chore: deploy web app v<version>"`
3. main へマージ → GitHub Pages（設定変更不要。main の /docs 配信のまま）が自動配信
4. `https://youkiti.github.io/tiab-review-plugin/app/` で確認

### 8.2 受入テスト（リリース前手動チェックリスト）

拡張機能版のプロジェクトを1つ用意し、PC Chrome・iOS Safari・Android Chrome で実施:

1. [ ] `/app/` を開いてログイン → メールアドレス表示
2. [ ] 拡張機能版で作成済みプロジェクトに URL 貼り付けで接続 → 論文リスト表示
3. [ ] Include / Exclude / Maybe を各1件保存 → シートに行が追加され `client_version` が `web-*-human`
4. [ ] 拡張機能版で Web 版の判定が進捗・一覧に反映されている（逆方向も）
5. [ ] AI 判定ありの論文でハイライト・確信度・理由が拡張機能版と同一表示
6. [ ] キーワードハイライトが同色で表示され、Web 版での編集が拡張版に反映される
7. [ ] ブラインド ON で他者判定が非表示 / OFF でコンフリクト表示
8. [ ] LLM・ML・フルテキストタブ、インポート/エクスポート、新規作成ボタンが表示されていない
9. [ ] 機内モードで判定 → 復帰後に自動送信・未送信件数表示
10. [ ] ログインから1時間以上放置 → 判定保存がサイレント再取得または再ログイン1タップで成功
11. [ ] 幅 375px で横スクロールなし・判定ボタンが下部固定・タップターゲット 44px 以上
12. [ ] 日本語 UI が正しく表示される（i18n Web 実装の確認）。ブラウザ言語を英語にすると英語 UI になる
13. [ ] 既存ヘルプページ（`/tiab-review-plugin/`）が変わらず表示される
14. [ ] 拡張機能版の dev ビルド・ストアビルド（`npm run build`）が従来どおり成功し全機能が動く

---

## Task 9: OAuth クライアント登録（リポジトリオーナーの手作業）

1. 既存の GCP プロジェクト（拡張機能の OAuth クライアントと同じプロジェクト）の「認証情報」で OAuth クライアントを新規作成
   - アプリケーションの種類: **ウェブ アプリケーション**
   - 名前: `TiAb Review Web App`（管理用。任意）
   - 承認済みの JavaScript 生成元: `https://youkiti.github.io` と `http://localhost:8080`
   - 承認済みのリダイレクト URI: 不要（GIS Token Client はリダイレクトを使わない）
2. 発行されたクライアント ID を `.env` の `WEB_OAUTH_CLIENT_ID` に設定（`.env` はコミットしない。既存運用どおり）
3. スコープは同意画面設定を**変更しない**（既存3スコープのまま。増やすと再審査が必要）
4. 既存の「拡張機能ID×OAuthクライアント対応表」（リリース方針メモ）に Web クライアントの行を追記

---

## 付録A: 段階計画

| 段階 | 内容 | 状態 |
|---|---|---|
| 第1段階 | 本書のスコープ（TiAb 判定＋表示系フル） | 本書 |
| 第2段階 | PWA 化（manifest / ホーム画面追加 / オフラインキャッシュ）、フルテキスト判定の表示・保存、エクスポート解禁 | 未着手 |
| 第3段階 | プロジェクト作成・インポートの Web 対応（必要になれば） | 構想のみ |

## 付録B: 用語

| 用語 | 意味 |
|---|---|
| TiAb | Title / Abstract スクリーニング |
| GIS | Google Identity Services（Web 向け OAuth ライブラリ） |
| Token Client | GIS のアクセストークン取得方式。リフレッシュトークンなし・約1時間で失効 |
| Decisions タブ | 判定1件=1行のシート。LLM 判定も `reviewer_id = llm:*` 行として同居し、エビデンスは `note` 列の JSON |
| ブラインド | 他レビュアーの判定を隠す運用モード（Config の key_opened で制御） |
| capabilities | プラットフォームアダプタの機能フラグ。共有 UI が拡張専用機能を非表示にする判定に使う |
