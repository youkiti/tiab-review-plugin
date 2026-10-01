/**
 * ツアーの実行。対象の要素を強調し、近くに本文のカードを出して、利用者の操作（イベント）で次の手順へ進める。
 * 手順の定義は src/lib/guide/tours/（ツアーごとのファイル）、状態遷移は lib/guide/tour-progress.ts の純関数、保存は ./tour-store.ts。
 * 画面（サイドパネル・全文の判定ページ）に依存する部分（条件の計算・プラットフォームの判定・ダイアログの場所）は
 * createTourRunner の引数 host で受け取る。同時に走るツアーは1画面につき1本で、画面をまたいだ置き換えは
 * ./tour-store.ts の保存値の共有で表示を合わせる。
 */
import { t } from '../lib/i18n';
import { GUIDE_TOURS, type GuideEventName, type TourDefinition, type TourStep } from '../lib/guide/tours';
import type { GuideTourId } from '../lib/guide/topics';
import {
    availableTours,
    completeTour,
    dismissTour,
    nextStepIndex,
    setActiveStep,
    isTourUnavailable,
    shouldAdvance,
    startTour,
    visibleStepPosition,
    type GuideConditionValues,
} from '../lib/guide/tour-progress';
import { computeInDialogCardPosition, computeModalWaitPosition, computeTourCardPosition } from './placement';
import { getGuideProgress, loadGuideProgress, subscribeGuideProgressChange, updateGuideProgress } from './tour-store';

/** 強調の枠を対象より外側へ広げる量（px）、カードと対象の間隔、画面端の余白 */
const HIGHLIGHT_PAD = 3;
const CARD_GAP = 8;
const MARGIN = 8;
/** DOM の変化・スクロール・リサイズで拾えない配置のずれ（style による表示切替など）を拾う間隔 */
const REFRESH_INTERVAL_MS = 400;

/** ランナーが画面から受け取る、画面ごとに違う部分。 */
export interface TourRunnerHost {
    /** このランナーが動かすツアーの画面（TourDefinition.page）。ほかの画面のツアーは始めも再開もしない */
    page: TourDefinition['page'];
    /** 今の画面の状態から、skipIf の各条件の真偽を作る */
    computeConditions: () => GuideConditionValues;
    /** 拡張版か Web 版か（使えるツアーの判定に使う） */
    platformContext: () => { platform: 'extension' | 'web'; capabilities: { createProject: boolean } };
    /**
     * アプリのダイアログの場所。backdrop が表示されていて、対象がその中に無いあいだは「ダイアログ待ち」にする。
     * content・footer は backdrop の中を探すセレクタ（カードをダイアログのボタンに重ねないために使う）。
     */
    modal: { backdropId: string; contentSelector: string; footerSelector: string };
    /**
     * 真なら、対象の下にも上にも収まらないとき、カードを対象の横に置く（幅の広い画面で、縦に長い対象を覆わないため）。
     * 省略時は偽。サイドパネルは幅が狭いので使わない。
     */
    cardSideFallback?: boolean;
}

export interface TourRunner {
    /** ツアーを始める。実行中のツアーがあれば置き換える。fromStepId を渡すとその手順から始める。 */
    start(tourId: GuideTourId, fromStepId?: string): Promise<void>;
    /** 保存されている実行中のツアーを、画面を開き直したあとに続きから再開する。 */
    resume(): Promise<void>;
    /** 画面側のイベントを受ける。今の手順を進めるイベントなら次へ進む。 */
    handleEvent(name: GuideEventName): void;
}

interface RunningTour {
    tour: TourDefinition;
    index: number;
}

