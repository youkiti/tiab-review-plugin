import { getMessage } from '../platform/web/i18n';
import { isExtensionRedirectUri, isSharedDrivesRequested, PICKER_DRIVES_PARAM } from '../lib/picker-url';

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
 * 再付与モード（mode=regrant）の結果を拡張機能へ返す。選択ファイルの一覧ではなく
 * 選択件数だけを返す（詳細は openRegrantPicker のコメント参照）。
 */
function returnGrantedCountToExtension(redirectUri: string, count: number): void {
    redirectToExtension(redirectUri, `granted=${count}`);
}

/**
 * マイドライブ向け・共有アイテム向け（setOwnedByMe(false)）の2枚のビューを組にして返す。
 * 既定の DocsView はマイドライブ配下のみが対象で、共有されただけでマイドライブに
 * 追加していないファイルは一覧にも検索結果にも出てこない（Issue #75）。configure は
 * setFileIds/setMimeTypes/setParent 等の絞り込みを両方のビューへ同一に適用するために使う
 * （片方だけに適用すると、オーナー本人か共有を受けた側かのどちらかで従来どおり出てこない）。
 * ラベルはビューごとに異なる値のため configure の外で個別に設定する。既定ラベルのままだと
 * 同名タブが2つ並んで見分けが付かなくなるため（PR #77）。
 *
 * enableDrives は共有ドライブ（Shared drives）をビューの対象に含めるかどうか（Issue #80）。
 * **2枚とも同じ値を適用する。** 共有ドライブ上のファイルは組織（ドライブ自身）が所有し、
 * 個人オーナーが存在しないため `ownedByMe` のどちら側に落ちるかが自明でなく、片方だけに
 * 適用すると環境によって出たり出なかったりする不安定な状態を作りうるため。
 */
function buildDocsViews(
    viewId: google.picker.ViewId,
    configure: (view: google.picker.DocsView) => void,
    enableDrives: boolean,
): [google.picker.DocsView, google.picker.DocsView] {
    const applyDrives = (view: google.picker.DocsView): void => {
        // 無効時は呼ばない（既定の挙動をそのまま維持し、setEnableDrives(false) の解釈に依存しないため）
        if (enableDrives) view.setEnableDrives(true);
    };
    const ownedView = new google.picker.DocsView(viewId);
    ownedView.setLabel(t('picker_ownedViewLabel'));
    applyDrives(ownedView);
    configure(ownedView);
    const sharedView = new google.picker.DocsView(viewId);
    sharedView.setOwnedByMe(false);
    sharedView.setLabel(t('picker_sharedViewLabel'));
    applyDrives(sharedView);
    configure(sharedView);
    return [ownedView, sharedView];
}

/**
 * PDFモード用Picker: DocsView(DOCS) を application/pdf に絞り込み、複数選択を許可する。
 * folderId があれば初期表示フォルダとして使う（アクセス範囲の制限ではなく表示上の絞り込みのみ）。
 * フルテキスト用フォルダはプロジェクトのオーナーが所有し共同研究者に共有される運用のため、
 * 共有アイテムビューも addView する（Issue #75）。
 * PICKED/CANCEL のいずれも window.location.href で拡張機能のリダイレクトURIへ遷移して結果を返す。
 */
function openPdfPicker(token: string, folderId: string | null, redirectUri: string, enableDrives: boolean): void {
    const [ownedView, sharedView] = buildDocsViews(google.picker.ViewId.DOCS, (view) => {
        view.setMimeTypes('application/pdf');
        if (folderId) view.setParent(folderId);
    }, enableDrives);
    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const picker = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token)
        .addView(ownedView)
        .addView(sharedView)
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

/**
 * 再付与モード用Picker: openPdfPicker とほぼ同じ見た目（DocsView(DOCS) を application/pdf に
 * 絞り込み、folderId を初期表示、複数選択可）だが、返す payload が決定的に違う。
 *
 * mode=pdf は選択ファイルの一覧を返すが、再付与は数百件を一度に選びうるため、一覧を
 * URLフラグメントに載せると巨大化してリダイレクト捕捉が壊れる恐れがある。しかも
 * drive.file の付与はユーザーが「選択」を押した時点でサーバー側に確定しており、
 * 拡張機能が一覧そのものを受け取る必要が無い。拡張機能側は返ってきた件数を表示に
 * 使うだけで、実際に読めるようになったかどうかの真値は再度の files.list で取り直す
 * （src/lib/fulltext-access.ts / listAccessibleFileIdsInFolder 参照）。
 *
 * フルテキスト用フォルダはプロジェクトのオーナーが所有し共同研究者に共有される運用のため、
 * openPdfPicker と同様に共有アイテムビューも addView する（Issue #75）。
 */
