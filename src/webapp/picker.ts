import { getMessage } from '../platform/web/i18n';

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

async function start(): Promise<void> {
    const params = hashParams();
    const fileId = params.get('fileId');
    const expectedEmail = params.get('email');
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
        openPicker(token, fileId);
    } catch (error) {
        setStatus(t('picker_error', (error as Error).message));
    }
}

function init(): void {
    document.title = t('picker_pageTitle');
    document.getElementById('title')!.textContent = t('picker_pageTitle');
    document.getElementById('intro')!.textContent = t('picker_pageIntro');
    document.getElementById('shareHint')!.textContent = t('picker_shareHint');
    document.getElementById('startBtn')!.textContent = t('picker_startBtn');
    document.getElementById('allSheetsLink')!.textContent = t('picker_openAllSheets');
    document.getElementById('startBtn')!.addEventListener('click', () => void start());
}

document.addEventListener('DOMContentLoaded', init);
