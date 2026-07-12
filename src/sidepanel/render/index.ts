/**
 * renderApp: 描画のエントリーポイント
 * 状態変更時に呼び出され、全体を再描画する
 */

import type { AppState } from '../store/types';
import { renderLayout, renderTemporaryUI, renderFilterOptions } from './layout';
import { getFilterCounts, getProgressStats, getFilteredReferences, getCurrentReference, getAiEvidenceList } from '../store/selectors';
import { highlightText, getEncourageMessage, getReviewerLabel, getDecisionIcon, getMlBadgeHtml, detectConflictWithSettings, filterEnabledDecisions } from './helpers';
import { dom } from '../dom';
import { isHumanDecision, isConfirmedMlDecision } from '../../lib/client-version';
import { t } from '../../lib/i18n';

/**
 * メイン描画関数
 * Store の subscribe から呼び出される
 */
export function renderApp(state: AppState): void {
    // 1. レイアウト（セクション表示/非表示）
    renderLayout(state);

    // 2. 現在のViewに応じた描画
    switch (state.ui.view) {
        case 'login':
            renderLoginSection(state);
            break;
        case 'project':
            renderProjectSection(state);
            break;
        case 'screening':
            // タブに応じて描画
            switch (state.ui.currentTab) {
                case 'screening':
                    renderScreeningSection(state);
                    break;
                case 'llm':
                    renderLlmSection(state);
                    break;
                case 'ml':
                    renderMlSection(state);
                    break;
            }
            break;
        case 'settings':
            renderSettingsSection(state);
            break;
    }

    // 3. 一時UI（メニュー/トースト/ローディング）
    renderTemporaryUI(state);
}

// ========== 各セクションの描画 ==========

/**
 * ログインセクション描画
 */
function renderLoginSection(state: AppState): void {
    // ログインセクションは静的なので特に描画処理なし
    // ユーザー情報があれば表示
    if (state.data.userEmail) {
        dom.userInfoDiv.textContent = state.data.userEmail;
        dom.userInfoDiv.classList.remove('hidden');
    } else {
        dom.userInfoDiv.classList.add('hidden');
    }
}

/**
 * プロジェクトセクション描画
 */
function renderProjectSection(state: AppState): void {
    // ユーザー情報表示
    if (state.data.userEmail) {
        dom.userInfoDiv.textContent = state.data.userEmail;
        dom.userInfoDiv.classList.remove('hidden');
    }

    // 最近使用したシートのセレクトボックス更新
    // （これは別途loadRecentSheetsで処理される）
}

/**
 * スクリーニングセクション描画
 */
function renderScreeningSection(state: AppState): void {
    const filtered = getFilteredReferences(state);
    const ref = getCurrentReference(state);
    const progress = getProgressStats(state);
    const counts = getFilterCounts(state);

    // フィルター件数更新
    renderFilterOptions(counts, state);

    // 検索結果件数
    renderSearchResultCount(state, filtered.length);

    if (!ref) {
        renderEmptyState(state);
        return;
    }

    // 文献情報描画
    renderReferenceDetails(state, ref, filtered.length);

    // 進捗描画
    renderProgress(state, progress);

    // 判定ボタン状態更新
    renderDecisionButtons(ref);

    // キーオープン時の全判定表示
    if (state.ui.screening.isKeyOpened) {
        renderAllDecisions(state, ref);
    }

    // アクティブなタームフィルター表示
    renderActiveTermFilters(state);
}

/**
 * 検索結果件数表示
 */
function renderSearchResultCount(state: AppState, filteredCount: number): void {
    const searchTerm = state.ui.screening.searchQuery;
    if (searchTerm) {
        dom.searchResultCount.classList.remove('hidden');
        if (filteredCount === 0) {
            dom.searchResultCount.textContent = `「${searchTerm}」: 0件ヒット`;
            dom.searchResultCount.classList.add('no-results');
        } else {
            dom.searchResultCount.textContent = `「${searchTerm}」: ${filteredCount}件ヒット（↓ 詳細を確認）`;
            dom.searchResultCount.classList.remove('no-results');
        }
    } else {
        dom.searchResultCount.classList.add('hidden');
    }
}

/**
 * 空状態（文献なし）の描画
 */
