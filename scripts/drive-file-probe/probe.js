// Drive File Probe: drive.file スコープの付与挙動を実機測定するためのページ側スクリプト。
//
// window.__probe に Playwright ランナー（run.mjs）から叩ける API を生やす。
// アクセストークンは絶対に window / state / ログ・コンソールへ露出させない
// （AGENTS.md CRITICAL PROTOCOL 9。露出してよいのはメールアドレスのみ）。
//
// kind ('meta' / 'media' / 'list') を3種類に分けている理由:
// src/lib/drive-api.ts の folderExists()（metadata GET）と downloadDriveFile()
// （alt=media）は別々のAPI呼び出しであり、drive.file の未付与時にどちらも404には
// なるが、付与範囲の検証では「メタデータだけ見えて実体は読めない」といった
// ズレが起きうるかを区別して観測する価値があるため、独立した kind として計測する。

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// アクセストークンはこのモジュール内のクロージャ変数にのみ保持し、外部へは渡さない。
let accessToken = null;
let tokenClient = null;
let config = null;
// GIS の prompt を silent → consent の順で試すための状態。
// 'silent': 無人取得を試行中。'consent': silent が失敗し対話的に再試行中。
let signInStage = null;

const state = {
    ready: false,
    signedIn: false,
    email: null,
    pickResult: null,
    lastError: null,
};

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const signinBtn = document.getElementById('signin');
const pickerBtn = document.getElementById('open-picker');

function setStatus(text) {
    statusEl.textContent = text;
}

function renderState() {
    // state には token を一切含めていないため、そのまま表示してよい。
    resultEl.textContent = JSON.stringify(state, null, 2);
}

function waitForGoogleApis() {
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
                reject(new Error('Google の API スクリプトを読み込めませんでした'));
            }
        }, 100);
    });
}

function loadPicker() {
    return new Promise((resolve) => gapi.load('picker', resolve));
}

async function fetchUserEmail(token) {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`userinfo ${resp.status}`);
    const data = await resp.json();
    if (!data.email) throw new Error('userinfo のレスポンスに email がありません');
    return data.email;
}

/**
 * サインイン失敗（callback の resp.error / error_callback）を一箇所で処理する。
 * silent 取得中の失敗は「まだ同意していないだけ」の想定内分岐なので、エラー扱いにせず
 * consent 付きで自動的に再試行する。consent での再試行が失敗した場合のみ本当の失敗として
 * state.lastError に記録する（run.mjs の ctx.signIn() はこれを見て即座に失敗を判定する）。
 */
function handleSignInFailure(message) {
    if (signInStage === 'silent') {
        signInStage = 'consent';
        setStatus('初回のサインインが必要です。ブラウザで操作してください（アカウント選択・スコープ同意）');
        tokenClient.requestAccessToken({ prompt: 'consent' });
        return;
    }
    state.lastError = message;
    setStatus(message);
    renderState();
}

function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: config.WEB_OAUTH_CLIENT_ID,
        scope: SCOPES,
        // 既定値(true)のままだと過去に許可した全スコープが引き継がれてしまい、
        // drive.file 単体の付与挙動を測るという目的が崩れるため明示的に false にする。
        include_granted_scopes: false,
        callback: async (resp) => {
            if (resp.error) {
                handleSignInFailure(`サインインに失敗しました: ${resp.error}`);
                return;
            }
            signInStage = null;
            accessToken = resp.access_token;
            try {
                const email = await fetchUserEmail(accessToken);
                state.email = email;
                state.signedIn = true;
                pickerBtn.disabled = false;
                setStatus(`サインイン済み: ${email}`);
                renderState();
            } catch (err) {
                const message = `ユーザー情報の取得に失敗しました: ${err.message}`;
                setStatus(message);
                state.lastError = message;
                renderState();
            }
        },
        error_callback: (err) => {
            handleSignInFailure(`サインインがキャンセルまたは失敗しました: ${err.type}`);
        },
    });
    return tokenClient;
}

