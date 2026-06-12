/**
 * フルテキストタブ
 * 候補プール（共通ルール準拠）の一覧と自分のフルテキスト判定状況を表示し、
 * 各文献のフルテキストページ（新規タブ）への導線を提供する。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { getFulltextCandidateList } from './screening/filters';
import { switchToTab } from './llm';
import type { ReferenceWithStatus } from '../../lib/types';

const STATUS_META: Record<string, { icon: string; cls: string }> = {
    include: { icon: '✓', cls: 'include' },
    exclude: { icon: '✕', cls: 'exclude' },
    maybe: { icon: '?', cls: 'maybe' },
    pending: { icon: '・', cls: 'pending' },
};

/**
 * フルテキストタブを開く
 */
export function activateFulltextTab(): void {
    switchToTab('fulltext');
    renderFulltextTab();
}

function myFulltextStatus(ref: ReferenceWithStatus): string {
    const d = ref.myFulltextDecision;
    if (d && d.decision !== 'pending') return d.decision;
    return 'pending';
}

/**
 * フルテキストタブの内容を描画
 */
export function renderFulltextTab(): void {
    const candidates = getFulltextCandidateList();
    const decided = candidates.filter(r => myFulltextStatus(r) !== 'pending').length;

    // 進捗行
    dom.fulltextProgressLine.textContent = t('fulltext_progressLine', [String(decided), String(candidates.length)]);

    // ルール行
    const rule = state.fulltextPoolRule;
    dom.fulltextRuleLine.textContent = rule
        ? t('fulltext_ruleLine', [String(rule.threshold), String(rule.voters.length)])
        : t('fulltext_ruleUnset');

    // 一覧
    const listDiv = dom.fulltextListDiv;
    listDiv.innerHTML = '';

    if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'fulltext-empty';
        empty.textContent = t('fulltext_emptyList');
        listDiv.appendChild(empty);
        return;
    }

    for (const ref of candidates) {
        const status = myFulltextStatus(ref);
        const meta = STATUS_META[status] ?? STATUS_META['pending'];

        const card = document.createElement('div');
        card.className = `fulltext-card status-${meta.cls}`;
        card.title = t('fulltext_openTitle');

        const metaParts: string[] = [];
        if (ref.year) metaParts.push(String(ref.year));
        if (ref.journal) metaParts.push(ref.journal);

        card.innerHTML = `
            <span class="fulltext-card-status ${meta.cls}">${meta.icon}</span>
            <span class="fulltext-card-body">
                <span class="fulltext-card-title">${escapeHtml(ref.title || ref.ref_id)}</span>
                <span class="fulltext-card-meta">${escapeHtml(metaParts.join(' · '))}</span>
            </span>
            <span class="fulltext-card-open">↗</span>
        `;
        card.addEventListener('click', () => {
            const url = chrome.runtime.getURL('fulltext/fulltext.html') + `?ref_id=${encodeURIComponent(ref.ref_id)}`;
            chrome.tabs.create({ url });
        });

        listDiv.appendChild(card);
    }
}

/**
 * イベントリスナーを設定（sidepanel.ts から呼ぶ）
 */
export function setupFulltextTabListeners(): void {
    dom.tabFulltextBtn?.addEventListener('click', () => activateFulltextTab());
    dom.fulltextBackBtn?.addEventListener('click', () => switchToTab('screening'));
}
