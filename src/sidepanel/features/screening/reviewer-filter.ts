/**
 * レビュアーフィルター機能
 * 他のレビュアーの判定を表示/非表示にする
 */

import { dom } from '../../dom';
import { state } from '../../state';

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

    if (!state.isKeyOpened) {
        filterContainer.classList.add('hidden');
        return;
    }

    filterContainer.classList.remove('hidden');
    const list = filterContainer.querySelector('.reviewer-list') as HTMLElement;
    if (!list) return;

    list.innerHTML = '';

    // Evidence Highlight Toggle
    if (state.availableReviewers.size > 0) {
        // AIレビュアーがいる場合のみ表示するか、常に表示するか。
        // AI判定が含まれている可能性が高いので常に表示で良いが、
        // AIが一人もいなければ意味がないのでチェックしても良い。
        // ここでは簡易的に常に表示（またはAIレビュアーがいるかチェック）
        const hasAi = Array.from(state.availableReviewers).some(id => id.startsWith('llm:'));

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

    state.availableReviewers.forEach(reviewerId => {
        const item = document.createElement('div');
        item.className = 'reviewer-filter-item';

        const label = document.createElement('label');
        label.className = 'reviewer-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.enabledReviewers.has(reviewerId);
        checkbox.dataset.reviewer = reviewerId;

        checkbox.addEventListener('change', () => handleReviewerToggle(reviewerId, checkbox.checked));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = reviewerId === state.userEmail ? `${reviewerId} (自分)` : reviewerId;

        // AIの場合の装飾と時刻表示
        if (reviewerId.startsWith('llm:')) {
            nameSpan.classList.add('reviewer-llm');

            // タイムスタンプの抽出と整形 (例: llm:model@2025-12-31T01:23:45.678Z)
            const parts = reviewerId.split('@');
            let label = '🤖 AI';

            if (parts.length > 1) {
                try {
                    const date = new Date(parts[1]);
                    // MM/DD HH:mm 形式に整形
                    const month = (date.getMonth() + 1).toString().padStart(2, '0');
                    const day = date.getDate().toString().padStart(2, '0');
                    const hours = date.getHours().toString().padStart(2, '0');
                    const minutes = date.getMinutes().toString().padStart(2, '0');
                    label = `🤖 AI (${month}/${day} ${hours}:${minutes})`;
                } catch (e) {
                    // 日付変換エラー時はそのまま
                    console.error('Date parse error for reviewer:', reviewerId);
                }
            }
            nameSpan.textContent = label;

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
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const includeSpan = document.createElement('span');
            includeSpan.textContent = '(🟢)';
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
                if (_renderCurrentReference) _renderCurrentReference();
            });

            const excludeSpan = document.createElement('span');
            excludeSpan.textContent = '(❌)';
            excludeSpan.title = '除外';

            excludeLabel.appendChild(excludeCheckbox);
            excludeLabel.appendChild(excludeSpan);

            filterContainer.appendChild(includeLabel);
            filterContainer.appendChild(excludeLabel);

            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.appendChild(filterContainer);
        }

        label.appendChild(checkbox);
        label.appendChild(nameSpan);
        item.appendChild(label);
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
