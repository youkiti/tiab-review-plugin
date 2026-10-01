/**
 * ツアーの実行。対象の要素を強調し、近くに本文のカードを出して、利用者の操作（イベント）で次の手順へ進める。
 * 手順の定義は src/lib/guide/tours.ts、状態遷移は lib/guide/tour-progress.ts の純関数、保存は ./tour-store.ts。
 * 遅延チャンク `guide-feature` に入る。同時に走るツアーは1本だけ。
 */
import { t } from '../../../lib/i18n';
import { GUIDE_TOURS, type GuideEventName, type TourDefinition, type TourStep } from '../../../lib/guide/tours';
import type { GuideTourId } from '../../../lib/guide/topics';
import {
    availableTours,
    completeTour,
    dismissTour,
    nextStepIndex,
    setActiveStep,
    shouldAdvance,
    startTour,
} from '../../../lib/guide/tour-progress';
import { computeGuideConditions, currentGuidePlatform } from './tour-conditions';
import { loadGuideProgress, updateGuideProgress } from './tour-store';

/** 強調の枠を対象より外側へ広げる量（px）、カードと対象の間隔、画面端の余白 */
const HIGHLIGHT_PAD = 3;
const CARD_GAP = 8;
const MARGIN = 8;
/** DOM の変化・スクロール・リサイズで拾えない配置のずれ（style による表示切替など）を拾う間隔 */
const REFRESH_INTERVAL_MS = 400;

interface RunningTour {
    tour: TourDefinition;
    index: number;
}

let running: RunningTour | null = null;
let card: HTMLElement | null = null;
let highlight: HTMLElement | null = null;
let block: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let refreshTimer: number | undefined;
let frame = 0;
/** 手順の開始後、対象が最初に見えたときに一度だけスクロールして画面内へ入れる */
let needsScroll = false;
let inertTarget: HTMLElement | null = null;
/** アプリのダイアログ（#modal-backdrop）が対象を隠している間は true（ダイアログ待ちの表示） */
let modalMode = false;

function currentStep(): TourStep | null {
    return running ? running.tour.steps[running.index] : null;
}

