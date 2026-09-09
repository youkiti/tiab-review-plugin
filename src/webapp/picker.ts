import { getMessage } from '../platform/web/i18n';
import {
    isExtensionRedirectUri,
    isRegrantFileIdsComplete,
    isSharedDrivesRequested,
    parseRegrantFileIds,
    PICKER_DRIVES_PARAM,
    PICKER_FILE_IDS_COUNT_PARAM,
    PICKER_FILE_IDS_END_PARAM,
    PICKER_FILE_IDS_PARAM,
} from '../lib/picker-url';

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

/**
 * mode=regrant で fileIds を受け取ったときだけ #regrantInfo に表示する
 * （fileIds がURLの途中で切り詰められて欠落する事態を画面上で見えるようにする対策）。
 *
 * **init() から呼ぶ（start() からは呼ばない）。** fileIds/fileIdsCount/fileIdsEnd はどれも
 * URLフラグメントから読むだけでトークン取得を待つ必要が無い一方、start() の最後は
 * openRegrantPicker() が picker.setVisible(true) でPickerをモーダル表示してしまい、
 * その陰に隠れてユーザーの目に触れなくなる。init() はDOMContentLoadedで即座に走るため、
 * 「Google Pickerを開く」を押す前のランディング画面の時点でこの表示が見える。
 *
 * 判定は次の優先順位（fileIdsCountParam が数字として渡っているかどうかで大きく分岐する）:
 * 1. fileIdsCount が無い/数字以外 → 拡張機能側の送信件数と比較できない。
 *    - 受信件数が0件なら、fileIds自体が渡されていない従来経路（フォルダ全体の初期表示）と
 *      判別できないため、ここだけ何も表示しない（#regrantInfo を書き換えない）
 *    - 受信件数が1件以上なら、旧バージョンの拡張機能からの起動とみなし受信件数のみ表示
 * 2. fileIdsCount が数字として渡っている → 番兵（fileIdsEnd）を見る
 *    - 番兵が `'1'` でない（欠落・改変）→ 件数の一致/不一致を問わず「切り詰めの疑いあり」
 *      警告（picker_regrantTruncated）。件数が一致していても末尾の fileId が途中で切れて
 *      文字種の検証をたまたま通過している可能性があるため、件数一致は安全の証拠にならない
 *    - 番兵が `'1'` で件数が不一致 → 従来の食い違い警告（picker_regrantCountMismatch）
 *    - 番兵が `'1'` で件数も一致 → 受信件数のみ表示
 *
 * なお番兵だけが失われる位置でURLが切れた場合（fileIds本体は無事）も1.と同じ「切り詰めの
 * 疑いあり」判定になる（偽陽性）。診断が「異常なし」と誤答するより警告側に倒す方が安全という
 * 判断で、意図した挙動（picker-url.ts の PICKER_FILE_IDS_END_PARAM 参照）。
 *
 * mode=regrant 以外のモードから呼ばれることも無い（init() で isRegrantMode のときだけ呼ぶ）
 * ため、他モードの見た目は変わらない。
 */
function updateRegrantInfo(fileIds: string[], fileIdsCountParam: string | null, fileIdsEndParam: string | null): void {
    const el = document.getElementById('regrantInfo');
    if (!el) return;
    const received = fileIds.length;
    const sent = fileIdsCountParam !== null && /^\d+$/.test(fileIdsCountParam) ? Number(fileIdsCountParam) : null;

    if (sent === null) {
        // fileIdsCount と比較できない。fileIds自体が渡されていない従来経路（受信0件）との
        // 区別ができないため、ここだけ早期returnで何も表示しない。
        if (received === 0) return;
        el.textContent = t('picker_regrantReceivedCount', String(received));
        return;
    }

    if (!isRegrantFileIdsComplete(fileIdsEndParam)) {
        el.textContent = t('picker_regrantTruncated', [String(sent), String(received)]);
    } else if (sent !== received) {
        el.textContent = t('picker_regrantCountMismatch', [String(sent), String(received)]);
    } else {
        el.textContent = t('picker_regrantReceivedCount', String(received));
    }
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

function requestToken(email: string | null, prompt: 'consent' | 'select_account' = 'consent'): Promise<google.accounts.oauth2.TokenResponse> {
    return new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: __WEB_OAUTH_CLIENT_ID__,
            scope: `${DRIVE_FILE_SCOPE} ${USERINFO_SCOPE}`,
            login_hint: email || undefined,
            include_granted_scopes: false,
            callback: (resp) => resp.error ? reject(new Error(resp.error)) : resolve(resp),
            error_callback: (err) => reject(new Error(err.type)),
        });
        client.requestAccessToken({ prompt });
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
 * fileIds 指定モードの一括再付与用の1枚ビュー（Issue #203）。setFileIds は setParent /
 * setEnableDrives と併用禁止（Google公式ドキュメント: 併用すると後勝ちで上書きされる）
 * なので、setParent・setEnableDrives・setOwnedByMe はいずれも呼ばない。ID で直接引くため
 * 所有者別に2枚へ分ける（buildDocsViews の owned/shared 分割）意味も無い。
 * setMimeTypes も呼ばない: fileId で表示対象が既に確定しているのでMIMEによる絞り込みは
 * 冗長であり、万一PDFが application/pdf 以外のMIMEで保存されていた場合に、
 * 復旧したいファイルを取りこぼすだけになるため。
 */
