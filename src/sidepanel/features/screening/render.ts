/**
 * スクリーニング描画モジュール
 * 文献の表示、ハイライト、不一致表示など
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { escapeHtml, escapeRegex } from '../../utils/text';
import { getFilteredReferences, updateFilterCounts, getMyManualDecisionStatus } from './filters';
import type { ReferenceWithStatus } from '../../../lib/types';
import { getReviewerKey, getReviewerLabel, isActiveConfirmedLlmDecision } from './reviewer-utils';
import { detectConflictWithSettings } from '../../render/helpers';
import { isHumanDecision, isConfirmedMlDecision, isMlAutoDecision, isMlDecision } from '../../../lib/client-version';
import { t } from '../../../lib/i18n';
import type { DecisionStatus } from '../../../lib/types';

// 外部アクションへの参照（循環依存回避）
let _navigate: ((dir: number) => void) | null = null;

export function setRenderDependencies(deps: {
    navigate: (dir: number) => void;
}) {
    _navigate = deps.navigate;
}

function getCurrentHistoryReference(): ReferenceWithStatus | undefined {
    const historyRefId = state.getCurrentReviewHistoryRefId();
    if (!historyRefId) return undefined;
    return state.references.find((ref) => ref.ref_id === historyRefId);
}

export function getDecisionChipContent(status: DecisionStatus | 'pending') {
    switch (status) {
        case 'include':
            return { className: 'include', text: t('decision_includeChip') };
        case 'exclude':
            return { className: 'exclude', text: t('decision_excludeChip') };
        case 'maybe':
            return { className: 'maybe', text: t('decision_maybeChip') };
        case 'conflict':
            return { className: 'maybe', text: t('decision_conflictChip') };
        case 'pending':
        default:
            return { className: 'pending', text: t('decision_pendingChip') };
    }
}

function renderDecisionChip(chip: HTMLElement, statusRow: HTMLElement, status: DecisionStatus | 'pending') {
    const content = getDecisionChipContent(status);
    chip.className = `reference-status-chip ${content.className}`;
    chip.textContent = content.text;
    statusRow.classList.remove('hidden');
}

/**
 * テキストハイライト処理
 */
export function highlightText(text: string, searchKeyword: string | string[], evidenceList: string[] = []): string {
    if (!text) return '';

    let html = escapeHtml(text);
    const searchTerms = Array.isArray(searchKeyword)
        ? searchKeyword.filter(Boolean)
        : (searchKeyword ? [searchKeyword] : []);

    // 1. ハイライトキーワード（include/exclude）
    if (state.highlightKeywords) {
        // Excludeキーワード (赤)
        state.highlightKeywords.exclude.forEach(keyword => {
            if (!keyword) return;
            const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-exclude">$1</span>');
        });

        // Includeキーワード (緑)
        state.highlightKeywords.include.forEach(keyword => {
            if (!keyword) return;
            const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-include">$1</span>');
        });
    }

    // 2. 検索キーワード（黄色）
    if (searchTerms.length > 0) {
        searchTerms.forEach(term => {
            const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-search">$1</span>');
        });
    }

    // 3. タームフィルター（青枠）
    state.activeTermFilters.forEach(filter => {
        const regex = new RegExp(`(${escapeRegex(filter.term)})`, 'gi');
        html = html.replace(regex, '<span class="highlight-term">$1</span>');
    });

    // 4. AI Evidence Highlights (Orange)
    if (evidenceList && evidenceList.length > 0) {
        evidenceList.forEach(quote => {
            if (!quote || quote.length < 5) return;
            const regex = new RegExp(`(${escapeRegex(quote.trim())})`, 'gi');
            html = html.replace(regex, '<span class="highlight-evidence" title="AI Evidence">$1</span>');
        });
    }

    return html;
}

/**
 * 現在の文献を表示
 */
