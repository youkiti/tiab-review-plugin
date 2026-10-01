/**
 * ツアーの入口: 初回の自動提案バナー、Picker 案内の中の提案ボタン、ツアー一覧パネル。
 * 「?」の吹き出しからの開始は ./index.ts の buildActions が持つ。遅延チャンク `guide-feature` に入る。
 */
import { t } from '../../../lib/i18n';
import type { GuideEventName } from '../../../lib/guide/tours';
import type { GuideTourId } from '../../../lib/guide/topics';
import { availableTours, shouldSuggest, suppressSuggestions } from '../../../lib/guide/tour-progress';
import { currentGuidePlatform } from './tour-conditions';
import { placeNear } from './placement';
import { startGuideTour } from './tour-runner';
import {
    getGuideProgress,
    isGuidePostponed,
    loadGuideProgress,
    postponeGuideSuggestions,
    updateGuideProgress,
} from './tour-store';

const BANNER_ID = 'guide-suggest-banner';
const LIST_ID = 'guide-tour-list';
/** 参加ツアーのうち、Picker の「Googleで許可する」を説明する手順 */
const PICKER_STEP_ID = 'allow';

function createButton(action: string, label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.guideAction = action;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

// ---------- 自動提案バナー ----------

function removeBanner(): void {
    document.getElementById(BANNER_ID)?.remove();
}

function buildBanner(): HTMLElement {
    const context = currentGuidePlatform();
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'guide-suggest-banner';

    const title = document.createElement('div');
    title.className = 'guide-suggest-title';
    title.textContent = t('guide_suggestTitle');

    const starts = document.createElement('div');
    starts.className = 'guide-suggest-actions';
    const startFor = (tourId: GuideTourId) => () => {
        removeBanner();
        void startGuideTour(tourId);
    };
    if (availableTours(context).some(tour => tour.id === 'first-project')) {
        starts.append(createButton('start-first-project', t('guideExt_suggestFirstProject'),
            'btn btn-primary btn-small', startFor('first-project')));
    }
    starts.append(createButton('start-join-project', t('guide_suggestJoinProject'),
        'btn btn-secondary btn-small', startFor('join-project')));

    const dismissals = document.createElement('div');
    dismissals.className = 'guide-suggest-dismissals';
    dismissals.append(
        createButton('later', t('guide_suggestLater'), 'btn btn-outline btn-xsmall', () => {
            postponeGuideSuggestions();
            removeBanner();
        }),
        createButton('never', t('guide_suggestNever'), 'btn btn-outline btn-xsmall', () => {
            updateGuideProgress(suppressSuggestions);
            removeBanner();
        }),
    );

    banner.append(title, starts, dismissals);
    return banner;
}

async function showSuggestionBanner(): Promise<void> {
    const progress = await loadGuideProgress();
    const context = currentGuidePlatform();
    const suggest = shouldSuggest(progress, {
        screen: 'project',
        platform: context.platform,
        capabilities: context.capabilities,
        postponedThisSession: isGuidePostponed(),
    });
    removeBanner();
    if (!suggest) return;
    const section = document.getElementById('project-section');
    if (!section || section.classList.contains('hidden')) return;
    const banner = buildBanner();
    const userRow = section.querySelector('.user-info-container');
    if (userRow) userRow.after(banner);
    else section.prepend(banner);
}

// ---------- Picker 案内の中の提案ボタン ----------

async function addPickerTourButton(): Promise<void> {
    const progress = await loadGuideProgress();
    const context = currentGuidePlatform();
    if (!availableTours(context).some(tour => tour.id === 'join-project')) return;
    if (progress.tours['join-project']?.status === 'done') return;
    if (progress.active?.tourId === 'join-project') return;
    const actions = document.querySelector<HTMLElement>('#status-message .status-actions');
    if (!actions || actions.querySelector('[data-guide-action="start-join-from-picker"]')) return;
    actions.append(createButton('start-join-from-picker', t('guide_joinFromPicker'),
        'btn btn-secondary', () => { void startGuideTour('join-project', PICKER_STEP_ID); }));
}

/** 本体チャンクが受ける、入口用のイベント処理。 */
export function handleEntryEvent(name: GuideEventName): Promise<void> {
    if (name === 'project-screen-shown') return showSuggestionBanner();
    if (name === 'picker-guidance-shown') return addPickerTourButton();
    return Promise.resolve();
}

// ---------- ツアー一覧 ----------

let listAnchor: HTMLElement | null = null;
let listListenersAttached = false;

export function closeGuideTourList(): void {
    document.getElementById(LIST_ID)?.remove();
    listAnchor?.setAttribute('aria-expanded', 'false');
    listAnchor = null;
}

function buildListItem(tourId: GuideTourId, titleKey: string, descriptionKey: string): HTMLElement {
    const done = getGuideProgress().tours[tourId]?.status === 'done';
    const item = document.createElement('div');
    item.className = 'guide-tour-item';
    item.dataset.guideTourItem = tourId;
    if (done) item.dataset.guideDone = 'true';

    const head = document.createElement('div');
    head.className = 'guide-tour-item-title';
    head.textContent = t(titleKey);
    if (done) {
        const check = document.createElement('span');
        check.className = 'guide-tour-item-check';
        check.textContent = '✓';
        head.append(check);
    }
    const description = document.createElement('div');
    description.className = 'guide-tour-item-desc';
    description.textContent = t(descriptionKey);

    const start = createButton('start', t(done ? 'guide_tourAgain' : 'guide_tourStart'),
        'btn btn-secondary btn-xsmall', () => {
            closeGuideTourList();
            void startGuideTour(tourId);
        });
    item.append(head, description, start);
    return item;
}

function buildList(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = LIST_ID;
    panel.className = 'guide-tour-list';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('guide_tourListTitle'));

    const header = document.createElement('div');
    header.className = 'guide-tour-list-header';
    const title = document.createElement('span');
    title.textContent = t('guide_tourListTitle');
    header.append(title, createButton('close-list', '✕', 'btn btn-outline btn-xsmall', closeGuideTourList));
    panel.append(header);
    for (const tour of availableTours(currentGuidePlatform())) {
        panel.append(buildListItem(tour.id, tour.titleKey, tour.descriptionKey));
    }
    return panel;
}

function attachListListeners(): void {
    if (listListenersAttached) return;
    listListenersAttached = true;
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${LIST_ID}, [data-tour="tour-list"]`)) return;
        closeGuideTourList();
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && listAnchor) {
            const anchor = listAnchor;
            closeGuideTourList();
            anchor.focus();
        }
    });
    window.addEventListener('resize', closeGuideTourList);
}

/** 🧭 ボタンのツアー一覧を開く。同じボタンをもう一度押すと閉じる。 */
export async function toggleGuideTourList(anchor: HTMLElement): Promise<void> {
    const wasOpenOnAnchor = listAnchor === anchor;
    closeGuideTourList();
    if (wasOpenOnAnchor) return;
    await loadGuideProgress();
    attachListListeners();
    const panel = buildList();
    document.body.append(panel);
    placeNear(panel, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    listAnchor = anchor;
    panel.querySelector<HTMLElement>('[data-guide-action="start"]')?.focus({ preventScroll: true });
}
