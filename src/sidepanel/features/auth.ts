/**
 * 認証関連機能モジュール
 * initApp, handleLogin, handleLogout, showProjectSection
 */

import { dom } from '../dom';
import { state } from '../state';
import { showLoading, showStatus, showToast } from '../ui/feedback';
import { getAuthToken, getUserEmail } from '../../lib/sheets-api';

// 外部関数への参照（循環依存回避）
let _loadRecentSheets: (() => Promise<void>) | null = null;
let _loadConfig: (() => Promise<void>) | null = null;
let _loadUserSettings: (() => Promise<void>) | null = null;

export function setAuthDependencies(deps: {
    loadRecentSheets: () => Promise<void>;
    loadConfig: () => Promise<void>;
    loadUserSettings: () => Promise<void>;
}) {
    _loadRecentSheets = deps.loadRecentSheets;
    _loadConfig = deps.loadConfig;
    _loadUserSettings = deps.loadUserSettings;
}

/**
 * アプリケーション初期化
 */
export async function initApp() {
    try {
        showLoading(true);

        // 設定を読み込み
        if (_loadUserSettings) {
            await _loadUserSettings();
        }

        // サイレント認証を試行
        try {
            await getAuthToken();
            // 成功したらプロジェクト選択画面へ
            await showProjectSection();
        } catch {
            // 失敗したらログインボタン表示のまま
            showLoading(false);
        }
    } catch (error) {
        console.error('Init error:', error);
        showLoading(false);
    }
}

/**
 * ログイン処理
 */
export async function handleLogin() {
    try {
        showLoading(true);
        await getAuthToken();
        await showProjectSection();
    } catch (error) {
        console.error('Login error:', error);
        showStatus('ログインに失敗しました。もう一度お試しください。', 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * ログアウト処理
 */
export async function handleLogout() {
    if (!confirm('ログアウトしますか？')) {
        return;
    }

    try {
        showLoading(true);

        // Chrome storage をクリア
        await chrome.storage.local.clear();

        // 認証トークンをクリア
        const token = await getAuthToken();
        await new Promise<void>((resolve) => {
            chrome.identity.removeCachedAuthToken({ token }, () => {
                chrome.identity.clearAllCachedAuthTokens(() => {
                    resolve();
                });
            });
        });

        // 状態をリセット
        state.resetForLogout();

        // ログイン画面に戻る
        dom.projectSection.classList.add('hidden');
        dom.screeningSection.classList.add('hidden');
        dom.loginSection.classList.remove('hidden');

        showToast('ログアウトしました');
    } catch (error) {
        console.error('Logout error:', error);
        alert(`ログアウトエラー: ${(error as Error).message}`);
    } finally {
        showLoading(false);
    }
}

/**
 * プロジェクト選択画面を表示
 */
export async function showProjectSection() {
    console.log('[showProjectSection] Starting...');

    // ログインセクションを隠してプロジェクトセクションを表示
    dom.loginSection.classList.add('hidden');
    dom.projectSection.classList.remove('hidden');
    console.log('[showProjectSection] Sections toggled');

    // ユーザー情報を取得
    try {
        const userEmail = await getUserEmail();
        state.setUserEmail(userEmail);
        console.log('[showProjectSection] Got user email:', userEmail);
    } catch (e) {
        console.error('[showProjectSection] Failed to get user email:', e);
        state.setUserEmail('');
        dom.projectSection.classList.add('hidden');
        dom.loginSection.classList.remove('hidden');
        showStatus('Googleアカウントにログインしてください', 'error');
        showLoading(false);
        return;
    }
    dom.userInfoDiv.textContent = `ログイン中: ${state.userEmail}`;

    // 最近使用したスプレッドシートを読み込み
    console.log('[showProjectSection] Loading recent sheets...');
    if (_loadRecentSheets) {
        await _loadRecentSheets();
    }
    console.log('[showProjectSection] Recent sheets loaded');

    // 保存済み設定を読み込み
    if (_loadConfig) {
        await _loadConfig();
    }
    console.log('[showProjectSection] Config loaded');

    showLoading(false);
}
