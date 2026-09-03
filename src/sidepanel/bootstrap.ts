/**
 * 共有ブートストラップ（拡張機能版 / Web 版で共通の配線）
 *
 * 拡張専用機能（LLM / ML / フルテキスト / インポート・エクスポート / 論文用テキスト）に
 * 依存する import はこのファイルに置かない。ここに置くと Web バンドルへ chrome 依存や
 * 不要コードが混入してしまうため。拡張専用の配線は各エントリ（sidepanel.ts）側で行う。
 *
 * `bootstrapCommon()` は副作用を持たない関数として公開し、DOMContentLoaded の登録は
 * 各エントリ側で行う。
 */

import { platform } from '../platform';
import { dom } from './dom';
import * as auth from './features/auth';
import * as project from './features/project';
import * as settings from './features/settings';
import * as sharing from './features/sharing';
import * as assignment from './features/assignment';
import * as screeningFilters from './features/screening/filters';
import * as screeningRender from './features/screening/render';
import * as screeningActions from './features/screening/actions';
import * as screeningKeywords from './features/screening/keywords';
import * as reviewerFilter from './features/screening/reviewer-filter';
import * as reviewCriteria from './features/review-criteria';
import { setDuplicateReviewDeps } from './features/duplicate-review';
import { setupTeamProgressListeners } from './features/team-progress';
import { initUnsentQueue, flushUnsentQueue } from './features/unsent-queue';
import { hideToast } from './ui/feedback';
import { localizeHtml } from '../lib/i18n';
import { isImeComposing } from '../lib/ime-composition';

// Store（Phase 2で導入）
import { initializeStore, subscribe, getState } from './store';
import { renderLayout, renderTemporaryUI } from './render/layout';

// Store互換レイヤー（Phase 4）
import {
    toggleShareInput,
    closeShareInput,
    changeTab,
} from './store/compat';

/**
 * 共有の依存注入とイベント配線を行う。
 * 各エントリ（拡張 / Web）の DOMContentLoaded から呼び出す。
 * このあと拡張専用の配線を各エントリで追加してよい（DI は後勝ちで上書きされる）。
 */
