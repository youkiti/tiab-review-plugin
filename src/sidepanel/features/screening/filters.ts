/**
 * スクリーニングフィルタリングモジュール
 * 文献のフィルタリングロジック
 */

import { state } from '../../state';
import { dom } from '../../dom';
import type { ReferenceWithStatus, DecisionStatus } from '../../../lib/types';
import { createSmartRegex } from '../../utils/text';
import { deleteReferencesBySourceFile, getReferencesWithStatus } from '../../../lib/sheets-api';
import { showToast, showLoading } from '../../ui/feedback';

// 外部描画関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;

export function setFilterDependencies(deps: {
    renderCurrentReference: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
}

/**
 * フィルタリング済み文献リストを取得
 */
export function getFilteredReferences(): ReferenceWithStatus[] {
    let filtered = state.references;

    // ステータスフィルター
    if (state.currentFilter !== 'all') {
        filtered = filtered.filter((r) => r.status === state.currentFilter);
    }

    // ソースファイルフィルター
    if (state.selectedSourceFiles.size > 0 && state.selectedSourceFiles.size < state.sourceFiles.size) {
        filtered = filtered.filter(r => r.source_file && state.selectedSourceFiles.has(r.source_file));
    }

    // 検索フィルター
    const searchTerm = dom.searchInput.value.toLowerCase().trim();
    if (searchTerm) {
        filtered = filtered.filter(
            (r) =>
                r.title.toLowerCase().includes(searchTerm) ||
                r.abstract?.toLowerCase().includes(searchTerm)
        );
    }

    // タームフィルター（AND/OR条件）
    const termFilters = state.activeTermFilters;
    if (termFilters.length > 0) {
        if (state.termFilterUseAnd) {
            // AND条件: すべてのtermにマッチ
            for (const termFilter of termFilters) {
                const regex = createSmartRegex(termFilter.term);
                filtered = filtered.filter(r => {
                    const text = `${r.title} ${r.abstract || ''}`;
                    return regex.test(text);
                });
            }
        } else {
            // OR条件: いずれかのtermにマッチ
            filtered = filtered.filter(r => {
                const text = `${r.title} ${r.abstract || ''}`;
                return termFilters.some(termFilter => {
                    const regex = createSmartRegex(termFilter.term);
                    return regex.test(text);
                });
            });
        }
    }

    return filtered;
}

/**
 * フィルターの件数を更新
 */
export function updateFilterCounts() {
    // ソースファイルフィルターを適用したものでカウント
    let filtered = state.references;
    if (state.selectedSourceFiles.size > 0 && state.selectedSourceFiles.size < state.sourceFiles.size) {
        filtered = state.references.filter(r => r.source_file && state.selectedSourceFiles.has(r.source_file));
    }

    const counts = {
        pending: filtered.filter(r => r.status === 'pending').length,
        all: filtered.length,
        include: filtered.filter(r => r.status === 'include').length,
        exclude: filtered.filter(r => r.status === 'exclude').length,
        maybe: filtered.filter(r => r.status === 'maybe').length,
        conflict: filtered.filter(r => r.status === 'conflict').length,
    };

    const options = dom.statusFilter.options;
    options[0].textContent = `未判定 (${counts.pending})`;
    options[1].textContent = `すべて (${counts.all})`;
    options[2].textContent = `Include (${counts.include})`;
    options[3].textContent = `Exclude (${counts.exclude})`;
    options[4].textContent = `Maybe (${counts.maybe})`;
    options[5].textContent = `不一致 (${counts.conflict})`;
}

/**
 * ソースファイルフィルターを描画
 */
export function renderSourceFilters() {
    dom.sourceFileListDiv.innerHTML = '';

    if (state.sourceFiles.size === 0) {
        dom.sourceFiltersSection.classList.add('hidden');
        return;
    }
    dom.sourceFiltersSection.classList.remove('hidden');

    state.sourceFiles.forEach(file => {
        // このファイルのレコード数をカウント
        const count = state.references.filter(r => r.source_file === file).length;

        const div = document.createElement('div');
        div.className = 'source-file-item';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.justifyContent = 'space-between';

        const leftGroup = document.createElement('div');
        leftGroup.style.display = 'flex';
        leftGroup.style.alignItems = 'center';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `source-${file}`;
        checkbox.checked = state.selectedSourceFiles.has(file);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.addSelectedSourceFile(file);
            } else {
                state.removeSelectedSourceFile(file);
            }
            // フィルター適用
            state.setCurrentIndex(0);
            if (_renderCurrentReference) _renderCurrentReference();
        });

        const label = document.createElement('label');
        label.htmlFor = `source-${file}`;
        label.textContent = `${file} (${count})`;
        label.style.marginLeft = '8px';

        leftGroup.appendChild(checkbox);
        leftGroup.appendChild(label);

        // Delete Button
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = 'このファイルの文献をすべて削除';
        deleteBtn.className = 'btn-icon';
        deleteBtn.style.marginLeft = '8px';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (confirm(`ファイル "${file}" に含まれる ${count} 件の文献をスプレッドシートから完全に削除しますか？\n（この操作は取り消せません）`)) {
                try {
                    showLoading(true);
                    showToast(`${file} を削除中...`, 5000);

                    const deletedCount = await deleteReferencesBySourceFile(state.spreadsheetId, file);

                    // データを再読み込み
                    const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);
                    state.setReferences(refs);

                    // 状態更新
                    if (state.references.filter(r => r.source_file === file).length === 0) {
                        state.sourceFiles.delete(file);
                        state.selectedSourceFiles.delete(file);
                    }

                    // UI更新
                    renderSourceFilters();
                    state.setCurrentIndex(0);
                    if (_renderCurrentReference) _renderCurrentReference();

                    showToast(`${deletedCount} 件を削除しました`);

                } catch (err) {
                    console.error('Delete error:', err);
                    showToast(`削除エラー: ${(err as Error).message}`);
                } finally {
                    showLoading(false);
                }
            }
        };

        div.appendChild(leftGroup);
        div.appendChild(deleteBtn);
        dom.sourceFileListDiv.appendChild(div);
    });
}

