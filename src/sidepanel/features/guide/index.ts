/**
 * アプリ内ヘルプ（「?」ボタン）の吹き出し本体。遅延チャンク `guide-feature` に入る。
 * 入口は ./lazy.ts。対応表は src/lib/guide/topics.ts が正本。
 */
import { t } from '../../../lib/i18n';
import { platform } from '../../../platform';
import { availableTours } from '../../../lib/guide/tour-progress';
import {
    GUIDE_TOPICS,
    buildHelpUrl,
    buildVideoUrl,
    guideTopicTitleKey,
    isGuideTopicId,
    type GuideTopic,
    type GuideTopicId,
} from '../../../lib/guide/topics';
import { placeNear } from './anchor-placement';
import { computeGuideConditions, currentGuidePlatform } from './tour-conditions';
import { toggleGuideTourList } from './tour-entry';
import { startGuideTour } from './tour-runner';

export { initGuide, handleGuideEvent, resumeGuide } from './tour-lifecycle';

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

let current: OpenPopover | null = null;
let listenersAttached = false;

function uiLanguage(): 'ja' | 'en' {
    return t('guide_language') === 'ja' ? 'ja' : 'en';
}

function topicTitle(topicId: GuideTopicId): string {
    return t(guideTopicTitleKey(topicId));
}

function buildActions(topicId: GuideTopicId, anchor: HTMLElement): GuideAction[] {
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
    // このトピックに対応するツアーが、このプラットフォームで使えるときだけ開始ボタンを足す
    const tourId = topic.tourId;
    // 今の状態では使えないツアー（unavailableIf）は出さない
    if (tourId && availableTours(currentGuidePlatform()).some(tour => tour.id === tourId)
        && availableTours(currentGuidePlatform(), undefined, computeGuideConditions()).some(tour => tour.id === tourId)) {
        actions.push({
            id: 'tour',
            label: t('guide_startTourHere'),
            run: () => { void startGuideTour(tourId); },
        });
    }
    // 一覧に出せるツアーが1本でもあるときだけ、ツアー一覧を開くボタンを足す
    if (topic.tourList && availableTours(currentGuidePlatform(), undefined, computeGuideConditions()).length > 0) {
        actions.push({
            id: 'tour-list',
            label: t('guide_tourListAction'),
            run: () => { void toggleGuideTourList(anchor); },
        });
    }
    return actions;
}

function buildPopover(topicId: GuideTopicId, anchor: HTMLElement): HTMLElement {
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
    for (const action of buildActions(topicId, anchor)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'guide-popover-action';
        button.dataset.guideAction = action.id;
        button.textContent = action.label;
        button.addEventListener('click', () => {
            // 先に閉じる（閉じるときに anchor の aria-expanded を戻すので、一覧を開く run の後だと上書きされる）
            closeGuidePopover();
            action.run();
        });
        list.appendChild(button);
    }
    popover.appendChild(list);
    return popover;
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
    const element = buildPopover(topicId, anchor);
    document.body.appendChild(element);
    placeNear(element, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    current = { element, anchor };
    element.querySelector<HTMLElement>('.guide-popover-action')?.focus({ preventScroll: true });
}
