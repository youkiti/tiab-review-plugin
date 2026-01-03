import { state } from '../../state';
import { dom } from '../../dom';

import { getStoppingProgressPercent } from '../../../lib/ml/stopping-rules';
import { highlightText } from '../screening/render';
import { showToast } from '../../ui/feedback';
import { getMlFilteredRanking, parseMlSearchQuery, resolveMlRanking } from './search';

// Store互換レイヤー（Phase 5）
import { setMlState as syncSetMlState } from '../../store/compat';

const elements = {
    section: () => document.getElementById('ml-section'),
    badge: {
        container: () => document.getElementById('ml-status-badge'),
        text: () => document.getElementById('ml-status-text'),
    },
    stats: {
        include: () => document.getElementById('ml-count-include'),
        exclude: () => document.getElementById('ml-count-exclude'),
        remaining: () => document.getElementById('ml-count-remaining'),
    },
    stopping: {
        container: () => document.getElementById('ml-stopping-progress-container'),
        fill: () => document.getElementById('ml-stopping-progress-fill'),
        current: () => document.getElementById('ml-stopping-current'),
        threshold: () => document.getElementById('ml-stopping-threshold'),
        settingsBtn: () => document.getElementById('ml-stopping-settings-btn'),
    },
    ref: {
        title: () => document.getElementById('ml-ref-title'),
        authors: () => document.getElementById('ml-ref-authors'),
        year: () => document.getElementById('ml-ref-year'),
        abstract: () => document.getElementById('ml-ref-abstract'),
    },
    search: {
        input: () => document.getElementById('ml-search-input') as HTMLInputElement | null,
        resultCount: () => document.getElementById('ml-search-result-count'),
    },
    keywords: {
        includeList: () => document.getElementById('ml-include-keywords-list'),
        excludeList: () => document.getElementById('ml-exclude-keywords-list'),
    }
};

/**
 * MLセクション全体の表示更新
 */
export function renderMlSection() {
    const section = elements.section();
    if (!section) return;

    if (state.currentTab !== 'ml') {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    renderMlReference();
    renderMlStats();
    renderMlKeywords();
}

/**
 * 現在の文献を表示
 */
function renderMlReference() {
    const ranking = resolveMlRanking(state.references, state.mlState.ranking);
    const searchKeyword = elements.search.input()?.value.trim() || '';
    const { terms, mode } = parseMlSearchQuery(searchKeyword, state.termFilterUseAnd);
    const filteredRanking = getMlFilteredRanking(ranking, state.references, terms, mode);

    const resultCount = elements.search.resultCount();
    if (searchKeyword) {
        if (resultCount) {
            resultCount.classList.remove('hidden');
            if (filteredRanking.length === 0) {
                resultCount.textContent = `「${searchKeyword}」: 0件ヒット`;
                resultCount.classList.add('no-results');
            } else {
                resultCount.textContent = `「${searchKeyword}」: ${filteredRanking.length}件ヒット`;
                resultCount.classList.remove('no-results');
            }
        }
    } else if (resultCount) {
        resultCount.classList.add('hidden');
    }

    let index = state.mlState.currentIndex;
    if (index >= filteredRanking.length) {
        index = 0;
        if (state.mlState.currentIndex !== 0) {
            // Store経由で両方に同期
            syncSetMlState({ ...state.mlState, currentIndex: 0 });
        }
    }

    const refId = filteredRanking[index] || null;
    if (!refId) {
        // No records or finished
        elements.ref.title()!.textContent = searchKeyword
            ? '検索条件に一致する文献がありません'
            : 'No more records';
        elements.ref.authors()!.textContent = '';
        elements.ref.year()!.textContent = '';
        elements.ref.abstract()!.innerHTML = '';
        return;
    }

    const ref = state.references.find(r => r.ref_id === refId);
    if (!ref) return;

    const highlightTerms = terms.length > 0 ? terms : (searchKeyword ? [searchKeyword] : []);

    // ハイライト付きでタイトルと抄録を表示
    elements.ref.title()!.innerHTML = highlightText(ref.title || '', highlightTerms);
    elements.ref.authors()!.textContent = ref.authors || 'Unknown Authors';
    elements.ref.year()!.textContent = ref.year?.toString() || '';
    elements.ref.abstract()!.innerHTML = highlightText(ref.abstract || '(No Abstract)', highlightTerms);

    // メモ欄を復元
    dom.mlNoteInput.value = ref.myDecision?.note || '';
}


/**
 * キーワードリストの表示更新
 */
export function renderMlKeywords() {
    renderKeywordList('include', state.highlightKeywords.include, elements.keywords.includeList());
    renderKeywordList('exclude', state.highlightKeywords.exclude, elements.keywords.excludeList());
}

/**
 * キーワードリストをレンダリング（内部関数）
 */
function renderKeywordList(type: 'include' | 'exclude', keywords: string[], container: HTMLElement | null) {
    if (!container) return;
    container.innerHTML = '';

    for (const word of keywords) {
        if (!word) continue;

        const span = document.createElement('span');
        span.className = `keyword-tag ${type}`;

        span.innerHTML = `
            <span class="keyword-text" title="キーワード">${word}</span>
            <span class="remove-keyword" title="削除">×</span>
        `;

        // ×ボタンクリックでキーワード削除
        span.querySelector('.remove-keyword')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (type === 'include') {
                state.removeIncludeKeyword(word);
            } else {
                state.removeExcludeKeyword(word);
            }
            renderMlKeywords();
            renderMlReference(); // ハイライト即時反映
        });

        container.appendChild(span);
    }
}

