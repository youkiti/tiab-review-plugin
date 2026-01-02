/**
 * TiAb Review Plugin Sidepanel Scripts (Refactored)
 *
 * Phase 2: Store基盤を統合し、段階的にrender一本化へ移行中
 */

import { dom } from './dom';
import { state } from './state';
import * as auth from './features/auth';
import * as project from './features/project';
import * as settings from './features/settings';
import * as sharing from './features/sharing';
import * as importExport from './features/import-export';
import * as llm from './features/llm';
import * as screeningFilters from './features/screening/filters';
import * as screeningRender from './features/screening/render';
import * as screeningActions from './features/screening/actions';
import * as screeningKeywords from './features/screening/keywords';
import * as reviewerFilter from './features/screening/reviewer-filter';
import { initMlHandlers, activateMlTab, handleMlKeydown } from './features/ml/actions';
import { initModal } from './features/ml/dialogs';
import { handleMlSearchInput, addMlKeyword, renderMlSection } from './features/ml/render';

// Store（Phase 2で導入）
import { initializeStore, subscribe, getState } from './store';
import { renderLayout, renderTemporaryUI } from './render/layout';

// Initialize Dependencies for all modules to resolve circular refs
auth.setAuthDependencies({
    loadRecentSheets: project.loadRecentSheets,
    loadConfig: project.loadConfig,
    loadUserSettings: settings.loadUserSettings
});

project.setProjectDependencies({
    renderKeywords: screeningKeywords.renderKeywords,
    renderSourceFilters: screeningFilters.renderSourceFilters,
    renderCurrentReference: screeningRender.renderCurrentReference,
    renderKeyStatus: screeningRender.renderKeyStatus,
    renderReviewerFilter: reviewerFilter.renderReviewerFilter
});

screeningFilters.setFilterDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
});

settings.setSettingsDependencies({
    renderCurrentReference: () => {
        if (state.currentTab === 'ml') {
            renderMlSection();
        } else {
            screeningRender.renderCurrentReference();
        }
    }
});

importExport.setImportExportDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
});

screeningRender.setRenderDependencies({
    navigate: screeningActions.navigate
});

screeningActions.setActionDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference,
    renderSpecificReference: screeningRender.renderSpecificReference
});

screeningKeywords.setKeywordDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
});

reviewerFilter.setReviewerFilterDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
});

llm.setHandleBack(project.handleBack);