/**
 * ステータスフィルターの変更を処理
 */
export function handleStatusFilterChange() {
    state.setCurrentFilter(dom.statusFilter.value as DecisionStatus | 'all');
    state.setCurrentIndex(0);
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * 検索入力の変更を処理
 */
export function handleSearchInput() {
    state.setCurrentIndex(0);
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームフィルターを追加
 */
export function addTermFilter(term: string, type: 'include' | 'exclude') {
    // 既存チェック
    const exists = state.activeTermFilters.some(
        f => f.term.toLowerCase() === term.toLowerCase() && f.type === type
    );
    if (exists) return;

    state.addTermFilter({ term, type });
    state.setCurrentIndex(0);
    renderActiveTermFilters();
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームフィルターを削除
 */
export function removeTermFilter(term: string, type: string) {
    state.removeTermFilter(term, type);
    state.setCurrentIndex(0);
    renderActiveTermFilters();
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームクリック処理（イベント委譲用）
 */
export function handleTermClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('highlight-include')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'include');
    } else if (target.classList.contains('highlight-exclude')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'exclude');
    } else if (target.classList.contains('highlight-search')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'include');
    }
}

/**
 * アクティブなタームフィルターを描画
 */
export function renderActiveTermFilters() {
    if (!dom.activeTermFiltersDiv) return;

    if (state.activeTermFilters.length === 0) {
        dom.activeTermFiltersDiv.classList.add('hidden');
        return;
    }

    dom.activeTermFiltersDiv.classList.remove('hidden');
    dom.activeTermFiltersDiv.innerHTML = '';

    for (const filter of state.activeTermFilters) {
        const tag = document.createElement('span');
        tag.className = `term-filter-tag ${filter.type}`;
        tag.innerHTML = `
            ${filter.term}
            <span class="remove-btn" data-term="${filter.term}" data-type="${filter.type}">×</span>
        `;
        dom.activeTermFiltersDiv.appendChild(tag);
    }
}
