/**
 * TiAb Review Plugin Sidepanel Scripts（拡張機能エントリ）
 *
 * 共有配線は bootstrap.ts の bootstrapCommon() に集約している。
 * このファイルは拡張専用機能（LLM / ML / フルテキスト / インポート・エクスポート /
 * 論文用テキスト）の依存注入と配線のみを担う。
 */

// プラットフォームアダプタを最初に注入する（他モジュールが platform() を呼ぶため）
import { setPlatform } from '../platform';
import { chromePlatform } from '../platform/chrome';
setPlatform(chromePlatform);

import { dom } from './dom';
import { state } from './state';
import { bootstrapCommon } from './bootstrap';

// 拡張専用モジュール
import * as project from './features/project';
import * as settings from './features/settings';
import * as importExport from './features/import-export';
import { showManuscriptModal } from './features/manuscript';
import * as llm from './features/llm';
import * as screeningRender from './features/screening/render';
import * as reviewerFilter from './features/screening/reviewer-filter';
import { initMlHandlers, activateMlTab, handleMlKeydown } from './features/ml/actions';
import { setupFulltextTabListeners, activateFulltextTab } from './features/fulltext-tab';
import { initModal } from './ui/modal';
import { handleMlSearchInput, addMlKeyword, renderMlSection } from './features/ml/render';
import { showToast } from './ui/feedback';
import { toggleExportMenu, closeExportMenu } from './store/compat';
import { isImeComposing } from '../lib/ime-composition';

document.addEventListener('DOMContentLoaded', () => {
    // ========== 共有配線 ==========
    bootstrapCommon();

    // ========== 拡張専用の依存注入 ==========
    // settings の renderCurrentReference を ML 対応版で上書き（共有版は screening のみ）
    settings.setSettingsDependencies({
        renderCurrentReference: () => {
            if (state.currentTab === 'ml') {
                renderMlSection();
            } else {
                screeningRender.renderCurrentReference();
            }
        },
        renderReviewerFilter: reviewerFilter.renderReviewerFilter
    });

    importExport.setImportExportDependencies({
        renderCurrentReference: screeningRender.renderCurrentReference,
        loadDataAndShowScreening: project.loadDataAndShowScreening
    });

    // 重複レビューUI（Issue #147）の setDuplicateReviewDeps() 呼び出しは bootstrap.ts の
    // bootstrapCommon() へ移した（拡張版・Web版の両方に効かせるため）。ここでは呼ばない。

    llm.setHandleBack(project.handleBack);
    llm.setLoadDataAndShowScreening(project.loadDataAndShowScreening);

    // ========== Import/Export ==========
    dom.risFileInput?.addEventListener('change', importExport.handleRISImport);
    dom.importBtn?.addEventListener('click', () => dom.risFileInput.click());
    dom.exportBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExportMenu();
    });
    // Close export menu when clicking outside
    document.addEventListener('click', (e) => {
        if (dom.exportMenu && !dom.exportMenu.contains(e.target as Node) && e.target !== dom.exportBtn) {
            closeExportMenu();
        }
    });
    dom.exportCsvBtn?.addEventListener('click', () => {
        closeExportMenu();
        importExport.handleExportCSV();
    });
    dom.exportRisBtn?.addEventListener('click', () => {
        closeExportMenu();
        importExport.handleExportRIS();
    });
    // 論文用テキスト（Methods/Results/PRISMA数値）モーダル
    dom.exportManuscriptBtn?.addEventListener('click', () => {
        closeExportMenu();
        void showManuscriptModal('tiab');
    });
    dom.fulltextManuscriptBtn?.addEventListener('click', () => {
        void showManuscriptModal('fulltext');
    });

    // ========== フルテキストを開く ==========
    dom.btnOpenFulltext?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const refId = btn.dataset['refId'];
        if (!refId) return;
        const url = chrome.runtime.getURL('fulltext/fulltext.html') + `?ref_id=${encodeURIComponent(refId)}`;
        chrome.tabs.create({ url });
    });

    // ========== LLM ==========
    llm.setupLlmEventListeners();
    dom.tabLlmBtn?.addEventListener('click', () => llm.switchToTab('llm'));

    // ========== フルテキストタブ ==========
    setupFulltextTabListeners();
    // TiAb完了バナーの「全文タブへ進む」ボタンから遷移できるように登録
    // （render.tsからfulltext-tab.tsを直接importすると循環依存になるため依存注入で渡す）
    screeningRender.setFulltextTabNavigator(activateFulltextTab);

    // ========== ML ==========
    initMlHandlers();
    initModal();
    document.addEventListener('keydown', handleMlKeydown);
    document.getElementById('ml-search-input')?.addEventListener('input', handleMlSearchInput);
    document.getElementById('ml-add-include-btn')?.addEventListener('click', () => addMlKeyword('include'));
    document.getElementById('ml-add-exclude-btn')?.addEventListener('click', () => addMlKeyword('exclude'));
    // 日本語入力の変換確定 Enter でキーワードが確定しないよう、IME 変換中は読み飛ばす
    document.getElementById('ml-new-include-input')?.addEventListener('keypress', (e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Enter') addMlKeyword('include');
    });
    document.getElementById('ml-new-exclude-input')?.addEventListener('keypress', (e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Enter') addMlKeyword('exclude');
    });
    dom.tabMlBtn?.addEventListener('click', async () => {
        try {
            console.log('ML tab clicked');
            const success = await activateMlTab();
            console.log('ML tab activation result:', success);
            if (!success) {
                console.log('ML tab activation failed (insufficient records)');
            }
        } catch (error) {
            console.error('Error activating ML tab:', error);
            showToast(`MLタブの起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`, 5000);
        }
    });
});
