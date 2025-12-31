/**
 * TiAb Review Plugin Sidepanel Scripts (Refactored)
 */

import { dom } from './dom';
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
    renderKeyStatus: screeningRender.renderKeyStatus
});

screeningFilters.setFilterDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
});

settings.setSettingsDependencies({
    renderCurrentReference: screeningRender.renderCurrentReference
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
    dom.closeSettingsBtn?.addEventListener('click', settings.hideSettings);
    dom.autoNavigateCheckbox?.addEventListener('change', settings.handleAutoNavigateChange);
    dom.showRecordCountCheckbox?.addEventListener('change', settings.handleShowRecordCountChange);
    dom.termFilterAndCheckbox?.addEventListener('change', settings.handleTermFilterAndChange);

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

    // Start App
    auth.initApp();
});
