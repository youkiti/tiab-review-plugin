import { createLazyFeatureLoader } from '../../../lib/lazy-feature-loader';
import { platform } from '../../../platform';
import { reportFeatureLoadError } from '../../ui/lazy-feature-feedback';
import type { GuideEventName } from '../../../lib/guide/tours';

// 本体の読み込みに失敗したときの退避先。対応表（lib/guide/topics.ts）は本体チャンクにだけ
// 入れるため、ここではヘルプのトップ URL を直接持つ。
const HELP_TOP_URL = 'https://youkiti.github.io/tiab-review-plugin/help.html';

// 進行状態の保存キー。lib/guide/tour-progress.ts の GUIDE_PROGRESS_STORAGE_KEY と同じ値
// （tests/guide-tours.test.ts が一致を検査する）。tour-progress.ts を初期バンドルに入れないため、値だけここに持つ。
const GUIDE_PROGRESS_KEY = 'guide_progress';

type GuideFeature = typeof import('./index');

/** 「?」の吹き出し・ツアーの本体は初回に必要になったときに読み込む（初期バンドルを増やさない）。 */
const loadGuideFeature = createLazyFeatureLoader(
    () => import(/* webpackChunkName: "guide-feature" */ './index'),
);

let guideReady = false;

/** 本体を読み込み、初期化（冪等）してから処理を渡す。 */
function withGuide(run: (feature: GuideFeature) => unknown): Promise<unknown> {
    return loadGuideFeature().then(feature => {
        feature.initGuide();
        guideReady = true;
        return run(feature);
    });
}

/** 画面側からツアー用のイベントを投げる。受け取るのは本体チャンク（読み込み前は下の判定だけ）。 */
export function emitGuideEvent(name: GuideEventName): void {
    document.dispatchEvent(new CustomEvent('tiab-guide', { detail: name }));
}

interface StoredProgress {
    active?: unknown;
    suppressSuggestions?: unknown;
    tours?: Record<string, { status?: unknown } | undefined>;
}

function readStoredProgress(): Promise<StoredProgress> {
    return platform().storageGet([GUIDE_PROGRESS_KEY]).then(stored => (stored[GUIDE_PROGRESS_KEY] ?? {}) as StoredProgress);
}

/** 本体が入口で受けるイベントか（プロジェクト選択画面・Picker 案内・タブを開いた）。 */
function isEntryEvent(name: GuideEventName): boolean {
    return name === 'project-screen-shown' || name === 'picker-guidance-shown' || name.startsWith('tab-opened-');
}

/**
 * タブを開いたイベントごとに、提案しうるツアーの ID。値だけを持つ（tours/ を初期バンドルに入れないため）。
 * ツアー定義の suggestOn と一致させる（tests/guide-tours.test.ts が照合する）。
 * 対応するツアーが無いイベント（tab-opened-screening）では、本体を読まない。
 */
const SUGGEST_TOUR_BY_EVENT: Partial<Record<GuideEventName, string>> = {
    'tab-opened-fulltext': 'fulltext-setup',
    'tab-opened-llm': 'ai-first-run',
    'tab-opened-ml': 'ml-start',
};

/** 粗い判定だけ行う（細かい条件は本体の shouldSuggest・tourToSuggestOnEvent が見る）。 */
function mayNeedGuide(name: GuideEventName, saved: StoredProgress): boolean {
    if (saved.active) return true;
    if (name === 'picker-guidance-shown') return saved.tours?.['join-project']?.status !== 'done';
    if (saved.suppressSuggestions === true) return false;
    if (name.startsWith('tab-opened-')) {
        // 対応するツアーがまだ済・却下でないときだけ、本体（細かい条件を見る）を読む
        const tourId = SUGGEST_TOUR_BY_EVENT[name];
        const status = tourId ? saved.tours?.[tourId]?.status : undefined;
        return tourId !== undefined && status !== 'done' && status !== 'dismissed';
    }
    return Object.keys(saved.tours ?? {}).length === 0;
}

/**
 * `[data-help]` 要素（「?」ボタン）のクリックを document で一括して拾う。
 * チーム進捗のヘッダーのように、内側で伝播を止める既存ハンドラの中に置いた「?」でも
 * 拾えるよう、キャプチャ段階で受け取る。
 */
export function setupGuideListeners(): void {
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLElement>('[data-help]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        withGuide(feature => feature.toggleGuidePopover(button))
            .catch(error => {
                reportFeatureLoadError(error, 'guide');
                platform().openExternal(HELP_TOP_URL);
            });
    }, true);

    // 自動提案の要否は、保存値の粗い判定を通ったときだけ本体を読んで確かめる
    document.addEventListener('tiab-guide', event => {
        if (guideReady) return;
        const name = (event as CustomEvent<GuideEventName>).detail;
        if (!isEntryEvent(name)) return;
        readStoredProgress()
            .then(saved => (mayNeedGuide(name, saved)
                ? withGuide(feature => feature.handleGuideEvent(name))
                : undefined))
            .catch(console.warn);
    });

    // 実行中のツアーがあれば、パネルを開き直したときに続きから再開する
    readStoredProgress()
        .then(saved => (saved.active ? withGuide(feature => feature.resumeGuide()) : undefined))
        .catch(console.warn);
}