export function renderCurrentReference() {
    const filtered = getFilteredReferences();
    const historyRef = getCurrentHistoryReference();
    const ref = historyRef || filtered[state.currentIndex];

    // 検索結果件数の更新
    const searchTerm = dom.searchInput.value.trim();
    if (searchTerm) {
        dom.searchResultCount.classList.remove('hidden');
        if (filtered.length === 0) {
            dom.searchResultCount.textContent = t('screening_searchNoHits', searchTerm);
            dom.searchResultCount.classList.add('no-results');
        } else {
            dom.searchResultCount.textContent = t('screening_searchHits', [searchTerm, String(filtered.length)]);
            dom.searchResultCount.classList.remove('no-results');
        }
    } else {
        dom.searchResultCount.classList.add('hidden');
    }

    if (!ref) {
        // 文献がない場合の表示
        dom.refTitle.textContent = t('screening_noReferences');
        dom.refAuthors.textContent = '';
        dom.refYear.textContent = '';
        dom.refJournal.textContent = '';
        dom.refAbstract.textContent = state.references.length === 0
            ? t('screening_importPrompt')
            : t('screening_noFilterMatch');
        dom.refDoi.classList.add('hidden');
        dom.refPmid.classList.add('hidden');
        dom.refDecisionStatusRow.classList.add('hidden');
        dom.navPosition.textContent = '0 / 0';
        dom.progressText.textContent = `0 / ${state.references.length}`;
        dom.filterResultCount.textContent = t('filter_resultCount', ['0', '0']);

        updateFilterCounts();

        dom.conflictBanner.classList.add('hidden');
        dom.allDecisionsDiv.classList.add('hidden');
        // 表示中の文献がない状態では noteInput の所有者も無効化する
        state.setLastRenderedRefId(null);
        return;
    }

    renderReferenceDetails(ref, filtered.length, Boolean(historyRef));
}

/**
 * 特定の文献を描画（外部呼び出し用）
 */
export function renderSpecificReference(ref: ReferenceWithStatus) {
    const filtered = getFilteredReferences();
    renderReferenceDetails(ref, filtered.length, false);
}

/**
 * 特定の文献を描画（内部関数）
 */
