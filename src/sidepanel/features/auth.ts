/**
 * 認証関連機能モジュール
 * initApp, handleLogin, handleLogout, showProjectSection
 */

import { dom } from '../dom';
import { state } from '../state';
import { showLoading, showStatus, showToast } from '../ui/feedback';
import { getAuthToken, getUserEmail } from '../../lib/sheets-api';
import { t } from '../../lib/i18n';
import { platform } from '../../platform';

// Store互換レイヤー（Phase 3）
import {
    showLoginView,
    showProjectView,
    setUserEmail as syncSetUserEmail,
    resetForLogout as syncResetForLogout,
} from '../store/compat';

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
        // ログインボタンのクリック（ユーザー操作）起点なので interactive=true。
        // Web版はここで初めて認可ポップアップを開く（読み込み時のサイレント試行では開かない）。
        await getAuthToken(true);
        await showProjectSection();
    } catch (error) {
        console.error('Login error:', error);
        showStatus(t('auth_loginFailed', (error as Error).message), 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * ログアウト処理
 */
export async function handleLogout() {
    if (!confirm(t('auth_logoutConfirm'))) {
        return;
    }

    try {
        showLoading(true);

        // ストレージと認証トークンをクリア
        await platform().storageClear();
        await platform().clearAuth();

        // 状態をリセット（Store経由で両方に同期）
        syncResetForLogout();

        // ログイン画面に戻る（Store経由でrenderLayoutが自動更新）
        showLoginView();

        showToast(t('auth_logoutSuccess'));
    } catch (error) {
        console.error('Logout error:', error);
        alert(t('auth_logoutError', (error as Error).message));
    } finally {
        showLoading(false);
    }
}

/**
 * プロジェクト選択画面を表示
 */
export async function showProjectSection() {
    console.log('[showProjectSection] Starting...');

    // プロジェクトセクションを表示（Store経由でrenderLayoutが自動更新）
    showProjectView();
    console.log('[showProjectSection] View changed to project');

    // ユーザー情報を取得
    try {
        const userEmail = await getUserEmail();
        // Store経由で両方に同期
        syncSetUserEmail(userEmail);
        console.log('[showProjectSection] Got user email:', userEmail);
    } catch (e) {
        console.error('[showProjectSection] Failed to get user email:', e);
        syncSetUserEmail('');
        // ログイン画面に戻す
        showLoginView();
        showStatus(t('auth_loginRequired'), 'error');
        showLoading(false);
        return;
    }
    dom.userInfoDiv.textContent = t('auth_loggedInAs', state.userEmail);

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