// Global Event Listeners setup
document.addEventListener('DOMContentLoaded', () => {
    // Auth
    dom.loginBtn?.addEventListener('click', auth.handleLogin);
    dom.logoutBtn?.addEventListener('click', auth.handleLogout);

    // Project
    dom.createBtn?.addEventListener('click', project.handleCreateNew);
    dom.connectBtn?.addEventListener('click', project.handleConnect);
    dom.recentSheetsSelect?.addEventListener('change', project.handleConnect);

    // Settings
    dom.settingsBtnProject?.addEventListener('click', settings.showSettings);
    dom.settingsBtnScreening?.addEventListener('click', settings.showSettings);
    dom.mlSettingsBtn?.addEventListener('click', settings.showSettings);
    dom.closeSettingsBtn?.addEventListener('click', settings.hideSettings);
    dom.autoNavigateCheckbox?.addEventListener('change', settings.handleAutoNavigateChange);
    dom.showRecordCountCheckbox?.addEventListener('change', settings.handleShowRecordCountChange);
    dom.termFilterAndCheckbox?.addEventListener('change', settings.handleTermFilterAndChange);
    dom.treatMlAsManualCheckbox?.addEventListener('change', settings.handleTreatMlAsManualChange);

    // Import/Export
    dom.risFileInput?.addEventListener('change', importExport.handleRISImport);
    dom.importBtn?.addEventListener('click', () => dom.risFileInput.click());
    dom.exportBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.exportMenu.classList.toggle('hidden');
    });
    // Close export menu when clicking outside
    document.addEventListener('click', (e) => {
        if (dom.exportMenu && !dom.exportMenu.contains(e.target as Node) && e.target !== dom.exportBtn) {
            dom.exportMenu.classList.add('hidden');
        }
    });

    dom.exportCsvBtn?.addEventListener('click', () => {
        dom.exportMenu.classList.add('hidden');
        importExport.handleExportCSV();
    });
    dom.exportRisBtn?.addEventListener('click', () => {
        dom.exportMenu.classList.add('hidden');
        importExport.handleExportRIS();
    });

    // Sharing
    dom.shareBtn?.addEventListener('click', () => {
        dom.shareInputArea.classList.toggle('hidden');
        if (!dom.shareInputArea.classList.contains('hidden')) {
            dom.shareEmailInput.focus();
            sharing.loadSharedUsers();
        }
    });
    dom.shareCancelBtn?.addEventListener('click', () => {
        dom.shareInputArea.classList.add('hidden');
        dom.shareEmailInput.value = '';
    });
    dom.shareSubmitBtn?.addEventListener('click', sharing.handleShare);
    dom.shareEmailInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sharing.handleShare();
    });

    // Screening Actions
    dom.btnInclude?.addEventListener('click', () => screeningActions.handleDecision('include'));
    dom.btnExclude?.addEventListener('click', () => screeningActions.handleDecision('exclude'));
    dom.btnMaybe?.addEventListener('click', () => screeningActions.handleDecision('maybe'));
    dom.btnPrev?.addEventListener('click', () => screeningActions.navigate(-1));
    dom.btnNext?.addEventListener('click', () => screeningActions.navigate(1));
    document.addEventListener('keydown', screeningActions.handleKeydown);

    // Screening Filters
    dom.statusFilter?.addEventListener('change', screeningFilters.handleStatusFilterChange);
    dom.searchInput?.addEventListener('input', screeningFilters.handleSearchInput);

    // Term Filters (Delegation & Removal)
    dom.referenceDetail?.addEventListener('click', screeningFilters.handleTermClick);
    dom.activeTermFiltersDiv?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('remove-btn')) {
            const term = target.dataset.term;
            const type = target.dataset.type as 'include' | 'exclude';
            if (term && type) {
                screeningFilters.removeTermFilter(term, type);
            }
        }
    });

    // Screening Keywords
    dom.presetRctBtn?.addEventListener('click', () => screeningKeywords.applyPreset('RCT'));
    dom.presetSrBtn?.addEventListener('click', () => screeningKeywords.applyPreset('SR'));
    dom.addIncludeBtn?.addEventListener('click', () => screeningKeywords.addKeyword('include'));
    dom.addExcludeBtn?.addEventListener('click', () => screeningKeywords.addKeyword('exclude'));

    dom.newIncludeInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') screeningKeywords.addKeyword('include');
    });
    dom.newExcludeInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') screeningKeywords.addKeyword('exclude');
    });

    // Key Toggle
    dom.keyToggleInput?.addEventListener('change', screeningActions.handleKeyToggle);

    // Back button
    dom.backBtn?.addEventListener('click', project.handleBack);

    // LLM
    llm.setupLlmEventListeners();

    // ML
    initMlHandlers();
    initModal();

    // ML Keyboard Shortcuts (global listener)
    document.addEventListener('keydown', handleMlKeydown);

    // ML Search
    document.getElementById('ml-search-input')?.addEventListener('input', handleMlSearchInput);

    // ML Keywords
    document.getElementById('ml-add-include-btn')?.addEventListener('click', () => addMlKeyword('include'));
    document.getElementById('ml-add-exclude-btn')?.addEventListener('click', () => addMlKeyword('exclude'));
    document.getElementById('ml-new-include-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addMlKeyword('include');
    });
    document.getElementById('ml-new-exclude-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addMlKeyword('exclude');
    });

    // Tab Switching
    dom.tabScreeningBtn?.addEventListener('click', () => llm.switchToTab('screening'));
    dom.tabLlmBtn?.addEventListener('click', () => llm.switchToTab('llm'));
    dom.tabMlBtn?.addEventListener('click', () => {
        llm.switchToTab('ml');
        activateMlTab();
    });

    // ========== Store初期化（Phase 2） ==========
    // Storeを初期化
    initializeStore();

    // Storeの状態変更を購読してレイアウトと一時UIを自動更新
    // 注意: 現在は既存のレンダリング関数と並行して動作
    // 完全移行後は renderApp() のみを呼び出す
    subscribe((appState) => {
        // レイアウト（セクション表示/非表示）を更新
        renderLayout(appState);
        // 一時UI（メニュー/トースト/ローディング）を更新
        renderTemporaryUI(appState);
    });

    // 初期レイアウト描画
    renderLayout(getState());
    renderTemporaryUI(getState());

    // Start App
    auth.initApp();
});