function isVisible(element: HTMLElement): boolean {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

/** 同じ data-tour 値の要素が複数ある（❓ など）ときは、表示中のものを選ぶ。 */
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

function placeBox(element: HTMLElement, rect: DOMRect, pad: number): void {
    element.style.left = `${rect.left - pad}px`;
    element.style.top = `${rect.top - pad}px`;
    element.style.width = `${rect.width + pad * 2}px`;
    element.style.height = `${rect.height + pad * 2}px`;
}

export function createTourRunner(host: TourRunnerHost): TourRunner {
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
    /** アプリのダイアログが対象を隠している間は true（ダイアログ待ちの表示） */
    let modalMode = false;
    let subscribed = false;

    function currentStep(): TourStep | null {
        return running ? running.tour.steps[running.index] : null;
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

    /** 対象の位置にカード・枠・覆いを合わせる。対象が見えないときはカードを画面下部に固定する。 */
    function reposition(): void {
        const step = currentStep();
        if (!running || !step || !card || !highlight || !block) return;

        const target = findTarget(step.target);
        const rectOf = (selector: string): DOMRect | undefined =>
            document.getElementById(host.modal.backdropId)?.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const waitingText = card.querySelector<HTMLElement>('.guide-tour-waiting');
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight;
        // 前の描画で付けた小さい表示のクラスが残っていると、通常表示の寸法を小さく測り、位置が行き来して点滅する。
        // 先に外してから測る（小さい表示にするときは、位置を決めたあとに付け直す）
        card.classList.remove('guide-tour-card--compact');
        const cardWidth = card.offsetWidth;

        // ダイアログが開いていて、対象がその中に無いときは「ダイアログ待ち」にする
        const backdrop = document.getElementById(host.modal.backdropId);
        const dialogOpen = backdrop !== null && isVisible(backdrop);
        const waitingForDialog = dialogOpen && !(target && backdrop.contains(target));
        if (waitingForDialog !== modalMode) {
            modalMode = waitingForDialog;
            renderContent();
        }
        // 対象がダイアログの中にあるときは、枠・覆い・カードをダイアログより前面に出す
        const inDialog = backdrop !== null && dialogOpen && target !== null && backdrop.contains(target);
        card.classList.toggle('guide-tour-card--over-modal', modalMode || inDialog);
        highlight.classList.toggle('guide-tour-highlight--over-modal', inDialog);
        block.classList.toggle('guide-tour-block--over-modal', inDialog);

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
            // 枠と覆いは出さず、ダイアログのボタンに重ならない場所へカードを置く。下にも上にも収まらないときは
            // 小さい表示（クリックを通す）に切り替える
            highlight.classList.add('hidden');
            block.classList.add('hidden');
            setInert(null);
            const dialog = rectOf(host.modal.contentSelector);
            const footer = rectOf(host.modal.footerSelector);
            const viewport = { width: viewportWidth, height: viewportHeight };
            // 小さい表示の寸法は、クラスを付けて測ってから元に戻す（描画の前に済むので見えない）
            const normalSize = { width: card.offsetWidth, height: card.offsetHeight };
            card.classList.add('guide-tour-card--compact');
            const compactSize = { width: card.offsetWidth, height: card.offsetHeight };
            card.classList.remove('guide-tour-card--compact');
            const position = computeModalWaitPosition({
                viewport, card: normalSize, compactCard: compactSize, margin: MARGIN, gap: CARD_GAP,
                dialog: dialog ? { top: dialog.top, bottom: dialog.bottom } : null,
                footer: footer ? { top: footer.top, bottom: footer.bottom } : null,
            });
            card.classList.toggle('guide-tour-card--compact', position.compact);
            if (position.compact) card.dataset.guideCompact = 'true';
            else card.removeAttribute('data-guide-compact');
            card.style.left = `${position.left}px`;
            card.style.top = `${position.top}px`;
            return;
        }
        card.classList.remove('guide-tour-card--compact');
        card.removeAttribute('data-guide-compact');

        const viewport = { width: viewportWidth, height: viewportHeight };
        const cardSize = { width: cardWidth, height: cardHeight };
        const place = (box: DOMRect | null): void => {
            const input = {
                viewport, card: cardSize, margin: MARGIN, gap: CARD_GAP, pad: HIGHLIGHT_PAD,
                target: box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : null,
                allowSide: host.cardSideFallback === true,
            };
            if (inDialog && input.target) {
                // ダイアログの中の対象: フッターのボタンに重なるときは小さい表示（クリックを通す）にする
                card!.classList.add('guide-tour-card--compact');
                const compactCard = { width: card!.offsetWidth, height: card!.offsetHeight };
                card!.classList.remove('guide-tour-card--compact');
                const footer = rectOf(host.modal.footerSelector);
                const position = computeInDialogCardPosition({
                    ...input, target: input.target, compactCard,
                    footer: footer ? { top: footer.top, bottom: footer.bottom } : null,
                });
                card!.classList.toggle('guide-tour-card--compact', position.compact);
                if (position.compact) card!.dataset.guideCompact = 'true';
                else card!.removeAttribute('data-guide-compact');
                card!.style.left = `${position.left}px`;
                card!.style.top = `${position.top}px`;
                return;
            }
            const position = computeTourCardPosition(input);
            card!.style.left = `${position.left}px`;
            card!.style.top = `${position.top}px`;
        };

        if (!target) {
            highlight.classList.add('hidden');
            block.classList.add('hidden');
            setInert(null);
            place(null);
            return;
        }

        if (needsScroll) {
            needsScroll = false;
            const box = target.getBoundingClientRect();
            const fullyVisible = box.top >= 0 && box.bottom <= viewportHeight;
            if (step.scroll === 'start') {
                target.scrollIntoView({ block: 'start', inline: 'nearest' });
            } else if (!(step.scroll === 'if-hidden' && fullyVisible)) {
                const tall = box.height > viewportHeight * 0.6;
                target.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest' });
            }
        }

        const rect = target.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
        highlight.classList.toggle('hidden', !inViewport);
        if (inViewport) placeBox(highlight, rect, HIGHLIGHT_PAD);

        const blocking = step.blockTarget === true;
        block.classList.toggle('hidden', !(blocking && inViewport));
        if (blocking && inViewport) placeBox(block, rect, HIGHLIGHT_PAD);
        setInert(blocking ? target : null);

        // 対象の下→上→画面下端の順に配置する（対象が画面の外ならカードは画面下端）
        place(rect);
    }

    /** 手順が変わったときに、カードの中身（番号・本文・ボタン）を作り直す。 */
    function renderContent(): void {
        const step = currentStep();
        if (!running || !step || !card) return;
        const { tour, index } = running;
        card.dataset.guideTour = tour.id;
        card.dataset.guideStep = step.id;
        const progress = card.querySelector<HTMLElement>('.guide-tour-progress');
        if (progress) {
            // 条件で飛ばされる手順は数えない。条件は途中で変わりうるので描画のたびに数え直す
            const { position, total } = visibleStepPosition(tour, index, host.computeConditions());
            progress.textContent = `${position} / ${total}`;
        }
        const text = card.querySelector<HTMLElement>('.guide-tour-text');
        if (text) text.textContent = t(modalMode ? 'guide_tourModalOpen' : step.textKey);

        const next = card.querySelector<HTMLElement>('[data-guide-action="next"]');
        if (next) {
            // 'next' の手順は常に「次へ」を出す。optional な events の手順は、イベントでも進むが「押さずに次へ」も出す
            const optional = step.advance.type === 'events' && step.advance.optional === true;
            next.classList.toggle('hidden', modalMode || !(step.advance.type === 'next' || optional));
            const isLast = nextStepIndex(tour, index + 1, host.computeConditions()) === null;
            next.textContent = t(optional ? 'guide_tourSkip' : isLast ? 'guide_tourDone' : 'guide_tourNext');
        }
    }

    /** 別の画面がほかのツアーを始めて保存値が置き換わったら、こちらの表示を片づける（保存はしない）。 */
    function ensureSubscribed(): void {
        if (subscribed) return;
        subscribed = true;
        subscribeGuideProgressChange(() => {
            if (running && getGuideProgress().active?.tourId !== running.tour.id) stopTour();
        });
    }

    function showStep(tour: TourDefinition, index: number): void {
        running = { tour, index };
        needsScroll = true;
        ensureSubscribed();
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
        goTo(nextStepIndex(tour, index + 1, host.computeConditions()));
    }

    function handleEnd(): void {
        if (!running) return;
        const tourId = running.tour.id;
        updateGuideProgress(progress => dismissTour(progress, tourId, new Date().toISOString()));
        stopTour();
    }

    async function start(tourId: GuideTourId, fromStepId?: string): Promise<void> {
        await loadGuideProgress();
        const tour = GUIDE_TOURS[tourId];
        // 中身の無い枠と、ほかの画面のツアー（その画面のランナーが扱う）は、ここでは始めない
        if (tour.draft || tour.page !== host.page) return;
        // 今の状態では使えないツアー（unavailableIf）は始めない。実行中のツアーの再開（resume）は止めない
        if (isTourUnavailable(tour, host.computeConditions())) return;
        const from = fromStepId ? Math.max(0, tour.steps.findIndex(step => step.id === fromStepId)) : 0;
        const index = nextStepIndex(tour, from, host.computeConditions());
        stopTour();
        if (index === null) {
            updateGuideProgress(progress => completeTour(progress, tourId, new Date().toISOString()));
            return;
        }
        updateGuideProgress(progress => startTour(progress, tourId, index));
        showStep(tour, index);
    }

    async function resume(): Promise<void> {
        const progress = await loadGuideProgress();
        const active = progress.active;
        if (!active || running) return;
        const tour = GUIDE_TOURS[active.tourId];
        if (tour.page !== host.page) return; // ほかの画面のツアーは、そちらの画面が再開する
        if (!availableTours(host.platformContext()).some(candidate => candidate.id === tour.id)) {
            updateGuideProgress(current => ({ ...current, active: null }));
            return;
        }
        const index = nextStepIndex(tour, active.stepIndex, host.computeConditions());
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
    function handleEvent(name: GuideEventName): void {
        if (!running) return;
        const { tour, index } = running;
        const step = tour.steps[index];
        const conditions = host.computeConditions();
        if (shouldAdvance(step, name)) {
            goTo(nextStepIndex(tour, index + 1, conditions));
            return;
        }
        const settled = nextStepIndex(tour, index, conditions);
        if (settled !== index) goTo(settled);
    }

    return { start, resume, handleEvent };
}
