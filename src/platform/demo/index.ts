/**
 * デモモード用プラットフォームアダプタ。
 *
 * OAuth 認証を chrome.storage.local の真偽値フラグに置き換え、実ネットワーク・実 Google
 * アカウントなしで「未ログイン → ログイン → プロジェクト選択」の画面遷移を再現する。
 * storage / メッセージング / i18n / openExternal / capabilities 等の認証以外の挙動は
 * chromePlatform をそのまま再利用する（コピペを避けるため）。
 *
 * webpack.config.js の NormalModuleReplacementPlugin により、`--env demo` ビルドでは
 * '../platform/chrome' への import が本ファイルへ差し替えられる。
 *
 * chrome.storage の直接参照は .eslintrc.cjs の overrides（src/platform/demo/**）で許可済み。
 */
import type { PlatformAdapter } from '../types';
import { chromePlatform } from '../chrome';
import { DEMO_PICKER_GRANTED_STORAGE_KEY, DEMO_SIGNED_IN_STORAGE_KEY, DEMO_TOKEN } from '../../demo/constants';

async function isDemoSignedIn(): Promise<boolean> {
    const result = await chrome.storage.local.get([DEMO_SIGNED_IN_STORAGE_KEY]);
    return result[DEMO_SIGNED_IN_STORAGE_KEY] === true;
}

async function setDemoSignedIn(signedIn: boolean): Promise<void> {
    await chrome.storage.local.set({ [DEMO_SIGNED_IN_STORAGE_KEY]: signedIn });
}

/**
 * interactive=false（起動時のサイレント試行）はサインイン済みフラグが立っているときだけ
 * 成功させる。実クロームアダプタの「サイレント取得失敗 → ログイン画面表示」と同じ分岐を
 * 再現するため、interactive=false かつ未サインインの場合は必ず reject する。
 */
async function demoGetAuthToken(interactive = false): Promise<string> {
    if (await isDemoSignedIn()) {
        return DEMO_TOKEN;
    }
    if (!interactive) {
        throw new Error('Not signed in (demo mode)');
    }
    // ログインボタン押下相当。以降のサイレント試行も成功するようフラグを立てる
    await setDemoSignedIn(true);
    return DEMO_TOKEN;
}

/**
 * デモ環境では実トークンの失効・スコープ変更が起こらないため、サインイン状態を維持した
 * まま同じ固定トークンを返す（実アダプタの「破棄して再認可」に相当する体験のみ模す）。
 */
async function demoForceReauth(): Promise<string> {
    await setDemoSignedIn(true);
    return DEMO_TOKEN;
}

async function demoClearAuth(): Promise<void> {
    await setDemoSignedIn(false);
}

/** Google Picker 許可ページ（src/lib/picker-url.ts の buildPickerUrl が作るURL）かを判定する */
export function isDemoPickerUrl(url: string): boolean {
    try {
        return new URL(url).pathname.endsWith('/picker.html');
    } catch {
        return false;
    }
}

/**
 * ?demoPickerRequired=1 が付いているか。src/demo/profile.ts の resolveDemoPickerRequired() と
 * 同じ式（platform/demo から src/demo/profile.ts は import できないため、ここに同じ判定を持つ）。
 * 呼び出しのたびにクエリを同期的に読む。
 */
function isDemoPickerRequired(): boolean {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('demoPickerRequired') === '1';
}

/**
 * ?demoPickerRequired=1 のときだけ、Picker のURLを新しいタブで開かず「許可済み」の印を立てる
 * （未許可状態の再現用。印を読むのは src/demo/fetch-mock.ts）。fetch モックが同期的に読めるよう、
 * globalThis と sessionStorage（ページを開き直しても残す）の両方へ書く。
 * クエリが無いとき、および Picker 以外のURLは従来どおり開く。
 */
function demoOpenExternal(url: string): void {
    if (!isDemoPickerRequired() || !isDemoPickerUrl(url)) {
        chromePlatform.openExternal(url);
        return;
    }
    globalThis.__tiabDemoPickerGranted = true;
    try {
        sessionStorage.setItem(DEMO_PICKER_GRANTED_STORAGE_KEY, '1');
    } catch {
        /* sessionStorage が使えなくても globalThis の印で足りる */
    }
}

export const demoPlatform: PlatformAdapter = {
    ...chromePlatform,
    openExternal: demoOpenExternal,
    getAuthToken: demoGetAuthToken,
    forceReauth: demoForceReauth,
    clearAuth: demoClearAuth,
};

// webpack の NormalModuleReplacementPlugin は「'../platform/chrome' への import をこのファイルへ
// 差し替える」ことしか行わない。差し替え後も呼び出し側（sidepanel.ts 等）は
// `import { chromePlatform } from '../platform/chrome'` という名前で束縛しているため、
// 同名のエクスポートをここにも用意しておく必要がある。
export { demoPlatform as chromePlatform };
