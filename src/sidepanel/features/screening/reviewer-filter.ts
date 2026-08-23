/**
 * レビュアーフィルター機能
 * 他のレビュアーの判定を表示/非表示にする
 */

import { t } from '../../../lib/i18n';
import { dom } from '../../dom';
import { state } from '../../state';
import { getReviewerLabel, isActiveConfirmedLlmDecision, isLlmReviewerKey, isMlReviewerKey } from './reviewer-utils';
import { isHumanDecision, isConfirmedMlDecision } from '../../../lib/client-version';

const ML_REVIEWER_SUFFIX = '::ml';

// 外部レンダリング関数への参照
let _renderCurrentReference: (() => void) | null = null;

export function setReviewerFilterDependencies(deps: {
    renderCurrentReference: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
}

/**
 * レビュアーフィルターリストを描画
 */
export function renderReviewerFilter() {
    const filterContainer = dom.reviewerFilterContainer;
    // dom.reviewerFilterList がまだ定義されていない可能性があるのでチェック
    // TODO: dom.ts に reviewerFilterList を追加する必要がある

    // サイドパネルのHTML構造に合わせた実装
    // Blind off 時のみ表示されるコンテナを想定
    if (!filterContainer) return; // Ensure the container exists after the dom update

    console.log('[renderReviewerFilter] isKeyOpened:', state.isKeyOpened, 'availableReviewers:', Array.from(state.availableReviewers));

    if (!state.isKeyOpened) {
        filterContainer.classList.add('hidden');
        return;
    }

    filterContainer.classList.remove('hidden');
    const list = filterContainer.querySelector('.reviewer-list') as HTMLElement;
    if (!list) return;

    list.innerHTML = '';

    // treatMlAsManualがオンの場合、手動とML両方があるレビュアーを検出
    const mixedReviewers = new Set<string>();
    if (state.treatMlAsManual) {
        const reviewerVersions = new Map<string, { hasManual: boolean; hasMl: boolean }>();
        state.references.forEach(ref => {
            if (!ref.allDecisions) return;
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
        });

        reviewerVersions.forEach((versions, reviewerId) => {
            if (versions.hasManual && versions.hasMl) {
                mixedReviewers.add(reviewerId);
            }
        });
    }



    // treatMlAsManualがオンの場合、::mlサフィックス付きのレビュアーをスキップ
    // 対応する通常のキーがある場合のみスキップ
    const processedReviewers = new Set<string>();

    state.availableReviewers.forEach(reviewerId => {
        // treatMlAsManualがオンで、::ml付きのレビュアーの場合
        if (state.treatMlAsManual && isMlReviewerKey(reviewerId)) {
            // 対応する通常のキーがあるかチェック
            const baseId = reviewerId.slice(0, -ML_REVIEWER_SUFFIX.length);
            if (state.availableReviewers.has(baseId)) {
                // スキップ（通常のキーで表示される）
                return;
            }
        }

        // 既に処理済みの場合はスキップ
        if (processedReviewers.has(reviewerId)) return;
        processedReviewers.add(reviewerId);

        const item = document.createElement('div');
        item.className = 'reviewer-filter-item';

        const label = document.createElement('label');
        label.className = 'reviewer-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        // treatMlAsManualがオンの場合、混在レビュアーは両方のキーを考慮
        const isMixed = mixedReviewers.has(reviewerId);
        const mlKey = reviewerId + ML_REVIEWER_SUFFIX;
        const isEnabledBase = state.enabledReviewers.has(reviewerId);
        const isEnabledMl = state.treatMlAsManual && isMixed && state.enabledReviewers.has(mlKey);
        const isReviewerEnabled = isEnabledBase || isEnabledMl;
        checkbox.checked = isReviewerEnabled;
        checkbox.dataset.reviewer = reviewerId;

        checkbox.addEventListener('change', () => {
            // 混在の場合は両方のキーを同期
            if (state.treatMlAsManual && isMixed) {
                handleReviewerToggle(reviewerId, checkbox.checked);
                if (state.availableReviewers.has(mlKey)) {
                    handleReviewerToggle(mlKey, checkbox.checked);
                }
            } else {
                handleReviewerToggle(reviewerId, checkbox.checked);
            }
            // disabled 表示を更新するため、レビュアーフィルター UI を再描画
            renderReviewerFilter();
        });

        const nameSpan = document.createElement('span');
        // 混在情報を含むラベルを表示
        nameSpan.textContent = getReviewerLabel(reviewerId, state.userEmail, isMixed);

        if (isLlmReviewerKey(reviewerId)) {
            nameSpan.classList.add('reviewer-llm');
        }

        // 判定フィルター（include / exclude）を AI / 人間ともに配置
        const filterContainer = document.createElement('div');
        filterContainer.style.display = 'flex';
        filterContainer.style.gap = '8px';
        filterContainer.style.marginLeft = 'auto';
        filterContainer.style.fontSize = '0.85em';
        if (!isReviewerEnabled) {
            filterContainer.style.opacity = '0.4';
        }

        const currentFilter = state.aiDecisionFilter[reviewerId] ?? { include: true, exclude: true, maybe: true };

        const decisionLabels: Record<'include' | 'exclude' | 'maybe', { text: string; title: string }> = {
            include: { text: t('filter_includeDecision'), title: t('filter_includeLabel') },
            exclude: { text: t('filter_excludeDecision'), title: t('filter_excludeLabel') },
            maybe: { text: t('filter_maybeDecision'), title: t('filter_maybeLabel') },
        };

        const buildDecisionToggle = (kind: 'include' | 'exclude' | 'maybe') => {
            const wrapper = document.createElement('label');
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';
            wrapper.style.gap = '2px';
            wrapper.style.cursor = isReviewerEnabled ? 'pointer' : 'not-allowed';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = currentFilter[kind] ?? true;
            input.disabled = !isReviewerEnabled;
            input.addEventListener('change', (e) => {
                e.stopPropagation();
                const prev = state.aiDecisionFilter[reviewerId] ?? { include: true, exclude: true, maybe: true };
                state.setAiDecisionFilter({
                    ...state.aiDecisionFilter,
                    [reviewerId]: { ...prev, [kind]: input.checked }
                });
                state.setCurrentIndex(0);
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const text = document.createElement('span');
            text.textContent = decisionLabels[kind].text;
            text.title = decisionLabels[kind].title;

            wrapper.appendChild(input);
            wrapper.appendChild(text);
            return wrapper;
        };

        filterContainer.appendChild(buildDecisionToggle('include'));
        filterContainer.appendChild(buildDecisionToggle('exclude'));
        filterContainer.appendChild(buildDecisionToggle('maybe'));

        label.appendChild(checkbox);
        label.appendChild(nameSpan);
        item.appendChild(label);
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.appendChild(filterContainer);

        list.appendChild(item);
    });
}

/**
 * レビュアーの表示切替
 */
export function handleReviewerToggle(reviewerId: string, enabled: boolean) {
    if (enabled) {
        state.addEnabledReviewer(reviewerId);
    } else {
        state.removeEnabledReviewer(reviewerId);
    }

    // 現在の表示を更新
    if (_renderCurrentReference) {
        _renderCurrentReference();
    }
}

/**
 * AI Evidenceハイライトトグルの表示/非表示を更新
 * Blind状態（isKeyOpened）に依存せず、AIレビュアーの有無のみで制御する
 */
export function renderAiHighlightToggle() {
    const container = dom.aiHighlightContainer;
    if (!container) return;

    // 閾値確定済みで有効なAI判定が少なくとも1件存在する場合のみ表示
    const hasConfirmedAi = state.references.some((ref) =>
        ref.allDecisions?.some((decision) => isActiveConfirmedLlmDecision(decision)) ?? false
    );

    if (hasConfirmedAi) {
        container.classList.remove('hidden');
        // チェックボックスの状態を同期
        dom.aiHighlightCheckbox.checked = state.showAiHighlights;
    } else {
        state.setShowAiHighlights(false);
        dom.aiHighlightCheckbox.checked = false;
        container.classList.add('hidden');
    }
}

/**
 * AI Evidenceハイライトチェックボックスのイベントリスナーを初期化
 * 初期化時に1回だけ呼び出すこと（HTMLに静的配置されたチェックボックス用）
 */
export function initAiHighlightListener() {
    const checkbox = dom.aiHighlightCheckbox;
    if (!checkbox) return;

    checkbox.addEventListener('change', () => {
        state.setShowAiHighlights(checkbox.checked);
        if (_renderCurrentReference) _renderCurrentReference();
    });
}

/**
 * 合議モードトグル・バッジの表示を更新する。
 * 合議はブラインド中に成立しないため、state.isKeyOpened===true のときだけトグルを表示する
 * （フルテキストの裁定UIと同じガード。AGENTS.md「フルテキストの不一致解消（裁定）」参照）。
 * バッジは「トグルが見えている and ON」のときだけ出す（押し忘れ防止の視覚的インジケータ）。
 */
export function renderConsensusModeToggle() {
    const container = dom.consensusModeContainer;
    if (container) {
        if (state.isKeyOpened) {
            container.classList.remove('hidden');
            if (dom.consensusModeCheckbox) {
                dom.consensusModeCheckbox.checked = state.consensusMode;
            }
        } else {
            container.classList.add('hidden');
            // トグルを隠すだけでは state.consensusMode が残ってしまい、非表示のまま
            // 合議判定（-human-consensus）が保存され続ける事故になる（プロジェクト切替時に顕在化）。
            // バッジの表示判定より前に state を落とすこと。
            state.setConsensusMode(false);
            if (dom.consensusModeCheckbox) {
                dom.consensusModeCheckbox.checked = false;
            }
        }
    }

    const badge = dom.consensusModeBadge;
    if (badge) {
        badge.classList.toggle('hidden', !(state.isKeyOpened && state.consensusMode));
    }
}

/**
 * 合議モードチェックボックスのイベントリスナーを初期化
 * 初期化時に1回だけ呼び出すこと（HTMLに静的配置されたチェックボックス用）
 */
export function initConsensusModeListener() {
    const checkbox = dom.consensusModeCheckbox;
    if (!checkbox) return;

    checkbox.addEventListener('change', () => {
        state.setConsensusMode(checkbox.checked);
        renderConsensusModeToggle();
    });
}
