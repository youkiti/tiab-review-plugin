// デモモード共通定数
//
// Playwright での録画・自動操作のたびに値が変わらないよう、乱数や Date.now() は
// 一切使わずここに固定値としてまとめる。fetch-mock.ts / seed.ts / platform/demo/index.ts
// から共通で参照する。

/** デモ用スプレッドシートの固定ID（fetch-mock はこのIDへのアクセスのみ許可する） */
export const DEMO_SPREADSHEET_ID = 'demo-spreadsheet-001';

/** 「最近使用したシート」一覧・スプレッドシートタイトルに表示する名称 */
export const DEMO_SPREADSHEET_TITLE = 'SRWS-PSG デモプロジェクト';

/** デモ用ログインユーザー（oauth2/v3/userinfo のモック応答・Decisions の reviewer_id に使用） */
export const DEMO_USER_EMAIL = 'demo-reviewer@example.com';

/** チーム進捗デモ用の2人目のレビュアー（実際にはログインしない、Decisions の判定行のみ存在） */
export const DEMO_COLLEAGUE_EMAIL = 'colleague@example.com';

/** シード文献の source_file 列に入れる値（sample/ 配下の実ファイル名と合わせる） */
export const DEMO_SOURCE_FILE = 'pubmed-srws-psgad-set.nbib';

/** platform/demo/index.ts が発行する固定トークン文字列（値そのものに意味はない） */
export const DEMO_TOKEN = 'demo-token';

/** chrome.storage.local 上でログイン状態を表すフラグのキー */
export const DEMO_SIGNED_IN_STORAGE_KEY = 'demo_signed_in';

/** 文献の imported_at ・ Drive files.list の modifiedTime に使う固定タイムスタンプ */
export const DEMO_SEED_TIMESTAMP = '2026-01-05T09:00:00.000Z';

/**
 * シード済みヒト判定（Decisions.client_version）に使う固定リテラル。
 * isHumanDecision()（src/lib/client-version.ts）は '-human' を含むかどうかで判定するため、
 * 実際の拡張機能バージョンに依存しないここの値を使う。
 */
export const DEMO_HUMAN_CLIENT_VERSION = 'demo-0.0.0-human';