/**
 * 検索入力ハンドラ
 */
export function handleMlSearchInput() {
    // 検索時は先頭へ戻して再描画
    // Store経由で両方に同期
    syncSetMlState({ ...state.mlState, currentIndex: 0 });
    renderMlReference();
}

/**
 * 統計情報の更新 (学習状態・停止基準)
 */
export function renderMlStats() {
    const { mlState } = state;

    // Status Badge
    const badgeContainer = elements.badge.container();
    const badgeText = elements.badge.text();

    if (badgeContainer && badgeText) {
        badgeContainer.className = 'ml-status-badge';
        switch (mlState.status) {
            case 'initializing':
                badgeText.textContent = '初期化中...';
                break;
            case 'training':
                badgeContainer.classList.add('training');
                badgeText.textContent = '学習中...';
                break;
            case 'ready':
                badgeContainer.classList.add('ready');
                badgeText.textContent = 'Ready';
                break;
            case 'error':
                badgeText.innerHTML = '<span style="color:red">Error</span>';
                break;
            default:
                badgeText.textContent = '未学習';
        }
    }

    // Label Counts
    if (elements.stats.include()) elements.stats.include()!.textContent = mlState.labeledCount.include.toString();
    if (elements.stats.exclude()) elements.stats.exclude()!.textContent = mlState.labeledCount.exclude.toString();

    // Remaining Count
    if (elements.stats.remaining()) {
        const total = state.references.length;
        const labeled = mlState.labeledCount.include + mlState.labeledCount.exclude;
        const remaining = Math.max(0, total - labeled);
        elements.stats.remaining()!.textContent = remaining.toString();
    }

    // Stopping Rule
    const stopping = mlState.stoppingRule;
    const stopContainer = elements.stopping.container();
    const settingsBtn = elements.stopping.settingsBtn();

    // ボタンのテキスト更新（常に実行）
    if (settingsBtn) {
        if (stopping) {
            settingsBtn.textContent = `連続 exclude ${stopping.threshold}件`;
        } else {
            settingsBtn.textContent = '設定なし';
        }
    }

    // プログレスバーの表示/非表示
    if (stopping && stopContainer) {
        stopContainer.classList.remove('hidden');
        if (elements.stopping.current()) elements.stopping.current()!.textContent = stopping.current.toString();
        if (elements.stopping.threshold()) elements.stopping.threshold()!.textContent = stopping.threshold.toString();

        const percent = getStoppingProgressPercent(stopping);
        if (elements.stopping.fill()) {
            elements.stopping.fill()!.style.width = `${percent}%`;
            // Change color if close to stopping
            if (percent >= 100) {
                elements.stopping.fill()!.style.backgroundColor = '#d93025'; // Red
            } else {
                elements.stopping.fill()!.style.backgroundColor = '#1a73e8'; // Blue
            }
        }
    } else if (stopContainer) {
        stopContainer.classList.add('hidden');
    }
}

/**
 * MLキーワード追加
 */
export function addMlKeyword(type: 'include' | 'exclude') {
    const inputId = type === 'include' ? 'ml-new-include-input' : 'ml-new-exclude-input';
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;

    const word = input.value.trim();
    if (!word) return;

    // 重複チェック
    const list = type === 'include' ? state.highlightKeywords.include : state.highlightKeywords.exclude;
    if (list.includes(word)) {
        input.value = '';
        return;
    }

    // 追加
    if (type === 'include') {
        state.addIncludeKeyword(word);
    } else {
        state.addExcludeKeyword(word);
    }

    input.value = '';
    renderMlKeywords();
    renderMlReference(); // ハイライト即時反映

    showToast(`「${word}」を追加しました`);
}