function renderEmptyState(state: AppState): void {
    dom.refTitle.textContent = t('screening_noReferences');
    dom.refAuthors.textContent = '';
    dom.refYear.textContent = '';
    dom.refJournal.textContent = '';
    dom.refAbstract.textContent = state.data.references.length === 0
        ? t('screening_importPrompt')
        : t('screening_noFilterMatch');
    dom.refDoi.classList.add('hidden');
    dom.refPmid.classList.add('hidden');
    dom.navPosition.textContent = '0 / 0';
    dom.progressText.textContent = `0 / ${state.data.references.length}`;
    dom.filterResultCount.textContent = t('filter_resultCount', ['0', '0']);
    dom.conflictBanner.classList.add('hidden');
    dom.allDecisionsDiv.classList.add('hidden');
}

/**
 * 文献詳細の描画
 */
function renderReferenceDetails(
    state: AppState,
    ref: import('../../lib/types').ReferenceWithStatus,
    totalFiltered: number
): void {
    // Evidence収集
    const evidenceList = getAiEvidenceList(ref, state);

    // 検索キーワード
    const searchKeywords = state.ui.screening.searchQuery
        ? [state.ui.screening.searchQuery]
        : [];

    // タイトル・抄録（ハイライト付き）
    dom.refTitle.innerHTML = highlightText(ref.title, state, searchKeywords, evidenceList);
    dom.refAuthors.textContent = ref.authors || '';
    dom.refYear.textContent = ref.year?.toString() || '';
    dom.refJournal.textContent = ref.journal || '';
    dom.refAbstract.innerHTML = highlightText(ref.abstract || '(抄録なし)', state, searchKeywords, evidenceList);

    // リンク
    if (ref.doi) {
        dom.refDoi.href = `https://doi.org/${ref.doi}`;
        dom.refDoi.classList.remove('hidden');
    } else {
        dom.refDoi.classList.add('hidden');
    }

    if (ref.pmid) {
        dom.refPmid.href = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}`;
        dom.refPmid.classList.remove('hidden');
    } else {
        dom.refPmid.classList.add('hidden');
    }

    // ナビゲーション
    dom.navPosition.textContent = `${state.ui.screening.currentIndex + 1} / ${totalFiltered}`;
    dom.filterResultCount.textContent = `${totalFiltered}件中 ${state.ui.screening.currentIndex + 1}件目`;

    // コンフリクト表示（enabledReviewers と treatMlAsManual を反映して動的に計算）
    const conflictDecisions = filterEnabledDecisions(
        ref.allDecisions,
        state.data.enabledReviewers,
        state.ui.screening.isKeyOpened,
        state.ui.settings.treatMlAsManual
    );
    const hasConflict = conflictDecisions.length > 0
        ? detectConflictWithSettings(conflictDecisions, state.ui.settings.treatMlAsManual)
        : false;
    if (state.ui.screening.isKeyOpened && hasConflict) {
        dom.conflictBanner.classList.remove('hidden');
    } else {
        dom.conflictBanner.classList.add('hidden');
    }

    // メモ欄
    dom.noteInput.value = ref.myDecision?.note || '';
}

/**
 * 進捗表示の描画
 */
function renderProgress(
    state: AppState,
    progress: { total: number; labeled: number; remaining: number; percent: number }
): void {
    const { total, labeled, remaining, percent } = progress;
    const message = getEncourageMessage(total, percent);

    dom.progressText.textContent = `${labeled} / ${total}`;

    if (state.ui.settings.showRecordCountBelow) {
        dom.navProgress.innerHTML = `
            <div class="nav-progress-main">${labeled} / ${total}件（残り${remaining}件）</div>
            <div class="nav-progress-encourage">${message}</div>
        `;
        dom.recordCountAbove.classList.add('hidden');
        dom.navProgress.classList.remove('hidden');
    } else {
        dom.recordCountAbove.innerHTML = `
            <div class="record-count-main">${labeled} / ${total}件（残り${remaining}件）</div>
            <div class="record-count-encourage">${message}</div>
        `;
        dom.recordCountAbove.classList.remove('hidden');
        dom.navProgress.classList.add('hidden');
    }
}

/**
 * 判定ボタンの状態更新
 */
function renderDecisionButtons(ref: import('../../lib/types').ReferenceWithStatus): void {
    const myStatus = ref.myDecision?.decision || 'pending';
    dom.btnInclude.classList.toggle('active', myStatus === 'include');
    dom.btnMaybe.classList.toggle('active', myStatus === 'maybe');
    dom.btnExclude.classList.toggle('active', myStatus === 'exclude');
}

/**
 * 全レビュアーの判定表示（キーオープン時）
 */
function renderAllDecisions(
    state: AppState,
    ref: import('../../lib/types').ReferenceWithStatus
): void {
    if (!ref.allDecisions || ref.allDecisions.length === 0) {
        dom.allDecisionsDiv.classList.add('hidden');
        return;
    }

    dom.allDecisionsDiv.classList.remove('hidden');
    dom.allDecisionsDiv.innerHTML = '';

    // treatMlAsManualがオンの場合、手動とMLの両方があるかを検出
    const mixedReviewers = new Set<string>();
    if (state.ui.settings.treatMlAsManual) {
        const reviewerVersions = new Map<string, { hasManual: boolean; hasMl: boolean }>();
        ref.allDecisions.forEach(decision => {
            const reviewerId = (decision.reviewer_id || '').trim();
            if (!reviewerId || reviewerId.startsWith('llm:')) return;

            const current = reviewerVersions.get(reviewerId) || { hasManual: false, hasMl: false };
            if (isHumanDecision(decision.client_version)) {
                current.hasManual = true;
            }
            if (isConfirmedMlDecision(decision.client_version)) {
                current.hasMl = true;
            }
            reviewerVersions.set(reviewerId, current);
        });

        reviewerVersions.forEach((versions, reviewerId) => {
            if (versions.hasManual && versions.hasMl) {
                mixedReviewers.add(reviewerId);
            }
        });
    }

    // 判定をレビュアーごとにまとめる（最新のみ）
    // treatMlAsManualがオンの場合はgetReviewerKeyでまとめる必要がある
    const decisionsMap = new Map<string, import('../../lib/types').Decision>();
    ref.allDecisions.forEach(decision => {
        let reviewerKey = decision.reviewer_id;
        if (!reviewerKey) return;

        // treatMlAsManualがオンの場合、ML判定(0.7.0-ml)も同じキーとして扱う
        if (state.ui.settings.treatMlAsManual &&
            isConfirmedMlDecision(decision.client_version)) {
            reviewerKey = (decision.reviewer_id || '').trim();
        }

        const existing = decisionsMap.get(reviewerKey);
        if (!existing || (decision.decided_at || '') > (existing.decided_at || '')) {
            decisionsMap.set(reviewerKey, decision);
        }
    });

    // 表示対象のレビュアー
    const reviewerIds = state.data.enabledReviewers.size > 0
        ? Array.from(state.data.enabledReviewers)
        : Array.from(decisionsMap.keys());

    reviewerIds.forEach(reviewerId => {
        // treatMlAsManualがONの場合、::mlサフィックス付きのキーはスキップ
        // （既にメインのキーにマージされているため）
        if (state.ui.settings.treatMlAsManual && reviewerId.endsWith('::ml')) {
            return;
        }

        const decision = decisionsMap.get(reviewerId);
        const decisionValue = decision?.decision || 'pending';

        const div = document.createElement('div');
        div.className = `decision-item ${decisionValue}`;

        const icon = getDecisionIcon(decisionValue);

        // ML Enhanced バッジ (混在の場合は非表示)
        const isMixed = mixedReviewers.has(reviewerId);
        const mlBadge = isMixed ? '' : getMlBadgeHtml(decision?.client_version);

        // ラベル生成（混在情報を含む）
        const label = getReviewerLabelWithMixed(reviewerId, state.data.userEmail, isMixed, state.ui.settings.treatMlAsManual);

        div.innerHTML = `
            <span class="reviewer">${label}</span>
            <span class="decision">${icon} ${decisionValue}</span>
            ${mlBadge}
        `;

        // ノート表示
        if (decision?.note) {
            const noteDiv = document.createElement('div');
            noteDiv.className = 'note';

            // JSONパース（AI判定用）
            let isJson = false;
            if (decision.note.trim().startsWith('{') && decision.note.length > 20) {
                try {
                    const parsed = JSON.parse(decision.note);
                    if (parsed.reasons && Array.isArray(parsed.reasons)) {
                        isJson = true;
                        noteDiv.innerHTML = `<div>📝 <b>AI Reasons:</b></div>`;
                        const ul = document.createElement('ul');
                        ul.style.cssText = 'margin: 4px 0 8px 20px; padding: 0; list-style-type: disc;';
                        parsed.reasons.forEach((r: string) => {
                            const li = document.createElement('li');
                            li.textContent = r;
                            li.style.marginBottom = '2px';
                            ul.appendChild(li);
                        });
                        noteDiv.appendChild(ul);
                    }
                } catch {
                    // JSONパース失敗時は通常テキスト
                }
            }

            if (!isJson) {
                noteDiv.textContent = `📝 ${decision.note}`;
            }
            div.appendChild(noteDiv);
        }

        dom.allDecisionsDiv.appendChild(div);
    });
}

/**
 * 混在情報を含むレビュアーラベル生成
 */
function getReviewerLabelWithMixed(reviewerId: string, currentUserEmail: string, hasMixed: boolean, treatMlAsManual: boolean): string {
    if (!reviewerId) return '(不明)';

    // LLM reviewer
    if (reviewerId.startsWith('llm:')) {
        const modelName = reviewerId.replace('llm:', '');
        return `🤖 ${modelName}`;
    }

    // 混在の場合
    if (hasMixed && treatMlAsManual) {
        if (reviewerId === currentUserEmail) {
            return `👤 自分 (手動＋ML)`;
        }
        const atIndex = reviewerId.indexOf('@');
        if (atIndex > 0) {
            return `👤 ${reviewerId.substring(0, atIndex)} (手動＋ML)`;
        }
        return `👤 ${reviewerId} (手動＋ML)`;
    }

    // Current user
    if (reviewerId === currentUserEmail) {
        return `👤 自分`;
    }

    // Other human reviewer - show email prefix
    const atIndex = reviewerId.indexOf('@');
    if (atIndex > 0) {
        return `👤 ${reviewerId.substring(0, atIndex)}`;
    }

    return `👤 ${reviewerId}`;
}

/**
 * アクティブなタームフィルターの表示
 */
function renderActiveTermFilters(state: AppState): void {
    if (!dom.activeTermFiltersDiv) return;

    const filters = state.ui.screening.activeTermFilters;
    if (filters.length === 0) {
        dom.activeTermFiltersDiv.classList.add('hidden');
        return;
    }

    dom.activeTermFiltersDiv.classList.remove('hidden');
    dom.activeTermFiltersDiv.innerHTML = '';

    for (const filter of filters) {
        const tag = document.createElement('span');
        tag.className = `term-filter-tag ${filter.type}`;
        tag.innerHTML = `
            ${filter.term}
            <span class="remove-btn" data-action="remove-term-filter" data-term="${filter.term}" data-type="${filter.type}">×</span>
        `;
        dom.activeTermFiltersDiv.appendChild(tag);
    }
}

/**
 * LLMセクション描画（プレースホルダー）
 * 完全な実装はPhase 5で行う
 */
function renderLlmSection(state: AppState): void {
    // LLMセクションの基本的な描画
    // バッチ進捗など
    if (state.ui.llm.batchRunning) {
        dom.startBatchBtn.classList.add('hidden');
        dom.stopBatchBtn.classList.remove('hidden');
    } else {
        dom.startBatchBtn.classList.remove('hidden');
        dom.stopBatchBtn.classList.add('hidden');
    }
}

/**
 * MLセクション描画（プレースホルダー）
 * 完全な実装はPhase 5で行う
 */
function renderMlSection(state: AppState): void {
    // MLセクションの基本的な描画
    // 既存のrenderMlSectionはそのまま使用される
}

/**
 * 設定セクション描画
 */
function renderSettingsSection(state: AppState): void {
    const { settings } = state.ui;

    // チェックボックスの状態を同期
    dom.autoNavigateCheckbox.checked = settings.autoNavigateAfterDecision;
    dom.showRecordCountCheckbox.checked = settings.showRecordCountBelow;
    dom.termFilterAndCheckbox.checked = settings.termFilterUseAnd;
    dom.treatMlAsManualCheckbox.checked = settings.treatMlAsManual;
}

// ========== Export ==========
export { renderLayout, renderTemporaryUI, renderFilterOptions } from './layout';
export { highlightText, getEncourageMessage, getReviewerLabel, getDecisionIcon, getMlBadgeHtml, detectConflictWithSettings } from './helpers';
