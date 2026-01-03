/**
 * レビュアーフィルター機能
 * 他のレビュアーの判定を表示/非表示にする
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { getReviewerLabel, isLlmReviewerKey, isMlReviewerKey } from './reviewer-utils';

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
                if (decision.client_version === '0.1.0') {
                    current.hasManual = true;
                }
                if (decision.client_version?.startsWith('0.7.0-ml') && !decision.client_version.includes('auto')) {
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

    // Evidence Highlight Toggle
    if (state.availableReviewers.size > 0) {
        // AIレビュアーがいる場合のみ表示するか、常に表示するか。
        // AI判定が含まれている可能性が高いので常に表示で良いが、
        // AIが一人もいなければ意味がないのでチェックしても良い。
        // ここでは簡易的に常に表示（またはAIレビュアーがいるかチェック）
        const hasAi = Array.from(state.availableReviewers).some(id => isLlmReviewerKey(id));

        if (hasAi) {
            const toggleDiv = document.createElement('div');
            toggleDiv.className = 'reviewer-filter-item highlight-toggle';
            toggleDiv.style.borderBottom = '1px solid #eee';
            toggleDiv.style.marginBottom = '8px';
            toggleDiv.style.paddingBottom = '8px';

            const label = document.createElement('label');
            label.className = 'reviewer-label';
            label.style.fontWeight = 'bold';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.showAiHighlights;

            checkbox.addEventListener('change', () => {
                state.setShowAiHighlights(checkbox.checked);
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const span = document.createElement('span');
            span.textContent = '💡 AIの根拠をハイライト';

            label.appendChild(checkbox);
            label.appendChild(span);
            toggleDiv.appendChild(label);
            list.appendChild(toggleDiv);

        }
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
        checkbox.checked = isEnabledBase || isEnabledMl;
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
        });

        const nameSpan = document.createElement('span');
        // 混在情報を含むラベルを表示
        nameSpan.textContent = getReviewerLabel(reviewerId, state.userEmail, isMixed);

        // AIの場合の装飾
        if (isLlmReviewerKey(reviewerId)) {
            nameSpan.classList.add('reviewer-llm');


            // AI判定フィルター（AIレビュアーの右側に配置）
            const filterContainer = document.createElement('div');
            filterContainer.style.display = 'flex';
            filterContainer.style.gap = '8px';
            filterContainer.style.marginLeft = 'auto';
            filterContainer.style.fontSize = '0.85em';

            // Include filter
            const includeLabel = document.createElement('label');
            includeLabel.style.display = 'flex';
            includeLabel.style.alignItems = 'center';
            includeLabel.style.gap = '2px';
            includeLabel.style.cursor = 'pointer';

            const includeCheckbox = document.createElement('input');
            includeCheckbox.type = 'checkbox';
            includeCheckbox.checked = state.aiDecisionFilter.include;
            includeCheckbox.addEventListener('change', (e) => {
                e.stopPropagation();
                state.setAiDecisionFilter({
                    ...state.aiDecisionFilter,
                    include: includeCheckbox.checked
                });
                // フィルター適用のためインデックスをリセットして再描画
                state.setCurrentIndex(0);
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const includeSpan = document.createElement('span');
            includeSpan.textContent = '(🟢組み入れ判断)';
            includeSpan.title = '組み入れ';

            includeLabel.appendChild(includeCheckbox);
            includeLabel.appendChild(includeSpan);

            // Exclude filter
            const excludeLabel = document.createElement('label');
            excludeLabel.style.display = 'flex';
            excludeLabel.style.alignItems = 'center';
            excludeLabel.style.gap = '2px';
            excludeLabel.style.cursor = 'pointer';

            const excludeCheckbox = document.createElement('input');
            excludeCheckbox.type = 'checkbox';
            excludeCheckbox.checked = state.aiDecisionFilter.exclude;
            excludeCheckbox.addEventListener('change', (e) => {
                e.stopPropagation();
                state.setAiDecisionFilter({
                    ...state.aiDecisionFilter,
                    exclude: excludeCheckbox.checked
                });
                // フィルター適用のためインデックスをリセットして再描画
                state.setCurrentIndex(0);
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const excludeSpan = document.createElement('span');
            excludeSpan.textContent = '(❌除外判断)';
            excludeSpan.title = '除外';

            excludeLabel.appendChild(excludeCheckbox);
            excludeLabel.appendChild(excludeSpan);

            filterContainer.appendChild(includeLabel);
            filterContainer.appendChild(excludeLabel);

            // 先にラベルを追加（AI名）
            label.appendChild(checkbox);
            label.appendChild(nameSpan);
            item.appendChild(label);

            // その後にフィルターを右側に追加
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.appendChild(filterContainer);
        } else {
            // 人間のレビュアーは通常通り
            label.appendChild(checkbox);
            label.appendChild(nameSpan);
            item.appendChild(label);
        }
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
