import { state } from '../../state';
import { getStoppingProgressPercent } from '../../../lib/ml/stopping-rules';

const elements = {
    section: () => document.getElementById('ml-section'),
    badge: {
        container: () => document.getElementById('ml-status-badge'),
        text: () => document.getElementById('ml-status-text'),
    },
    stats: {
        include: () => document.getElementById('ml-count-include'),
        exclude: () => document.getElementById('ml-count-exclude'),
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
}

/**
 * 現在の文献を表示
 */
function renderMlReference() {
    const ranking = state.mlState.ranking;
    const index = state.mlState.currentIndex;

    let refId: string | null = null;

    if (ranking.length > 0 && index < ranking.length) {
        refId = ranking[index];
    } else if (state.references.length > 0 && index < state.references.length) {
        // Fallback to normal order if ranking not ready
        refId = state.references[index].ref_id;
    }

    if (!refId) {
        // No records or finished
        elements.ref.title()!.textContent = 'No more records';
        elements.ref.abstract()!.textContent = '';
        return;
    }

    const ref = state.references.find(r => r.ref_id === refId);
    if (!ref) return;

    elements.ref.authors()!.textContent = ref.authors || 'Unknown Authors';
    elements.ref.year()!.textContent = ref.year?.toString() || '';
    elements.ref.abstract()!.textContent = ref.abstract || '(No Abstract)';
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

    // Stopping Rule
    const stopping = mlState.stoppingRule;
    const stopContainer = elements.stopping.container();
    const settingsBtn = elements.stopping.settingsBtn();

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

        if (settingsBtn) {
            settingsBtn.textContent = `連続 exclude ${stopping.threshold}件`;
        }
    } else {
        if (stopContainer) stopContainer.classList.add('hidden');
        if (settingsBtn) settingsBtn!.textContent = '設定なし';
    }
}