function buildRegrantFileIdsView(fileIds: string[]): google.picker.DocsView {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    view.setFileIds(fileIds.join(','));
    view.setLabel(t('picker_regrantTargetsViewLabel'));
    return view;
}

/**
 * 再付与モード用Picker: 返す payload が openPdfPicker と決定的に違う。
 *
 * mode=pdf は選択ファイルの一覧を返すが、再付与は数百件を一度に選びうるため、一覧を
 * URLフラグメントに載せると巨大化してリダイレクト捕捉が壊れる恐れがある。しかも
 * drive.file の付与はユーザーが「選択」を押した時点でサーバー側に確定しており、
 * 拡張機能が一覧そのものを受け取る必要が無い。拡張機能側は返ってきた件数を表示に
 * 使うだけで、実際に読めるようになったかどうかの真値は再度の files.list で取り直す
 * （src/lib/fulltext-access.ts / listAccessibleFileIdsInFolder 参照）。
 *
 * ビューは fileIds の有無で分岐する（Issue #203）:
 * - fileIds が非空: buildRegrantFileIdsView の1枚だけ（setFileIds は setParent /
 *   setEnableDrives と併用不可のため）
 * - fileIds が空: 従来どおり folderId を初期表示にした DocsView を
 *   buildDocsViews で owned/shared の2枚組み立てる（フルテキスト用フォルダは
 *   プロジェクトのオーナーが所有し共同研究者に共有される運用のため。Issue #75）
 *
 * PickerBuilder 側（developerKey/appId/OAuthToken/複数選択/locale/callback）は
 * どちらの分岐でも共通のため、ビューの配列だけを作り分けてから1本の組み立てに合流させる。
 */
function openRegrantPicker(
    token: string,
    folderId: string | null,
    fileIds: string[],
    redirectUri: string,
    enableDrives: boolean,
): void {
    const views: google.picker.DocsView[] = fileIds.length > 0
        ? [buildRegrantFileIdsView(fileIds)]
        : buildDocsViews(google.picker.ViewId.DOCS, (view) => {
            view.setMimeTypes('application/pdf');
            if (folderId) view.setParent(folderId);
        }, enableDrives);

    const locale = navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    let builder = new google.picker.PickerBuilder()
        .setDeveloperKey(__PICKER_API_KEY__)
        .setAppId(__GCP_PROJECT_NUMBER__)
        .setOAuthToken(token);
    for (const view of views) builder = builder.addView(view);
    const picker = builder
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
async function start(ignoreFileId = false, forceAccountSelection = false): Promise<void> {
    const switchAccountBtn = document.getElementById('switchAccountBtn')!;
    switchAccountBtn.hidden = true;
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
        const resp = await requestToken(expectedEmail, forceAccountSelection ? 'select_account' : 'consent');
        const token = resp.access_token;
        const actualEmail = await fetchUserEmail(token);
        if (expectedEmail && actualEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
            // revoke はプロジェクト全体の付与を取り消すため、アカウント選択ミスの復旧には使わない。
            setStatus(t('picker_wrongAccount', [expectedEmail, actualEmail]));
            switchAccountBtn.hidden = false;
            return;
        }
        await loadPicker();
        if (isPdfMode) {
            // 上のfail-fastチェックを通過しているため、ここでは redirectUri は非nullかつ有効。
            openPdfPicker(token, params.get('folderId'), redirectUri!, enableDrives);
        } else if (isRegrantMode) {
            const fileIds = parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM));
            openRegrantPicker(token, params.get('folderId'), fileIds, redirectUri!, enableDrives);
        } else {
            openPicker(token, fileId, enableDrives);
        }
    } catch (error) {
        setStatus(t('picker_error', (error as Error).message));
    }
}

function init(): void {
    const params = hashParams();
    const mode = params.get('mode');
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
    if (isRegrantMode) {
        // fileIds/fileIdsCount/fileIdsEnd はURLフラグメントから読むだけなので、トークン取得
        // (start())を待たずにここで表示する（「Google Pickerを開く」を押す前のランディング
        // 画面に出す）。
        const fileIds = parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM));
        updateRegrantInfo(fileIds, params.get(PICKER_FILE_IDS_COUNT_PARAM), params.get(PICKER_FILE_IDS_END_PARAM));
    }
    document.getElementById('startBtn')!.textContent = t('picker_startBtn');
    const switchAccountBtn = document.getElementById('switchAccountBtn')!;
    switchAccountBtn.textContent = t('picker_switchAccountBtn');
    switchAccountBtn.addEventListener('click', () => void start(false, true));
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
