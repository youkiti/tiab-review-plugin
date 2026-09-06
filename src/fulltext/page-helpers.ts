// page-helpers.ts - 表示文言・外部リンク・一時通知の共通ヘルパー。
// ページ状態だけを参照し、他の画面処理を呼び出さない。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { session } from './session';

export function showFeedback(msg: string, isError = false): void {
    const anchor = document.querySelector('.ft-decision-buttons');
    if (!anchor) return;
    const id = 'ft-feedback';
    document.getElementById(id)?.remove();
    const feedback = document.createElement('div');
    feedback.id = id;
    feedback.textContent = msg;
    feedback.style.cssText = `font-size:12px;margin-top:8px;color:${isError ? '#e74c3c' : '#27ae60'}`;
    anchor.insertAdjacentElement('afterend', feedback);
    if (session.feedbackTimer) clearTimeout(session.feedbackTimer);
    session.feedbackTimer = window.setTimeout(() => feedback.remove(), 3000);
}

export function appendTextWithBreaks(parent: HTMLElement, text: string): void {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
        if (idx > 0) parent.appendChild(document.createElement('br'));
        parent.appendChild(document.createTextNode(line));
    });
}

function isSafeLinkUrl(url: string): boolean {
    try {
        const parsed = new URL(url, window.location.href);
        return ['https:', 'http:', 'blob:', 'chrome-extension:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

export function buildExternalAnchor(url: string, label: string, className?: string): HTMLAnchorElement {
    const anchor = document.createElement('a');
    anchor.textContent = label;
    if (className) anchor.className = className;
    if (isSafeLinkUrl(url)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.href = url;
    } else {
        anchor.removeAttribute('href');
        anchor.title = '安全でないURL形式のためリンクを無効化しました';
    }
    return anchor;
}
