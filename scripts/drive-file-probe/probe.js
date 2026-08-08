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

const state = {
    ready: false,
    signedIn: false,
    email: null,
    pickResult: null,
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
                setStatus(`サインインに失敗しました: ${resp.error}`);
                return;
            }
            accessToken = resp.access_token;
            try {
                const email = await fetchUserEmail(accessToken);
                state.email = email;
                state.signedIn = true;
                pickerBtn.disabled = false;
                setStatus(`サインイン済み: ${email}`);
                renderState();
            } catch (err) {
                setStatus(`ユーザー情報の取得に失敗しました: ${err.message}`);
            }
        },
        error_callback: (err) => {
            setStatus(`サインインがキャンセルまたは失敗しました: ${err.type}`);
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
 * ターゲット1件を測定する。
 * 戻り値の body は、失敗時はエラーJSON、成功時は meta/list なら取得したJSON、
 * media なら本文を含めない（読み捨てて status/ok だけを見る）。
 */
async function measureOne({ label, kind, id }) {
    if (!accessToken) throw new Error('サインインしていません');
    const url = buildMeasureUrl(kind, id);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    let body;
    if (kind === 'media') {
        // ファイル実体は読まずに読み捨てる。見るのは status のみ。
        if (resp.body?.cancel) {
            try {
                await resp.body.cancel();
            } catch {
                // 読み捨て失敗は無視してよい（測定結果には影響しない）
            }
        }
        body = undefined;
    } else {
        body = await readBody(resp);
    }
    return { label, kind, id, status: resp.status, ok: resp.ok, body };
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

// run.mjs（Playwright ランナー）から window.__probe.state / measure() / openPicker() /
// uploadFile() を呼べるようにする。token は含めない。
window.__probe = {
    state,
    measure,
    openPicker,
    uploadFile,
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
        ensureTokenClient().requestAccessToken();
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