function renderReferenceDetails(ref: ReferenceWithStatus, totalFiltered: number, isHistoryView: boolean) {
    // コンフリクト表示（treatMlAsManual設定を考慮して動的に計算）
    const hasConflict = ref.allDecisions && ref.allDecisions.length > 0
        ? detectConflictWithSettings(ref.allDecisions, state.treatMlAsManual)
        : false;
    if (state.isKeyOpened && ref.allDecisions && ref.allDecisions.length > 0) {
        renderAllDecisions(ref);
        dom.allDecisionsDiv.classList.remove('hidden');

        if (hasConflict) {
            dom.conflictBanner.classList.remove('hidden');
        } else {
            dom.conflictBanner.classList.add('hidden');
        }
    } else {
        dom.conflictBanner.classList.add('hidden');
        dom.allDecisionsDiv.classList.add('hidden');
    }

    // Evidenceの収集 (ハイライト機能がONの場合)
    const evidenceList: string[] = [];
    if (state.showAiHighlights && ref.allDecisions) {
        ref.allDecisions.forEach(d => {
            // Blind OFF時のみレビュアーフィルターを適用する
            if (state.isKeyOpened && state.enabledReviewers.size > 0 && !state.enabledReviewers.has(d.reviewer_id)) return;
            // 閾値確定済みで有効なAI判定のみ
            if (!isActiveConfirmedLlmDecision(d)) return;

            try {
                if (d.note && d.note.trim().startsWith('{')) {
                    const parsed = JSON.parse(d.note);
                    if (parsed.evidence && Array.isArray(parsed.evidence)) {
                        parsed.evidence.forEach((e: any) => {
                            if (e.quote) evidenceList.push(e.quote);
                        });
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        });
    }

    // 基本情報表示
    const searchKeyword = dom.searchInput.value.trim();
    dom.refTitle.innerHTML = highlightText(ref.title, searchKeyword, evidenceList);
    dom.refAuthors.textContent = ref.authors || '';
    dom.refYear.textContent = ref.year?.toString() || '';
    dom.refJournal.textContent = ref.journal || '';
    dom.refAbstract.innerHTML = highlightText(ref.abstract || t('screening_noAbstract'), searchKeyword, evidenceList);

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

    const myStatus = (ref.myDecision?.decision || 'pending') as DecisionStatus | 'pending';
    renderDecisionChip(dom.refDecisionChip, dom.refDecisionStatusRow, myStatus);

    // ナビゲーション更新
    if (isHistoryView) {
        const historyPosition = state.reviewHistoryCursor + 1;
        const historyTotal = state.reviewHistoryRefIds.length;
        dom.navPosition.textContent = t('screening_historyPosition', [String(historyPosition), String(historyTotal)]);
        dom.filterResultCount.textContent = t('filter_historyResultCount', [String(historyTotal), String(historyPosition)]);
    } else {
        dom.navPosition.textContent = `${state.currentIndex + 1} / ${totalFiltered}`;
        dom.filterResultCount.textContent = t('filter_resultCount', [String(totalFiltered), String(state.currentIndex + 1)]);
    }

    // 進捗表示
    renderProgress();

    // 判定ボタンの状態
    updateDecisionButtons(ref);

    // メモ欄（変更があるためここではなくナビゲーション時や判定時に同期をとるが、
    // 表示切替時には値をセットする必要がある）
    dom.noteInput.value = ref.myDecision?.note || '';
    // noteInputの現所有者として記録する。persistDisplayedNote側で
    // 別文献に対する誤保存（幽霊pending判定）を防ぐための照合用。
    state.setLastRenderedRefId(ref.ref_id);
}

/**
 * 進捗状況の表示
 */
function renderProgress() {
    // フィルターと同じロジックで「判定済み」をカウントする
    // (r.statusはMLを含む合成ステータスの場合があるため、getMyManualDecisionStatusを使う)
    const labeledCount = state.references.filter((r) => {
        const status = getMyManualDecisionStatus(r);
        return status !== 'pending' && status !== 'conflict';
    }).length;
    const totalCount = state.references.length;
    const remainingCount = totalCount - labeledCount;
    const progressPercent = totalCount > 0 ? Math.round((labeledCount / totalCount) * 100) : 0;

    dom.progressText.textContent = `${labeledCount} / ${totalCount}`;

    // 励ましメッセージ
    let encourageMessage = '';
    if (totalCount === 0) {
        encourageMessage = t('progress_importPrompt');
    } else if (progressPercent === 0) {
        encourageMessage = t('progress_start');
    } else if (progressPercent <= 25) {
        encourageMessage = t('progress_goodStart');
    } else if (progressPercent <= 50) {
        encourageMessage = t('progress_goodPace');
    } else if (progressPercent <= 75) {
        encourageMessage = t('progress_pastHalf');
    } else if (progressPercent < 100) {
        encourageMessage = t('progress_nearGoal');
    } else {
        encourageMessage = t('progress_complete');
    }

    // 設定に応じて表示位置を切り替え
    if (state.showRecordCountBelow) {
        dom.navProgress.innerHTML = `
            <div class="nav-progress-main">${t('progress_count', [String(labeledCount), String(totalCount), String(remainingCount)])}</div>
            <div class="nav-progress-encourage">${encourageMessage}</div>
        `;
        dom.recordCountAbove.classList.add('hidden');
        dom.navProgress.classList.remove('hidden');
    } else {
        dom.recordCountAbove.innerHTML = `
            <div class="record-count-main">${t('progress_count', [String(labeledCount), String(totalCount), String(remainingCount)])}</div>
            <div class="record-count-encourage">${encourageMessage}</div>
        `;
        dom.recordCountAbove.classList.remove('hidden');
        dom.navProgress.classList.add('hidden');
    }

    updateFilterCounts();
}

/**
 * 判定ボタンのアクティブ状態を更新
 */
function updateDecisionButtons(ref: ReferenceWithStatus) {
    const myStatus = ref.myDecision?.decision || 'pending';
    dom.btnInclude.classList.toggle('active', myStatus === 'include');
    dom.btnMaybe.classList.toggle('active', myStatus === 'maybe');
    dom.btnExclude.classList.toggle('active', myStatus === 'exclude');
}

/**
 * 全レビュアーの判定を表示（キーオープン時）
 */
function renderAllDecisions(ref: ReferenceWithStatus) {
    if (!ref.allDecisions) return;


    // treatMlAsManualがオンの場合、手動とMLの両方があるかを検出
    const mixedReviewers = new Set<string>();
    if (state.treatMlAsManual) {
        const reviewerVersions = new Map<string, { hasManual: boolean; hasMl: boolean }>();
        ref.allDecisions.forEach((decision) => {
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

    const decisionsMap = new Map<string, ReferenceWithStatus['myDecision']>();
    ref.allDecisions.forEach((decision) => {
        const reviewerKey = getReviewerKey(decision);
        if (!reviewerKey) return;
        const existing = decisionsMap.get(reviewerKey);
        if (!existing || (decision.decided_at || '') > (existing.decided_at || '')) {
            decisionsMap.set(reviewerKey, decision);
        }
    });

    if (ref.myDecision) {
        const reviewerKey = getReviewerKey(ref.myDecision);
        if (reviewerKey && !decisionsMap.has(reviewerKey)) {
            decisionsMap.set(reviewerKey, ref.myDecision);
        }
    }

    const reviewersSource = state.enabledReviewers.size > 0
        ? state.enabledReviewers
        : state.availableReviewers;
    const reviewerIds = reviewersSource.size > 0
        ? Array.from(reviewersSource)
        : Array.from(decisionsMap.keys());

    dom.allDecisionsDiv.innerHTML = '';
    reviewerIds.forEach((reviewerKey) => {
        if (!reviewerKey) return;
        // treatMlAsManualがONの場合、::mlサフィックス付きのキーはスキップ
        // （既にメインのキーにマージされているため）
        if (state.treatMlAsManual && reviewerKey.endsWith('::ml')) {
            return;
        }
        const decision = decisionsMap.get(reviewerKey);
        const decisionValue = decision?.decision || 'pending';

        const div = document.createElement('div');
        div.className = `decision-item ${decisionValue}`;
        let icon = '';
        if (decisionValue === 'include') icon = '✓';
        else if (decisionValue === 'exclude') icon = '✕';
        else if (decisionValue === 'maybe') icon = '?';

        // ML Enhanced バッジ (treatMlAsManualがオンで混在の場合は非表示)
        let mlBadge = '';
        const isMixed = mixedReviewers.has(reviewerKey);
        if (!isMixed) {
            if (isMlAutoDecision(decision?.client_version)) {
                mlBadge = '<span class="ml-enhanced-badge auto">' + t('reviewer_mlAutoLabel') + '</span>';
            } else if (isMlDecision(decision?.client_version)) {
                mlBadge = '<span class="ml-enhanced-badge">' + t('reviewer_mlLabel') + '</span>';
            }
        }

        div.innerHTML = `
            <span class="reviewer">${getReviewerLabel(reviewerKey, state.userEmail, isMixed)}</span>
            <span class="decision">${icon} ${decisionValue}</span>
            ${mlBadge}
        `;

        if (decision?.note) {
            const noteDiv = document.createElement('div');
            noteDiv.className = 'note';

            // JSONパース（AI判定用）
            let isJson = false;
            // 短い文字列はJSONではないとみなす（最適化）
            if (decision.note.trim().startsWith('{') && decision.note.length > 20) {
                try {
                    const parsed = JSON.parse(decision.note);
                    if (parsed.reasons && Array.isArray(parsed.reasons)) {
                        isJson = true;

                        // Reasonsヘッダー
                        const label = document.createElement('div');
                        label.innerHTML = '<b>' + t('screening_aiReasons') + '</b>';
                        noteDiv.appendChild(label);

                        // リスト作成
                        const ul = document.createElement('ul');
                        ul.style.margin = '4px 0 8px 20px';
                        ul.style.padding = '0';
                        ul.style.listStyleType = 'disc';

                        parsed.reasons.forEach((r: string) => {
                            const li = document.createElement('li');
                            li.textContent = r;
                            li.style.marginBottom = '2px';
                            ul.appendChild(li);
                        });
                        noteDiv.appendChild(ul);
                    }
                } catch (e) {
                    // JSONパース失敗時は通常テキストとして表示
                }
            }

            if (!isJson) {
                noteDiv.textContent = t('screening_notePrefix', decision.note);
            }
            div.appendChild(noteDiv);
        }

        dom.allDecisionsDiv.appendChild(div);
    });
}


/**
 * キー状態ボタンの表示更新
 */
export function renderKeyStatus() {
    dom.keyToggleInput.checked = state.isKeyOpened;
}