async function readBody(resp) {
    const text = await resp.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * options.allDrives（既定 false）を立てると、共有ドライブ配下のファイルを読むのに
 * 必要とされる Drive API v3 のパラメータを付与する（meta/media は supportsAllDrives=true、
 * list はそれに加えて includeItemsFromAllDrives=true）。list はさらに options.driveId が
 * あれば corpora=drive&driveId=<driveId> も付与する（共有ドライブ配下の files.list に
 * この指定が要るかどうかが未確定なため、有無どちらも測れるようにしてある）。
 * allDrives / driveId のどちらも指定しない呼び出し（既存3シナリオ）では、meta の fields に
 * driveId を追加した点を除き、これまでと同じURLになる。
 */
function buildMeasureUrl(kind, id, options = {}) {
    const { allDrives = false, driveId } = options;
    switch (kind) {
        case 'meta': {
            // driveId は共有ドライブ配下かどうかの判定と、list の corpora=drive 用の
            // driveId 取得に要るため常に取得する。
            let url = `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,parents,driveId`;
            if (allDrives) url += '&supportsAllDrives=true';
            return url;
        }
        case 'media': {
            let url = `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?alt=media`;
            if (allDrives) url += '&supportsAllDrives=true';
            return url;
        }
        case 'list': {
            let url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=${encodeURIComponent('files(id,name,mimeType)')}`;
            if (allDrives) url += '&supportsAllDrives=true&includeItemsFromAllDrives=true';
            if (driveId) url += `&corpora=drive&driveId=${encodeURIComponent(driveId)}`;
            return url;
        }
        default:
            throw new Error(`未知の kind です: ${kind}`);
    }
}

/**
 * エラーレスポンスの body から、人間が読みやすい失敗理由を1つ取り出す。
 * `body.error.errors[0].reason` があればそれを、無ければ `body.error.message` を、
 * どちらも取れなければ空文字を返す。
 */
function getErrorReason(body) {
    if (body && typeof body === 'object' && body.error) {
        const reason = body.error.errors?.[0]?.reason;
        if (reason) return reason;
        if (body.error.message) return body.error.message;
    }
    return '';
}

/**
 * ターゲット1件を測定する。
 * 戻り値の body は、meta/list なら成功・失敗いずれも取得した JSON（非JSONならテキスト）。
 * media は成功時も Content-Type と本文の先頭64バイトだけを読む（実体は読み切らない）。
 * 失敗時のみ summary のエラー理由を出すために本文を読む。
 * summary は一目でわかる要約文字列（list は件数「N件」、meta はファイル名、media は
 * バイト数・Content-Type・先頭バイト。いずれも失敗時はエラー理由、取得できなければ空文字）。
 *
 * media で先頭バイトまで見る理由: `alt=media` は googleusercontent.com へリダイレクトしうるため、
 * 「HTTP 200 なのに中身が PDF ではない（エラーページ等）」が起こりうる。status と ok だけを見ると
 * それを成功と誤読する。実測でも未付与のはずのファイルが `alt=media` + supportsAllDrives で
 * 200 を返した例があり（output/2026-08-15T05-36-07）、中身の判別が要る。
 * 本体の downloadDriveFile()（src/lib/drive-api.ts）も resp.ok だけを見て blob を返しているため、
 * ここで得た知見はそのまま本体の判定条件の設計に効く。
 */
async function measureOne({ label, kind, id, allDrives, driveId }) {
    if (!accessToken) throw new Error('サインインしていません');
    const url = buildMeasureUrl(kind, id, { allDrives, driveId });
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    let body;
    let summary;
    // media 専用の観測値。meta/list では undefined のままにする。
    let contentType;
    let head = '';
    let isPdf;
    if (kind === 'media') {
        if (resp.ok) {
            contentType = resp.headers.get('content-type') ?? '';
            const contentLength = resp.headers.get('content-length');
            // 先頭の1チャンクだけ読んで実体を判別し、残りは読まずに捨てる。
            // PDF なら本文は `%PDF-` で始まる。HTML のエラーページ等はここで露見する。
            try {
                const reader = resp.body?.getReader?.();
                if (reader) {
                    const { value } = await reader.read();
                    if (value) head = new TextDecoder().decode(value.slice(0, 64));
                    await reader.cancel();
                }
            } catch {
                // 先頭が読めなくても status/Content-Type は測定できているので続行する
            }
            isPdf = head.startsWith('%PDF-');
            body = undefined;
            summary =
                `${contentLength ? `${contentLength} bytes` : 'サイズ不明'} / ${contentType || 'Content-Type不明'}` +
                ` / ${isPdf ? 'PDF実体' : `PDFではない（先頭: ${JSON.stringify(head.slice(0, 24))}）`}`;
        } else {
            // 404 と 403 の区別はステータスでできるが、理由を summary に出すには本文が要る。
            body = await readBody(resp);
            summary = getErrorReason(body);
        }
    } else {
        body = await readBody(resp);
        if (resp.ok) {
            summary = kind === 'list' ? `${body?.files?.length ?? 0}件` : body?.name ?? '';
        } else {
            summary = getErrorReason(body);
        }
    }
    return {
        label, kind, id,
        allDrives: !!allDrives, corporaDriveId: driveId,
        status: resp.status, ok: resp.ok, body, summary,
        // media の成功時のみ入る（raw.json に残して後から中身を検証できるようにする）
        contentType, head: head || undefined, isPdf,
    };
}

async function measure(targets) {
    const results = [];
    for (const target of targets) {
        results.push(await measureOne(target));
    }
    renderState();
    return results;
}

/**
 * Picker を開く。selectFolder / mimeTypes / parentId は google.picker.DocsView の
 * setIncludeFolders + setSelectFolderEnabled / setMimeTypes / setParent に対応する。
 * setDeveloperKey と setAppId の両方を設定しないと drive.file の付与が起きないため必須。
 *
 * options.enableDrives（既定 false）: view.setEnableDrives(true) を呼び、共有ドライブを
 * Picker に表示させるかどうかを切り替える。GitHub Issue #80 で「共有ドライブが Picker に
 * 出ないため詰む」と推測されている挙動を、有無どちらでも実機確認できるようにするため。
 * options.multiSelect（既定 false）: PickerBuilder に MULTISELECT_ENABLED を有効化する。
 * 複数ファイルのうち一部だけを選ばせる測定（shared-drive-list シナリオ）に要る。
 */
async function openPicker(options = {}) {
    if (!accessToken) throw new Error('サインインしていません');
    await loadPicker();
    return new Promise((resolve, reject) => {
        try {
            const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
            if (options.selectFolder) {
                view.setIncludeFolders(true);
                view.setSelectFolderEnabled(true);
            }
            if (options.mimeTypes) view.setMimeTypes(options.mimeTypes);
            if (options.parentId) view.setParent(options.parentId);
            if (options.enableDrives) view.setEnableDrives(true);
            const builder = new google.picker.PickerBuilder()
                .setDeveloperKey(config.PICKER_API_KEY)
                .setAppId(config.GCP_PROJECT_NUMBER)
                .setOAuthToken(accessToken)
                .addView(view);
            if (options.multiSelect) builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
            const picker = builder
                .setCallback((data) => {
                    const action = data[google.picker.Response.ACTION];
                    if (action === google.picker.Action.PICKED) {
                        const docs = data[google.picker.Response.DOCUMENTS] ?? [];
                        state.pickResult = docs.map((doc) => ({
                            id: doc[google.picker.Document.ID],
                            name: doc[google.picker.Document.NAME],
                            mimeType: doc[google.picker.Document.MIME_TYPE],
                        }));
                        setStatus('Picker で選択しました');
                    } else if (action === google.picker.Action.CANCEL) {
                        state.pickResult = { cancelled: true };
                        setStatus('Picker をキャンセルしました');
                    }
                    renderState();
                })
                .build();
            picker.setVisible(true);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * 予備API: Drive へ小さなファイルをアップロードする（今後のシナリオ用）。
 * content は文字列を想定（テキスト or 小さいバイナリで十分な用途向け）。
 * allDrives（既定 false）を立てると supportsAllDrives=true を付与する。
 */
async function uploadFile({ folderId, name, content, allDrives }) {
    if (!accessToken) throw new Error('サインインしていません');
    const boundary = `probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({
        name,
        parents: folderId ? [folderId] : undefined,
        mimeType: 'text/plain',
    });
    const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content ?? ''}\r\n` +
        `--${boundary}--`;
    let url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`;
    if (allDrives) url += '&supportsAllDrives=true';
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
    });
    const data = await readBody(resp);
    return { status: resp.status, ok: resp.ok, body: data };
}