function openRegrantPicker(token: string, folderId: string | null, redirectUri: string, enableDrives: boolean): void {
    const [ownedView, sharedView] = buildDocsViews(google.picker.ViewId.DOCS, (view) => {
        view.setMimeTypes('application/pdf');
        if (folderId) view.setParent(folderId);
    }, enableDrives);
    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const picker = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token)
        .addView(ownedView)
        .addView(sharedView)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setLocale(locale)
        .setCallback((data) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
                const docs = data[google.picker.Response.DOCUMENTS] ?? [];
                setStatus(t('picker_success'));
                returnGrantedCountToExtension(redirectUri, docs.length);
            } else if (action === google.picker.Action.CANCEL) {
                setStatus(t('picker_cancelled'));
                returnCancelledToExtension(redirectUri);
            }
        })
        .build();
    picker.setVisible(true);
}

/**
 * スプレッドシート選択用Picker: マイドライブ向けビューに加えて、共有アイテム向けビュー
 * （setOwnedByMe(false)）も addView する。自分がオーナーではなく共有を受けただけの
 * スプレッドシートは、既定のビューだけでは一覧にも検索結果にも出てこないため（Issue #75）。
 * fileId が指定されている場合は両方のビューに setFileIds する（片方だけだと、
 * シートのオーナーか共有を受けた側かのどちらかで従来どおり出てこないままになる）。
 */
function openPicker(token: string, fileId: string | null, enableDrives: boolean): void {
    const [ownedView, sharedView] = buildDocsViews(google.picker.ViewId.SPREADSHEETS, (view) => {
        if (fileId) view.setFileIds(fileId);
    }, enableDrives);
    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const picker = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token)
        .addView(ownedView)
        .addView(sharedView)
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
    // mode が無い/pdf・regrant以外の場合は既存のスプレッドシート動作を一切変えない
    // （旧拡張が新ページを開く互換性のため）。
    const mode = params.get('mode');
    const isPdfMode = mode === 'pdf';
    const isRegrantMode = mode === 'regrant';
    const fileId = ignoreFileId ? null : params.get('fileId');
    const expectedEmail = params.get('email');
    const redirectUri = (isPdfMode || isRegrantMode) ? params.get('redirect') : null;
    // 共有ドライブ対応は拡張機能が drives=1 を明示的に渡したときだけ有効にする。
    // Pickerページは GitHub Pages から配信され旧バージョンの拡張機能にも即時反映されるため、
    // ページ側で無条件に有効化しない（詳細は picker-url.ts の PICKER_DRIVES_PARAM）。
    const enableDrives = isSharedDrivesRequested(params.get(PICKER_DRIVES_PARAM));

    // PDF/再付与モードは redirect が有効な拡張機能URIであることを fail-fast で検証する。
    // ここで弾かないと、ユーザーがGoogleサインイン→同意→ファイル選択まで終えた後に
    // redirectToExtension() で初めて失敗が判明し、全操作が無駄になるため。
    // redirectToExtension() 側の検証は最終防衛線としてそのまま残す。
    if ((isPdfMode || isRegrantMode) && (!redirectUri || !isExtensionRedirectUri(redirectUri))) {
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
            openPdfPicker(token, params.get('folderId'), redirectUri!, enableDrives);
        } else if (isRegrantMode) {
            openRegrantPicker(token, params.get('folderId'), redirectUri!, enableDrives);
        } else {
            openPicker(token, fileId, enableDrives);
        }
    } catch (error) {
        setStatus(t('picker_error', (error as Error).message));
    }
}

function init(): void {
    const mode = hashParams().get('mode');
    const isPdfMode = mode === 'pdf';
    const isRegrantMode = mode === 'regrant';
    document.title = t('picker_pageTitle');
    document.getElementById('title')!.textContent = t('picker_pageTitle');
    document.getElementById('intro')!.textContent = isPdfMode
        ? t('picker_pdfPageIntro')
        : isRegrantMode
            ? t('picker_regrantPageIntro')
            : t('picker_pageIntro');
    document.getElementById('shareHint')!.textContent = (isPdfMode || isRegrantMode)
        ? t('picker_pdfShareHint')
        : t('picker_shareHint');
    document.getElementById('startBtn')!.textContent = t('picker_startBtn');
    const allSheetsLink = document.getElementById('allSheetsLink')!;
    if (isPdfMode || isRegrantMode) {
        // PDF/再付与モードには「fileId限定→全シートへ切替」の概念が無いため導線ごと隠す
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
