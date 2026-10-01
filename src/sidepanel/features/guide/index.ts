/**
 * アプリ内ヘルプ（「?」ボタン）の吹き出し本体。遅延チャンク `guide-feature` に入る。
 * 入口は ./lazy.ts。対応表は src/lib/guide/topics.ts が正本。
 */
import { t } from '../../../lib/i18n';
import { platform } from '../../../platform';
import {
    GUIDE_TOPICS,
    buildHelpUrl,
    buildVideoUrl,
    guideTopicTitleKey,
    isGuideTopicId,
    type GuideTopic,
    type GuideTopicId,
} from '../../../lib/guide/topics';

/** 吹き出しに並べるボタン。ツアー開始など、後から項目を足せるよう配列で持つ。 */
interface GuideAction {
    id: string;
    label: string;
    run: () => void;
}

interface OpenPopover {
    element: HTMLElement;
    anchor: HTMLElement;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

let current: OpenPopover | null = null;
let listenersAttached = false;

function uiLanguage(): 'ja' | 'en' {
    return t('guide_language') === 'ja' ? 'ja' : 'en';
}

function topicTitle(topicId: GuideTopicId): string {
    return t(guideTopicTitleKey(topicId));
}

function buildActions(topicId: GuideTopicId): GuideAction[] {
    const topic: GuideTopic = GUIDE_TOPICS[topicId];
    const actions: GuideAction[] = [
        {
            id: 'help',
            label: t('guide_readHelp'),
            run: () => platform().openExternal(buildHelpUrl(topicId, uiLanguage())),
        },
    ];
    const video = topic.video;
    if (video) {
        actions.push({
            id: 'video',
            label: t('guide_watchVideo'),
            run: () => platform().openExternal(buildVideoUrl(video)),
        });
    }
    return actions;
}

function buildPopover(topicId: GuideTopicId): HTMLElement {
    const popover = document.createElement('div');
    popover.className = 'guide-popover';
    popover.setAttribute('role', 'dialog');
    const title = topicTitle(topicId);
    popover.setAttribute('aria-label', title);

    const heading = document.createElement('div');
    heading.className = 'guide-popover-title';
    heading.textContent = title;
    popover.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'guide-popover-actions';
    for (const action of buildActions(topicId)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'guide-popover-action';
        button.dataset.guideAction = action.id;
        button.textContent = action.label;
        button.addEventListener('click', () => {
            action.run();
            closeGuidePopover();
        });
        list.appendChild(button);
    }
    popover.appendChild(list);
    return popover;
}

/** ボタンの近くに置き、サイドパネルの幅（左右）と高さ（下端）からはみ出さないよう寄せる。 */
function placePopover(popover: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft);
    let top = rect.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
        top = Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - height);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function handleOutsideClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // 「?」自身のクリックは toggleGuidePopover が扱う
    if (target.closest('.guide-popover, [data-help]')) return;
    closeGuidePopover();
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !current) return;
    const anchor = current.anchor;
    closeGuidePopover();
    anchor.focus();
}

function attachListeners(): void {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener('click', handleOutsideClick, true);
    document.addEventListener('keydown', handleKeydown);
    // 固定配置のため、スクロール・リサイズでボタンと位置がずれる前に閉じる
    window.addEventListener('resize', closeGuidePopover);
    window.addEventListener('scroll', closeGuidePopover, true);
}

export function closeGuidePopover(): void {
    if (!current) return;
    current.element.remove();
    current.anchor.setAttribute('aria-expanded', 'false');
    current = null;
}

/** 「?」ボタンの吹き出しを開く。同じボタンをもう一度押すと閉じる。 */
export function toggleGuidePopover(anchor: HTMLElement): void {
    const wasOpenOnAnchor = current?.anchor === anchor;
    closeGuidePopover();
    if (wasOpenOnAnchor) return;

    const topicId = anchor.dataset.help ?? '';
    if (!isGuideTopicId(topicId)) return;

    attachListeners();
    const element = buildPopover(topicId);
    document.body.appendChild(element);
    placePopover(element, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    current = { element, anchor };
    element.querySelector<HTMLElement>('.guide-popover-action')?.focus({ preventScroll: true });
}