/**
 * 予備API: Drive上の既存ファイルを files.copy で複製する（今後のシナリオ用）。
 * src/lib/drive-api.ts の copyPdfToFulltextFolder() と同条件で測るため、
 * リクエストボディに appProperties も含めて送る。
 * fields に parents を含めているのが本質: 複製先が本当に指定した folderId になっているか
 * （Drive が黙って別の場所へ複製していないか）をレスポンスから直接確認するため。
 * allDrives（既定 false）を立てると supportsAllDrives=true を付与する。
 */
async function copyFile({ sourceFileId, folderId, name, appProperties, allDrives }) {
    if (!accessToken) throw new Error('サインインしていません');
    let url = `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id,name,parents,webViewLink`;
    if (allDrives) url += '&supportsAllDrives=true';
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, parents: [folderId], appProperties }),
    });
    const data = await readBody(resp);
    return { status: resp.status, ok: resp.ok, body: data };
}

// run.mjs（Playwright ランナー）から window.__probe.state / measure() / openPicker() /
// uploadFile() / copyFile() を呼べるようにする。token は含めない。
window.__probe = {
    state,
    measure,
    openPicker,
    uploadFile,
    copyFile,
    // run.mjs の ctx.pick() が #open-picker クリック前にセットする Picker オプション
    pickOptions: {},
};

async function init() {
    setStatus('設定を取得しています...');
    const resp = await fetch('/config.json');
    if (!resp.ok) throw new Error(`/config.json の取得に失敗しました (HTTP ${resp.status})`);
    config = await resp.json();

    setStatus('Google の API を読み込んでいます...');
    await waitForGoogleApis();
    ensureTokenClient();
    await loadPicker();

    signinBtn.addEventListener('click', () => {
        state.lastError = null;
        signInStage = 'silent';
        setStatus('サインインを試みています...');
        ensureTokenClient().requestAccessToken({ prompt: '' });
    });
    pickerBtn.addEventListener('click', () => {
        void openPicker(window.__probe.pickOptions || {});
    });

    state.ready = true;
    setStatus('準備完了です。「サインイン」ボタンを押してください。');
    renderState();
}

init().catch((err) => {
    setStatus(`初期化に失敗しました: ${err.message}`);
});
