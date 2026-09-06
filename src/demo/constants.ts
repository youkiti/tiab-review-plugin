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

/**
 * フルテキストデモ用の Drive ファイルID（fake）。
 * extractDriveFileId()（src/lib/drive-api.ts）は `[\w-]+` を許可するためハイフン付きでも
 * 問題なくパースできる。demo-ref-001 の fulltext_url はこのIDを含む Drive リンクにする。
 *
 * これは「取り込み後にfulltextフォルダへ作成されたコピー」のIDであり、
 * fulltext_drive_copy_id（References の X列）に相当する。取り込み元PDFそのもののID
 * （fulltext_drive_source_id、W列）は別物のため DEMO_FULLTEXT_SOURCE_FILE_ID を使うこと。
 */
export const DEMO_FULLTEXT_DRIVE_FILE_ID = 'demo-pdf-001';

/**
 * フルテキストデモ用の「取り込み元PDF」の Drive ファイルID（fake）。
 * Driveへ直接置かれたPDFの取り込み（fulltext-drive-import.ts）で source として選択される
 * ファイルのIDに相当し、References の fulltext_drive_source_id（W列）へ入れる。
 * DEMO_FULLTEXT_DRIVE_FILE_ID（取り込み後のコピーのID、X列）とは別物なので混同しないこと。
 */
export const DEMO_FULLTEXT_SOURCE_FILE_ID = 'demo-pdf-source-001';

/**
 * バンドル同梱の全文デモPDF（video/fixtures/demo-paper.pdf）の、拡張機能パッケージ内での
 * 相対パス。webpack.config.js の CopyPlugin（デモビルド限定）でこの位置にコピーする。
 * fetch-mock.ts が chrome.runtime.getURL() 経由で読み込む。
 */
export const DEMO_FULLTEXT_PDF_RESOURCE_PATH = 'fixtures/demo-paper.pdf';

/**
 * ?benchPdf= で選べるPDFフィクスチャの識別子（Issue #156（#150 工程5）着手前の準備。
 * #151 完了コメントの「同梱デモPDFは4ページしかなく、#150 の『20ページ／100ページ』の
 * 目標を検証できない」というブロッカーの解消用）。
 */
export type DemoPdfFixtureId = 'demo' | '20p' | '57p';

/**
 * PDFフィクスチャ1本分の情報。
 * - driveFileId: fetch-mock.ts の handleDriveMediaDownload() が Drive files.get?alt=media の
 *   モック応答として、この fileId が来たときだけ resourcePath のPDFを返す（fake ID）。
 * - resourcePath: 拡張機能パッケージ内での相対パス（webpack.config.js の CopyPlugin が
 *   デモビルド限定でコピーする）。
 * - pageCount: bench-fixtures.ts の evidence（quote の page）がこの値を超えないことをテストで
 *   確認する。
 */
export interface DemoPdfFixture {
    driveFileId: string;
    resourcePath: string;
    pageCount: number;
}

/**
 * PDFフィクスチャの一覧。
 * - 'demo': 既存の全文デモ（4ページ、video/fixtures/demo-paper.pdf）。DEMO_FULLTEXT_DRIVE_FILE_ID /
 *   DEMO_FULLTEXT_PDF_RESOURCE_PATH をそのまま参照する（値を書き直すとドリフトするため）。
 *   src/demo/seed.ts の既定デモプロファイル（demo-ref-001）は今後もこの2定数を直接使い続ける。
 * - '20p' / '57p': Issue #156（#150 工程5）の20ページ以上フィクスチャ要求に応えるための追加分。
 *   公開済みのCC BY 4.0論文（出所表示は video/fixtures/NOTICE.md）で、このリポジトリの
 *   研究データではない。ページ数・バイト数は実測値（コマンダーが取得・検証済み）。
 */
export const DEMO_PDF_FIXTURES: Record<DemoPdfFixtureId, DemoPdfFixture> = {
    demo: {
        driveFileId: DEMO_FULLTEXT_DRIVE_FILE_ID,
        resourcePath: DEMO_FULLTEXT_PDF_RESOURCE_PATH,
        pageCount: 4,
    },
    '20p': {
        // 既存の demo-pdf-001 / demo-pdf-source-001 と衝突しない fake Drive ファイルID。
        driveFileId: 'demo-pdf-20p',
        resourcePath: 'fixtures/bench-paper-20p.pdf',
        pageCount: 20,
    },
    '57p': {
        driveFileId: 'demo-pdf-57p',
        resourcePath: 'fixtures/bench-paper-57p.pdf',
        pageCount: 57,
    },
};