function isVisible(element: HTMLElement): boolean {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

/** 同じ data-tour 値の要素が複数ある（🧭 など）ときは、表示中のものを選ぶ。 */
function findTarget(name: string): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`));
    return candidates.find(isVisible) ?? null;
}

function createDiv(className: string, id?: string): HTMLElement {
    const element = document.createElement('div');
    if (id) element.id = id;
    element.className = className;
    return element;
}

function createButton(action: string, className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.guideAction = action;
    return button;
}

function ensureElements(): void {
    if (card && highlight && block) return;
    highlight = createDiv('guide-tour-highlight hidden', 'guide-tour-highlight');
    block = createDiv('guide-tour-block hidden', 'guide-tour-block');

    card = createDiv('guide-tour-card', 'guide-tour-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-live', 'polite');
    const progress = createDiv('guide-tour-progress');
    const text = createDiv('guide-tour-text');
    const waiting = createDiv('guide-tour-waiting hidden');
    waiting.textContent = t('guide_tourWaiting');
    const actions = createDiv('guide-tour-actions');
    const next = createButton('next', 'btn btn-primary btn-xsmall');
    next.addEventListener('click', handleNext);
    const end = createButton('end', 'btn btn-outline btn-xsmall');
    end.textContent = t('guide_tourEnd');
    end.addEventListener('click', handleEnd);
    actions.append(next, end);
    card.append(progress, text, waiting, actions);

    document.body.append(highlight, block, card);
}

function isOwnElement(node: Node): boolean {
    return [card, highlight, block].some(element => element !== null && element.contains(node));
}

function startObserving(): void {
    if (observer) return;
    observer = new MutationObserver(records => {
        if (records.every(record => isOwnElement(record.target))) return;
        scheduleReposition();
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden'],
    });
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
    refreshTimer = window.setInterval(scheduleReposition, REFRESH_INTERVAL_MS);
}

function stopObserving(): void {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', scheduleReposition);
    window.removeEventListener('scroll', scheduleReposition, true);
    if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
    if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
}

function scheduleReposition(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        reposition();
    });
}

function setInert(target: HTMLElement | null): void {
    if (inertTarget === target) return;
    inertTarget?.removeAttribute('inert');
    inertTarget = target;
    inertTarget?.setAttribute('inert', '');
}

function placeBox(element: HTMLElement, rect: DOMRect, pad: number): void {
    element.style.left = `${rect.left - pad}px`;
    element.style.top = `${rect.top - pad}px`;
    element.style.width = `${rect.width + pad * 2}px`;
    element.style.height = `${rect.height + pad * 2}px`;
}

/** 対象の位置にカード・枠・覆いを合わせる。対象が見えないときはカードを画面下部に固定する。 */
function reposition(): void {
    const step = currentStep();
    if (!running || !step || !card || !highlight || !block) return;

    const target = findTarget(step.target);
    const waitingText = card.querySelector<HTMLElement>('.guide-tour-waiting');
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const cardWidth = card.offsetWidth;

    // ダイアログが開いていて、対象がその中に無いときは「ダイアログ待ち」にする
    const backdrop = document.getElementById('modal-backdrop');
    const dialogOpen = backdrop !== null && isVisible(backdrop);
    const waitingForDialog = dialogOpen && !(target && backdrop.contains(target));
    if (waitingForDialog !== modalMode) {
        modalMode = waitingForDialog;
        renderContent();
    }
    card.classList.toggle('guide-tour-card--over-modal', modalMode);

    // 対象が見えないときだけ「この操作ができる画面を開いてください」を出す。表示の切り替えが
    // カードの高さを変えるので、位置の計算はその後に行う
    if (waitingText) waitingText.classList.toggle('hidden', target !== null || modalMode);
    if (target && !modalMode) {
        card.removeAttribute('data-guide-waiting');
        card.removeAttribute('data-guide-waiting-reason');
    } else {
        card.dataset.guideWaiting = 'true';
        if (modalMode) card.dataset.guideWaitingReason = 'modal';
        else card.removeAttribute('data-guide-waiting-reason');
    }
    const cardHeight = card.offsetHeight;

    if (modalMode) {
        // 枠と覆いは出さず、ダイアログのボタンに重ならない端（下→上の順）へカードを固定する
        highlight.classList.add('hidden');
        block.classList.add('hidden');
        setInert(null);
        const dialog = backdrop?.querySelector<HTMLElement>('.modal-content')?.getBoundingClientRect();
        let top = viewportHeight - cardHeight - MARGIN;
        if (dialog && top < dialog.bottom + CARD_GAP && MARGIN + cardHeight <= dialog.top - CARD_GAP) top = MARGIN;
        card.style.left = `${Math.max(MARGIN, (viewportWidth - cardWidth) / 2)}px`;
        card.style.top = `${Math.max(MARGIN, top)}px`;
        return;
    }

    if (!target) {
        highlight.classList.add('hidden');
        block.classList.add('hidden');
        setInert(null);
        card.style.left = `${Math.max(MARGIN, (viewportWidth - cardWidth) / 2)}px`;
        card.style.top = `${Math.max(MARGIN, viewportHeight - cardHeight - MARGIN)}px`;
        return;
    }

    if (needsScroll) {
        needsScroll = false;
        const tall = target.getBoundingClientRect().height > viewportHeight * 0.6;
        target.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest' });
    }

    const rect = target.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
    highlight.classList.toggle('hidden', !inViewport);
    if (inViewport) placeBox(highlight, rect, HIGHLIGHT_PAD);

    const blocking = step.blockTarget === true;
    block.classList.toggle('hidden', !(blocking && inViewport));
    if (blocking && inViewport) placeBox(block, rect, HIGHLIGHT_PAD);
    setInert(blocking ? target : null);

    // 対象の下→上→画面下部の順に、収まる場所へカードを置く
    const left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, viewportWidth - cardWidth - MARGIN));
    let top = rect.bottom + HIGHLIGHT_PAD + CARD_GAP;
    if (top + cardHeight > viewportHeight - MARGIN) {
        const above = rect.top - HIGHLIGHT_PAD - CARD_GAP - cardHeight;
        top = above >= MARGIN ? above : Math.max(MARGIN, viewportHeight - cardHeight - MARGIN);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

/** 手順が変わったときに、カードの中身（番号・本文・ボタン）を作り直す。 */
function renderContent(): void {
    const step = currentStep();
    if (!running || !step || !card) return;
    const { tour, index } = running;
    card.dataset.guideTour = tour.id;
    card.dataset.guideStep = step.id;
    const progress = card.querySelector<HTMLElement>('.guide-tour-progress');
    if (progress) progress.textContent = `${index + 1} / ${tour.steps.length}`;
    const text = card.querySelector<HTMLElement>('.guide-tour-text');
    if (text) text.textContent = t(modalMode ? 'guide_tourModalOpen' : step.textKey);

    const next = card.querySelector<HTMLElement>('[data-guide-action="next"]');
    if (next) {
        next.classList.toggle('hidden', modalMode || step.advance.type !== 'next');
        const isLast = nextStepIndex(tour, index + 1, computeGuideConditions()) === null;
        next.textContent = t(isLast ? 'guide_tourDone' : 'guide_tourNext');
    }
}

function showStep(tour: TourDefinition, index: number): void {
    running = { tour, index };
    needsScroll = true;
    ensureElements();
    renderContent();
    startObserving();
    reposition();
}

/** 表示を片づける（保存はしない）。 */
function stopTour(): void {
    stopObserving();
    setInert(null);
    card?.remove();
    highlight?.remove();
    block?.remove();
    card = null;
    highlight = null;
    block = null;
    running = null;
    modalMode = false;
}

/** 次の手順へ。null なら最後まで行ったことになり、完了を保存して閉じる。 */
function goTo(index: number | null): void {
    if (!running) return;
    const { tour } = running;
    if (index === null) {
        updateGuideProgress(progress => completeTour(progress, tour.id, new Date().toISOString()));
        stopTour();
        return;
    }
    if (index === running.index) return;
    updateGuideProgress(progress => setActiveStep(progress, index));
    showStep(tour, index);
}

function handleNext(): void {
    if (!running || modalMode) return;
    const { tour, index } = running;
    goTo(nextStepIndex(tour, index + 1, computeGuideConditions()));
}

function handleEnd(): void {
    if (!running) return;
    const tourId = running.tour.id;
    updateGuideProgress(progress => dismissTour(progress, tourId, new Date().toISOString()));
    stopTour();
}

/** ツアーを始める。実行中のツアーがあれば置き換える。fromStepId を渡すとその手順から始める。 */
export async function startGuideTour(tourId: GuideTourId, fromStepId?: string): Promise<void> {
    await loadGuideProgress();
    const tour = GUIDE_TOURS[tourId];
    const from = fromStepId ? Math.max(0, tour.steps.findIndex(step => step.id === fromStepId)) : 0;
    const index = nextStepIndex(tour, from, computeGuideConditions());
    stopTour();
    if (index === null) {
        updateGuideProgress(progress => completeTour(progress, tourId, new Date().toISOString()));
        return;
    }
    updateGuideProgress(progress => startTour(progress, tourId, index));
    showStep(tour, index);
}

/** 保存されている実行中のツアーを、パネルを開き直したあとに続きから再開する。 */
export async function resumeGuideTour(): Promise<void> {
    const progress = await loadGuideProgress();
    const active = progress.active;
    if (!active || running) return;
    const tour = GUIDE_TOURS[active.tourId];
    if (!availableTours(currentGuidePlatform()).some(candidate => candidate.id === tour.id)) {
        updateGuideProgress(current => ({ ...current, active: null }));
        return;
    }
    const index = nextStepIndex(tour, active.stepIndex, computeGuideConditions());
    if (index === null) {
        updateGuideProgress(current => completeTour(current, tour.id, new Date().toISOString()));
        return;
    }
    if (index !== active.stepIndex) updateGuideProgress(current => setActiveStep(current, index));
    showStep(tour, index);
}

/**
 * 画面側のイベントを受ける。今の手順を進めるイベントなら次へ進み、そうでなくても
 * 画面の状態が変わって今の手順の skipIf が真になっていれば先へ進める。
 */
export function handleTourEvent(name: GuideEventName): void {
    if (!running) return;
    const { tour, index } = running;
    const step = tour.steps[index];
    const conditions = computeGuideConditions();
    if (shouldAdvance(step, name)) {
        goTo(nextStepIndex(tour, index + 1, conditions));
        return;
    }
    const settled = nextStepIndex(tour, index, conditions);
    if (settled !== index) goTo(settled);
}
