declare namespace google.picker {
    enum Action { PICKED = 'picked', CANCEL = 'cancel' }
    // DOCS = 'all'（Drive上の全アイテム種別ビュー。setMimeTypes と組み合わせてPDF等に絞り込む）
    enum ViewId { SPREADSHEETS = 'spreadsheets', DOCS = 'all' }
    enum Response { ACTION = 'action', DOCUMENTS = 'docs' }
    enum Document { ID = 'id', NAME = 'name', MIME_TYPE = 'mimeType' }
    enum Feature { MULTISELECT_ENABLED = 'multiselectEnabled' }

    class DocsView {
        constructor(viewId: ViewId);
        setFileIds(fileIds: string): DocsView;
        setMimeTypes(mimeTypes: string): DocsView;
        // 初期表示フォルダの指定のみ。アクセス範囲の制限（セキュリティ境界）ではない点に注意。
        setParent(parentId: string): DocsView;
        // false で「共有アイテム」ビューになる。既定（未指定/true相当）はマイドライブ配下のみが対象で、
        // 共有されただけでマイドライブに追加していないファイルは一覧にも検索結果にも出ない（Issue #75）。
        setOwnedByMe(ownedByMe: boolean): DocsView;
    }

    class PickerBuilder {
        setDeveloperKey(key: string): PickerBuilder;
        setAppId(appId: string): PickerBuilder;
        setOAuthToken(token: string): PickerBuilder;
        addView(view: DocsView): PickerBuilder;
        enableFeature(feature: Feature): PickerBuilder;
        setLocale(locale: string): PickerBuilder;
        setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
        build(): Picker;
    }

    interface Picker { setVisible(visible: boolean): void; }
    interface PickerDocument { [Document.ID]?: string; [Document.NAME]?: string; [Document.MIME_TYPE]?: string; }
    interface PickerResponse { [Response.ACTION]?: Action; [Response.DOCUMENTS]?: PickerDocument[]; }
}

declare const gapi: { load(api: string, callback: () => void): void };
