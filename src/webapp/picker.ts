import { getMessage } from '../platform/web/i18n';
import { isExtensionRedirectUri } from '../lib/picker-url';

declare const __WEB_OAUTH_CLIENT_ID__: string;
declare const __PICKER_API_KEY__: string;
declare const __GCP_PROJECT_NUMBER__: string;

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

function t(key: string, substitutions?: string | string[]): string {
    return getMessage(key, substitutions ? (Array.isArray(substitutions) ? substitutions : [substitutions]) : []);
}

function hashParams(): URLSearchParams {
    return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function setStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

function waitForGoogleApis(): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = window.setInterval(() => {
            if (typeof google !== 'undefined' && google.accounts?.oauth2 && typeof gapi !== 'undefined') {
                window.clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() - started > 15000) {
                window.clearInterval(timer);
                reject(new Error('Google API scripts did not load'));
            }
        }, 100);
    });
}

function loadPicker(): Promise<void> {
    return new Promise((resolve) => gapi.load('picker', resolve));
}

async function fetchUserEmail(token: string): Promise<string> {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`userinfo ${response.status}`);
    const data = await response.json() as { email?: string };
    if (!data.email) throw new Error('userinfo email missing');
    return data.email;
}

function requestToken(email: string | null): Promise<google.accounts.oauth2.TokenResponse> {
    return new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: __WEB_OAUTH_CLIENT_ID__,
            scope: `${DRIVE_FILE_SCOPE} ${USERINFO_SCOPE}`,
            login_hint: email || undefined,
            include_granted_scopes: false,
            callback: (resp) => resp.error ? reject(new Error(resp.error)) : resolve(resp),
            error_callback: (err) => reject(new Error(err.type)),
        });
        client.requestAccessToken({ prompt: 'consent' });
    });
}

interface PickedFile {
    id: string;
    name: string;
    mimeType: string;
}

/**
 * PDFモードの結果（選択ファイル or キャンセル）を拡張機能のリダイレクトURIへフラグメントで返す。
 * redirect が拡張機能の chromiumapp.org 形式でない場合は、遷移せずエラー表示に留める
 * （オープンリダイレクト防止。この検証は isExtensionRedirectUri に一本化してある）。
 */
function redirectToExtension(redirectUri: string, fragment: string): void {
    if (!isExtensionRedirectUri(redirectUri)) {
        setStatus(t('picker_invalidRedirect'));
        return;
    }
    window.location.href = `${redirectUri}#${fragment}`;
}

function returnFilesToExtension(redirectUri: string, files: PickedFile[]): void {
    redirectToExtension(redirectUri, `files=${encodeURIComponent(JSON.stringify(files))}`);
}

function returnCancelledToExtension(redirectUri: string): void {
    redirectToExtension(redirectUri, 'cancelled=1');
}

/**
 * PDFモード用Picker: DocsView(DOCS) を application/pdf に絞り込み、複数選択を許可する。
 * folderId があれば初期表示フォルダとして使う（アクセス範囲の制限ではなく表示上の絞り込みのみ）。
 * PICKED/CANCEL のいずれも window.location.href で拡張機能のリダイレクトURIへ遷移して結果を返す。
 */
function openPdfPicker(token: string, folderId: string | null, redirectUri: string): void {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    view.setMimeTypes('application/pdf');
    if (folderId) view.setParent(folderId);
    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const picker = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token)
        .addView(view)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setLocale(locale)
        .setCallback((data) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
                const docs = data[google.picker.Response.DOCUMENTS] ?? [];
                const files: PickedFile[] = docs.map((doc) => ({
                    id: doc[google.picker.Document.ID] ?? '',
                    name: doc[google.picker.Document.NAME] ?? '',
                    mimeType: doc[google.picker.Document.MIME_TYPE] ?? '',
                }));
                setStatus(t('picker_success'));
                returnFilesToExtension(redirectUri, files);
            } else if (action === google.picker.Action.CANCEL) {
                setStatus(t('picker_cancelled'));
                returnCancelledToExtension(redirectUri);
            }
        })
        .build();
    picker.setVisible(true);
}

function openPicker(token: string, fileId: string | null): void {
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);
    if (fileId) view.setFileIds(fileId);
    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const picker = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token)
        .addView(view)
        .setLocale(locale)
        .setCallback((data) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
                setStatus(t('picker_success'));
                window.setTimeout(() => window.close(), 800);
            } else if (action === google.picker.Action.CANCEL) {
                setStatus(t('picker_cancelled'));
            }
        })
        .build();
    picker.setVisible(true);
}

/**
 * ignoreFileId=true で setFileIds を外した全シートビューを開く。
 * href での開き直しにすると email が落ちてアカウント照合が効かなくなるため、
 * 遷移せず同一ページ内で開き直す。
 */
async function start(ignoreFileId = false): Promise<void> {
    const params = hashParams();
    // mode が無い/pdf以外の場合は既存のスプレッドシート動作を一切変えない（旧拡張が新ページを開く互換性のため）。
    const isPdfMode = params.get('mode') === 'pdf';
    const fileId = ignoreFileId ? null : params.get('fileId');
    const expectedEmail = params.get('email');
    const redirectUri = isPdfMode ? params.get('redirect') : null;

    // PDFモードは redirect が有効な拡張機能URIであることを fail-fast で検証する。
    // ここで弾かないと、ユーザーがGoogleサインイン→同意→ファイル選択まで終えた後に
    // redirectToExtension() で初めて失敗が判明し、全操作が無駄になるため。
    // redirectToExtension() 側の検証は最終防衛線としてそのまま残す。
    if (isPdfMode && (!redirectUri || !isExtensionRedirectUri(redirectUri))) {
        setStatus(t('picker_invalidRedirect'));
        return;
    }

    try {
        await waitForGoogleApis();
        const resp = await requestToken(expectedEmail);
        const token = resp.access_token;
        const actualEmail = await fetchUserEmail(token);
        if (expectedEmail && actualEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
            google.accounts.oauth2.revoke(token, () => undefined);
            setStatus(t('picker_wrongAccount', expectedEmail));
            return;
        }
        await loadPicker();
        if (isPdfMode) {
            // 上のfail-fastチェックを通過しているため、ここでは redirectUri は非nullかつ有効。
            openPdfPicker(token, params.get('folderId'), redirectUri!);
        } else {
            openPicker(token, fileId);
        }
    } catch (error) {
        setStatus(t('picker_error', (error as Error).message));
    }
}

function init(): void {
    const isPdfMode = hashParams().get('mode') === 'pdf';
    document.title = t('picker_pageTitle');
    document.getElementById('title')!.textContent = t('picker_pageTitle');
    document.getElementById('intro')!.textContent = isPdfMode ? t('picker_pdfPageIntro') : t('picker_pageIntro');
    document.getElementById('shareHint')!.textContent = t('picker_shareHint');
    document.getElementById('startBtn')!.textContent = t('picker_startBtn');
    const allSheetsLink = document.getElementById('allSheetsLink')!;
    if (isPdfMode) {
        // PDFモードには「fileId限定→全シートへ切替」の概念が無いため導線ごと隠す
        allSheetsLink.style.display = 'none';
    } else {
        allSheetsLink.textContent = t('picker_openAllSheets');
        allSheetsLink.addEventListener('click', (event) => {
            event.preventDefault();
            void start(true);
        });
    }
    document.getElementById('startBtn')!.addEventListener('click', () => void start());
}

document.addEventListener('DOMContentLoaded', init);
