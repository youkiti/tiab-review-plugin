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

function buildMeasureUrl(kind, id) {
    switch (kind) {
        case 'meta':
            return `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,parents`;
        case 'media':
            return `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?alt=media`;
        case 'list':
            return `${DRIVE_API_BASE}/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=${encodeURIComponent('files(id,name,mimeType)')}`;
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
 * media は成功時は読み捨てて undefined（status/ok だけを見る）、失敗時のみ summary の
 * エラー理由を出すために本文を読む。
 * summary は一目でわかる要約文字列（list は件数「N件」、meta はファイル名、media は
 * Content-Length 由来のバイト数「N bytes」。いずれも失敗時はエラー理由、取得できなければ空文字）。
 */
async function measureOne({ label, kind, id }) {
    if (!accessToken) throw new Error('サインインしていません');
    const url = buildMeasureUrl(kind, id);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    let body;
    let summary;
    if (kind === 'media') {
        if (resp.ok) {
            // ファイル実体は読まずに読み捨てる。見るのは status と Content-Length のみ。
            if (resp.body?.cancel) {
                try {
                    await resp.body.cancel();
                } catch {
                    // 読み捨て失敗は無視してよい（測定結果には影響しない）
                }
            }
            body = undefined;
            const contentLength = resp.headers.get('content-length');
            summary = contentLength ? `${contentLength} bytes` : '';
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
    return { label, kind, id, status: resp.status, ok: resp.ok, body, summary };
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
            const picker = new google.picker.PickerBuilder()
                .setDeveloperKey(config.PICKER_API_KEY)
                .setAppId(config.GCP_PROJECT_NUMBER)
                .setOAuthToken(accessToken)
                .addView(view)
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
 */
async function uploadFile({ folderId, name, content }) {
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
    const resp = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`, {
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
 */
async function copyFile({ sourceFileId, folderId, name, appProperties }) {
    if (!accessToken) throw new Error('サインインしていません');
    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id,name,parents,webViewLink`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name, parents: [folderId], appProperties }),
        }
    );
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
