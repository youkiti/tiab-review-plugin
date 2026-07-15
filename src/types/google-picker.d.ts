declare namespace google.picker {
    enum Action { PICKED = 'picked', CANCEL = 'cancel' }
    enum ViewId { SPREADSHEETS = 'spreadsheets' }
    enum Response { ACTION = 'action', DOCUMENTS = 'docs' }
    enum Document { ID = 'id', NAME = 'name' }

    class DocsView {
        constructor(viewId: ViewId);
        setFileIds(fileIds: string): DocsView;
    }

    class PickerBuilder {
        setDeveloperKey(key: string): PickerBuilder;
        setAppId(appId: string): PickerBuilder;
        setOAuthToken(token: string): PickerBuilder;
        addView(view: DocsView): PickerBuilder;
        setLocale(locale: string): PickerBuilder;
        setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
        build(): Picker;
    }

    interface Picker { setVisible(visible: boolean): void; }
    interface PickerDocument { [Document.ID]?: string; [Document.NAME]?: string; }
    interface PickerResponse { [Response.ACTION]?: Action; [Response.DOCUMENTS]?: PickerDocument[]; }
}

declare const gapi: { load(api: string, callback: () => void): void };