export function bootstrapCommon(): void {
    // ========== 依存注入（共有分。循環依存回避のため） ==========
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
        renderReviewerFilter: reviewerFilter.renderReviewerFilter,
        renderAiHighlightToggle: reviewerFilter.renderAiHighlightToggle,
        renderConsensusModeToggle: reviewerFilter.renderConsensusModeToggle
    });

    screeningFilters.setFilterDependencies({
        renderCurrentReference: screeningRender.renderCurrentReference,
        loadDataAndShowScreening: project.loadDataAndShowScreening
    });

    // 重複レビューUI（Issue #147）。拡張版・Web版の両エントリで共通のため bootstrapCommon() に
    // 置く（sidepanel.ts だけが呼んでいたため、Web版バンドル（docs/app/app.js）には一度も
    // 呼ばれず、統合・一括適用のたびに dupReview_depsMissing が出て一覧が更新されなかった。
    // Issue #147 外部レビュー指摘）。src/webapp/index.ts には足さない
    // （拡張専用機能を import しない方針で意図的に最小化されているファイルのため）。
    // すぐ上の screeningFilters.setFilterDependencies() とまったく同じ依存を渡す。
    setDuplicateReviewDeps({
        reloadAfterApply: project.loadDataAndShowScreening
    });

    // 共有版の settings 依存注入（ML 分岐を含まない）。
    // 拡張版は sidepanel.ts で ML 対応版に上書きする。
    settings.setSettingsDependencies({
        renderCurrentReference: () => screeningRender.renderCurrentReference(),
        renderReviewerFilter: reviewerFilter.renderReviewerFilter
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

    assignment.setAssignmentDependencies({
        loadDataAndShowScreening: project.loadDataAndShowScreening,
        renderCurrentReference: screeningRender.renderCurrentReference
    });

    reviewerFilter.setReviewerFilterDependencies({
        renderCurrentReference: screeningRender.renderCurrentReference
    });

    // ========== capabilities による拡張専用 UI の非表示 ==========
    const caps = platform().capabilities;
    if (!caps.ml) dom.tabMlBtn?.classList.add('hidden');
    if (!caps.llm) dom.tabLlmBtn?.classList.add('hidden');
    if (!caps.fulltext) {
        dom.tabFulltextBtn?.classList.add('hidden');
        dom.btnOpenFulltext?.classList.add('hidden');
    }
    if (!caps.importExport) {
        dom.importBtn?.classList.add('hidden');
        dom.exportBtn?.classList.add('hidden');
    }
    if (!caps.createProject) {
        // 作成ボタンだけでなく説明文（help-text）ごとラッパーで隠す。
        // ボタンだけ隠すと project_createHelp の説明文だけが宙に浮いて残り、
        // 直下の「ブラウザ版はレビュー専用です」案内カードと矛盾するため。
        dom.createProjectOption?.classList.add('hidden');
        dom.reviewOnlyNotice.classList.remove('hidden');
    }

    // ========== 共有イベント配線 ==========
    // i18n: HTMLの静的テキストを翻訳
    localizeHtml();

    window.addEventListener('online', () => {
        void flushUnsentQueue({ interactive: false });
    });

    // 未送信キューバッジのクリックハンドラ登録
    initUnsentQueue();

    // Auth
    dom.loginBtn?.addEventListener('click', auth.handleLogin);
    dom.logoutBtn?.addEventListener('click', auth.handleLogout);

    // Project
    dom.createBtn?.addEventListener('click', project.handleCreateNew);
    dom.connectBtn?.addEventListener('click', project.handleConnect);
    dom.recentSheetsSelect?.addEventListener('change', () => {
        if (dom.spreadsheetInput.value.trim()) {
            dom.spreadsheetInput.value = '';
        }
        project.handleConnect();
    });
    dom.spreadsheetInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') project.handleConnect();
    });

    // Settings
    dom.settingsBtnProject?.addEventListener('click', settings.showSettings);
    dom.settingsBtnScreening?.addEventListener('click', settings.showSettings);
    dom.criteriaBtnScreening?.addEventListener('click', () => reviewCriteria.showReviewCriteriaModal());
    dom.mlSettingsBtn?.addEventListener('click', settings.showSettings);
    dom.closeSettingsBtn?.addEventListener('click', settings.hideSettings);
    dom.autoNavigateCheckbox?.addEventListener('change', settings.handleAutoNavigateChange);
    dom.showRecordCountCheckbox?.addEventListener('change', settings.handleShowRecordCountChange);
    dom.termFilterAndCheckbox?.addEventListener('change', settings.handleTermFilterAndChange);
    dom.treatMlAsManualCheckbox?.addEventListener('change', settings.handleTreatMlAsManualChange);
    dom.abstractSubsectionBreakCheckbox?.addEventListener('change', settings.handleAbstractSubsectionBreakChange);
    dom.abstractSubsectionHeadingsTextarea?.addEventListener('change', settings.handleAbstractSubsectionHeadingsChange);
    dom.abstractSubsectionHeadingsResetBtn?.addEventListener('click', () => { void settings.handleAbstractSubsectionHeadingsReset(); });
    dom.assignmentResetBtn?.addEventListener('click', () => { void settings.handleAssignmentReset(); });
    dom.assignmentReshuffleBtn?.addEventListener('click', () => { void settings.handleAssignmentReshuffle(); });
    dom.assignmentSaveBtn?.addEventListener('click', () => { void settings.handleAssignmentSave(); });
    dom.assignmentBannerOpenBtn?.addEventListener('click', () => { void assignment.handleAssignmentBannerOpen(); });

    // Sharing
    dom.shareBtn?.addEventListener('click', () => {
        // Store経由で開閉
        toggleShareInput();
        // 開いた場合はフォーカスと共有ユーザー読み込み
        setTimeout(() => {
            const appState = getState();
            if (appState.ui.flags.shareInputOpen) {
                dom.shareEmailInput.focus();
                // 権限リスト取得（loadSharedUsers）を待たず、履歴ベースの候補をまず即時表示する。
                // 権限リスト取得完了後、共有済みユーザーを除外した候補で再描画される（二段構え）。
                sharing.loadShareSuggestions();
                sharing.loadSharedUsers();
            }
        }, 0);
    });
    dom.shareCancelBtn?.addEventListener('click', () => {
        closeShareInput();
        dom.shareEmailInput.value = '';
    });
    dom.shareSubmitBtn?.addEventListener('click', sharing.handleShare);
    dom.shareEmailInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sharing.handleShare();
    });
    dom.shareCopyInviteBtn?.addEventListener('click', sharing.copyInviteTemplate);

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
    // 日本語入力の変換確定 Enter でキーワードが確定しないよう、IME 変換中は読み飛ばす
    dom.newIncludeInput?.addEventListener('keypress', (e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Enter') screeningKeywords.addKeyword('include');
    });
    dom.newExcludeInput?.addEventListener('keypress', (e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Enter') screeningKeywords.addKeyword('exclude');
    });

    // Key Toggle
    dom.keyToggleInput?.addEventListener('change', screeningActions.handleKeyToggle);

    // AI Evidenceハイライトチェックボックス（初期化時に1回だけ登録）
    reviewerFilter.initAiHighlightListener();

    // 合議モードチェックボックス（初期化時に1回だけ登録）
    reviewerFilter.initConsensusModeListener();

    // Back button
    dom.backBtn?.addEventListener('click', project.handleBack);

    // Header title click (go back to project selection)
    document.getElementById('header-title')?.addEventListener('click', project.handleBack);

    // ========== Store初期化（Phase 2） ==========
    initializeStore();
    subscribe((appState) => {
        renderLayout(appState);
        renderTemporaryUI(appState);
    });
    renderLayout(getState());
    renderTemporaryUI(getState());

    // チーム進捗（判定保存イベントの即時反映）
    setupTeamProgressListeners();

    // Screening タブ（拡張専用の llm.switchToTab に依存せず共有ロジックで切替）
    dom.tabScreeningBtn?.addEventListener('click', () => {
        hideToast();
        changeTab('screening');
    });

    // Start App
    auth.initApp();
    void flushUnsentQueue({ interactive: false });
}
