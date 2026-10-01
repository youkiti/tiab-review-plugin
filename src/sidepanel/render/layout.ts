/**
 * renderLayout: セクション表示/非表示の一元管理
 * hidden競合の根本解決：ここだけで全セクションの表示状態を制御
 */

import type { AppState } from '../store/types';
import { dom } from '../dom';
import { computeSharePanelPosition } from '../utils/share-panel-position';

/** 前回の補正を外して測り、開閉やリサイズによる位置ずれの累積を防ぐ。 */
function positionSharePanel(): void {
    const area = dom.shareInputArea;
    area.style.removeProperty('left');
    area.style.removeProperty('width');
    if (area.classList.contains('hidden')) return;
    const rect = area.getBoundingClientRect();
    const { offset, width } = computeSharePanelPosition(rect.left, rect.width, document.documentElement.clientWidth);
    if (offset !== 0) area.style.left = `${offset}px`;
    if (width !== rect.width) area.style.width = `${width}px`;
}

/**
 * レイアウト描画
 * View に基づいてセクションの表示/非表示を切り替え
 */
export function renderLayout(state: AppState): void {
    const { view, currentTab } = state.ui;

    // ========== メインセクションの表示切替 ==========
    // すべてのセクションを非表示にしてから、該当のみ表示
    dom.loginSection.classList.toggle('hidden', view !== 'login');
    dom.projectSection.classList.toggle('hidden', view !== 'project');
    dom.settingsSection.classList.toggle('hidden', view !== 'settings');

    // screening/llm/ml は同じ「スクリーニングセクション」内でタブ切替
    const isScreeningView = view === 'screening';
    const isManualTabActive = isScreeningView && currentTab === 'screening';

    // Fix: Only show screeningSection (Manual UI) if we are in manual tab
    dom.screeningSection.classList.toggle('hidden', !isManualTabActive);

    // config-section（プロジェクト設定の見出しを含む）はMLタブ・AIタブ・手動タブすべてで非表示
    // ログイン画面またはプロジェクト選択画面のみ表示
    const shouldShowConfigSection = view === 'login' || view === 'project';
    dom.configSection.classList.toggle('hidden', !shouldShowConfigSection);

    // ========== スクリーニングセクション内のタブ表示 ==========
    // Fix: Ensure LLM/ML sections are hidden if not in their respective tabs/view
    dom.llmSection.classList.toggle('hidden', !(isScreeningView && currentTab === 'llm'));
    dom.mlSection.classList.toggle('hidden', !(isScreeningView && currentTab === 'ml'));
    dom.fulltextSection.classList.toggle('hidden', !(isScreeningView && currentTab === 'fulltext'));

    if (isScreeningView) {
        // タブボタンのアクティブ状態
        dom.tabScreeningBtn.classList.toggle('active', currentTab === 'screening');
        dom.tabLlmBtn.classList.toggle('active', currentTab === 'llm');
        dom.tabMlBtn.classList.toggle('active', currentTab === 'ml');
        dom.tabFulltextBtn.classList.toggle('active', currentTab === 'fulltext');

        // ヘッダータブの表示
        dom.headerTabs.classList.remove('hidden');
    } else {
        // スクリーニングセクション以外ではタブを非表示
        dom.headerTabs.classList.add('hidden');
    }

    // ========== キーセクションの表示 ==========
    // 管理者のみ表示、かつ手動タブのみ表示（ML/AIでは非表示）
    dom.keySection.classList.toggle('hidden', !state.data.isAdmin || currentTab !== 'screening');

    // ========== 共通要素の表示状態 ==========
    // ローディング
    dom.loadingDiv.classList.toggle('hidden', !state.ui.flags.loading);

    // 設定ボタンの表示（view に応じて）
    dom.settingsBtnProject.classList.toggle('hidden', view !== 'project');
    dom.settingsBtnScreening.classList.toggle('hidden', view !== 'screening');
}

/**
 * 一時UI（メニュー、トースト）の描画
 */
export function renderTemporaryUI(state: AppState): void {
    const { flags, toast } = state.ui;

    // エクスポートメニュー
    dom.exportMenu.classList.toggle('hidden', !flags.exportMenuOpen);

    // 共有入力エリア
    dom.shareInputArea.classList.toggle('hidden', !flags.shareInputOpen);
    positionSharePanel();
    // 同じ関数の登録は重複せず、閉じている間は監視しない。
    if (flags.shareInputOpen) window.addEventListener('resize', positionSharePanel);
    else window.removeEventListener('resize', positionSharePanel);

    // トースト（既存CSSは.showクラスを使用）
    if (toast) {
        dom.toast.textContent = toast.message;
        dom.toast.classList.add('show');
    } else {
        dom.toast.classList.remove('show');
    }
}
