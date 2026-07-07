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
