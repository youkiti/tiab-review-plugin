/**
 * ツアーの入口: 初回の自動提案バナー、Picker 案内の中の提案ボタン、ツアー一覧パネル。
 * 「?」の吹き出しからの開始は ./index.ts の buildActions が持つ。遅延チャンク `guide-feature` に入る。
 */
import { t } from '../../../lib/i18n';
import type { GuideEventName, TourDefinition } from '../../../lib/guide/tours';
import type { GuideTourId } from '../../../lib/guide/topics';
import {
    availableTours,
    dismissTour,
    shouldSuggest,
    suppressSuggestions,
    tourToSuggestOnEvent,
} from '../../../lib/guide/tour-progress';
import { buildTourSuggestBand, createGuideButton } from '../../../guide-ui/suggest-band';
import {
    getGuideProgress,
    isGuidePostponed,
    loadGuideProgress,
    postponeGuideSuggestions,
    updateGuideProgress,
} from '../../../guide-ui/tour-store';
import { currentGuidePlatform } from './tour-conditions';
import { placeNear } from './anchor-placement';
import { startGuideTour } from './tour-runner';

const BANNER_ID = 'guide-suggest-banner';
const LIST_ID = 'guide-tour-list';
const TAB_SUGGEST_ID = 'guide-tab-suggest';
/** 参加ツアーのうち、Picker の「Googleで許可する」を説明する手順 */
const PICKER_STEP_ID = 'allow';

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
        starts.append(createGuideButton('start-first-project', t('guideExt_suggestFirstProject'),
            'btn btn-primary btn-small', startFor('first-project')));
    }
    starts.append(createGuideButton('start-join-project', t('guide_suggestJoinProject'),
        'btn btn-secondary btn-small', startFor('join-project')));

    const dismissals = document.createElement('div');
    dismissals.className = 'guide-suggest-dismissals';
    dismissals.append(
        createGuideButton('later', t('guide_suggestLater'), 'btn btn-outline btn-xsmall', () => {
            postponeGuideSuggestions();
            removeBanner();
        }),
        createGuideButton('never', t('guide_suggestNever'), 'btn btn-outline btn-xsmall', () => {
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
    actions.append(createGuideButton('start-join-from-picker', t('guide_joinFromPicker'),
        'btn btn-secondary', () => { void startGuideTour('join-project', PICKER_STEP_ID); }));
}

// ---------- タブを初めて開いたときの提案の帯 ----------

/** タブを開いたイベントと、そのタブの section の id。 */
const TAB_SECTION_IDS: Partial<Record<GuideEventName, string>> = {
    'tab-opened-screening': 'screening-section',
    'tab-opened-ml': 'ml-section',
    'tab-opened-llm': 'llm-section',
    'tab-opened-fulltext': 'fulltext-section',
};
/** 古い非同期の結果が、新しいタブの帯を上書きしたり重ねたりしないための通し番号 */
let tabSuggestSeq = 0;

function removeTabSuggestion(): void {
    document.getElementById(TAB_SUGGEST_ID)?.remove();
}

function buildTabSuggestion(tour: TourDefinition): HTMLElement {
    return buildTourSuggestBand({
        id: TAB_SUGGEST_ID,
        tour,
        onDismiss: () => {
            updateGuideProgress(progress => dismissTour(progress, tour.id, new Date().toISOString()));
            removeTabSuggestion();
        },
        onStart: () => {
            removeTabSuggestion();
            void startGuideTour(tour.id);
        },
    });
}

/** タブを開いたとき、前の帯を消し、そのタブに提案するツアーがあれば上部に帯を出す（帯は1つだけ）。 */
async function showTabSuggestion(name: GuideEventName): Promise<void> {
    const seq = ++tabSuggestSeq;
    removeTabSuggestion();
    const sectionId = TAB_SECTION_IDS[name];
    if (!sectionId) return;
    const progress = await loadGuideProgress();
    if (seq !== tabSuggestSeq) return;
    const tour = tourToSuggestOnEvent(progress, name, currentGuidePlatform());
    if (!tour) return;
    const section = document.getElementById(sectionId);
    if (!section || section.classList.contains('hidden')) return;
    section.prepend(buildTabSuggestion(tour));
}

/** 本体チャンクが受ける、入口用のイベント処理。 */
export function handleEntryEvent(name: GuideEventName): Promise<void> {
    if (name === 'project-screen-shown') return showSuggestionBanner();
    if (name === 'picker-guidance-shown') return addPickerTourButton();
    if (name in TAB_SECTION_IDS) return showTabSuggestion(name);
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

function buildListItem(tour: TourDefinition): HTMLElement {
    const { id: tourId, titleKey, descriptionKey } = tour;
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

    // 全文の判定ページのツアーは、サイドパネルからは始められない（その画面を開いたときに始める）。
    // 開始ボタンの代わりに、始め方の説明を出す
    if (tour.page === 'fulltext') {
        const hint = document.createElement('div');
        hint.className = 'guide-tour-item-hint';
        hint.dataset.guideTourHint = 'fulltext';
        hint.textContent = t('guideExt_tourOpenFulltextHint');
        item.append(head, description, hint);
        return item;
    }
    const start = createGuideButton('start', t(done ? 'guide_tourAgain' : 'guide_tourStart'),
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
    header.append(title, createGuideButton('close-list', '✕', 'btn btn-outline btn-xsmall', closeGuideTourList));
    panel.append(header);
    for (const tour of availableTours(currentGuidePlatform())) {
        panel.append(buildListItem(tour));
    }
    return panel;
}

function attachListListeners(): void {
    if (listListenersAttached) return;
    listListenersAttached = true;
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${LIST_ID}`)) return;
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

/** ❓ の吹き出しの「操作ツアーの一覧」から、ツアー一覧をその ❓ の近くに開く。同じ ❓ から開き直すと閉じる。 */
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
