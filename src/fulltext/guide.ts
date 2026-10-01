// guide.ts - 全文の判定ページのツアーの入口（初期バンドルに入る小さな部分）。
//
// ツアーの本体（ランナー・提案の帯・ツアー定義）は動的 import の別チャンク `fulltext-guide`
// （./guide-feature.ts）に入れ、ここには「保存値を見て、提案か再開が要りそうなときだけ本体を読む」判定と、
// 画面側からイベントを投げる関数、「ツアー」ボタンの結線だけを置く。初期バンドルから
// `lib/guide/tours/`・`lib/guide/tour-progress.ts` を値として import しないこと（全ツアーの定義が初期側へ入る）。
// 同じ構成のサイドパネル側の入口は src/sidepanel/features/guide/lazy.ts。

import { createLazyFeatureLoader } from '../lib/lazy-feature-loader';
import { platform } from '../platform';
import type { GuideEventName } from '../lib/guide/tours';

/** 進行状態の保存キー。lib/guide/tour-progress.ts の GUIDE_PROGRESS_STORAGE_KEY と同じ値（tests/guide-tour-fulltext-page.test.ts が一致を検査する） */
const GUIDE_PROGRESS_KEY = 'guide_progress';
/** このページのツアーの ID（lib/guide/tours/fulltext-page.ts の id と同じ値。同じテストが検査する） */
const TOUR_ID = 'fulltext-page';

const loadGuideFeature = createLazyFeatureLoader(
    () => import(/* webpackChunkName: "fulltext-guide" */ './guide-feature'),
);

/**
 * 画面側からツアー用のイベントを投げる。受け取るのは本体チャンク（読み込み前は誰も受けない）。
 * 呼び出し元が状態を変えたあと（次の候補へ移る処理など）の画面を、受け手の条件の計算が見られるよう、
 * 同じ処理の続きが終わってから届ける。
 */
export function emitGuideEvent(name: GuideEventName): void {
    window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('tiab-guide', { detail: name }));
    }, 0);
}

interface StoredProgress {
    active?: { tourId?: unknown } | null;
    suppressSuggestions?: unknown;
    tours?: Record<string, { status?: unknown } | undefined>;
}

function readStoredProgress(): Promise<StoredProgress> {
    return platform().storageGet([GUIDE_PROGRESS_KEY])
        .then(stored => (stored[GUIDE_PROGRESS_KEY] ?? {}) as StoredProgress);
}

/**
 * 本体を読む必要がありそうか（粗い判定。細かい条件は本体の tourToSuggestOnPage が見る）。
 * このツアーが実行中なら再開、何も実行中でなく、このツアーがまだ済・却下でなく、全体で止められていなければ提案。
 */
function mayNeedGuide(saved: StoredProgress): 'resume' | 'suggest' | null {
    if (saved.active) return saved.active.tourId === TOUR_ID ? 'resume' : null;
    if (saved.suppressSuggestions === true) return null;
    return saved.tours?.[TOUR_ID] === undefined ? 'suggest' : null;
}

/**
 * このページを開いたあとに一度呼ぶ。「ツアー」ボタンを結線し、保存値を見て、
 * 実行中なら続きから再開、初めてなら提案の帯を出す。本体を読むのは、そのどちらかが要るときと、ボタンを押したときだけ。
 */
export function setupFulltextGuide(): void {
    document.querySelector<HTMLElement>('[data-guide-action="start-tour"]')?.addEventListener('click', () => {
        loadGuideFeature()
            .then(feature => feature.startFulltextTour())
            .catch(error => console.warn('[fulltext] ツアーの開始に失敗:', error));
    });

    readStoredProgress()
        .then(saved => {
            const need = mayNeedGuide(saved);
            if (!need) return undefined;
            return loadGuideFeature().then(feature => (need === 'resume' ? feature.resumeFulltextGuide() : feature.showFulltextSuggestion()));
        })
        .catch(error => console.warn('[fulltext] ツアーの読み込みに失敗:', error));
}
