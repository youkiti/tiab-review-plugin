import { GUIDE_TOURS, isGuideTourId } from './tours';
import type { GuideCondition, GuideEventName, TourDefinition, TourStep } from './tours';
import type { GuideTourId } from './topics';

/**
 * ツアーの進行状態。保存・読み込みそのもの（platform の storageGet/storageSet）は呼び出し側が行い、
 * このモジュールは検証・直列化・状態遷移の純関数だけを持つ。
 */
export const GUIDE_PROGRESS_STORAGE_KEY = 'guide_progress';

export interface GuideTourRecord {
    status: 'done' | 'dismissed';
    /** ISO 8601 の日時 */
    at: string;
}

export interface GuideActiveTour {
    tourId: GuideTourId;
    /** 実行中の手順の ID。保存・再開の正本（手順を足す・並べ替えても再開位置がずれない） */
    stepId: string;
    /** 実行中の手順の位置（steps の添字）。読み込み時に stepId から今の定義に合わせて求め直す */
    stepIndex: number;
}

export interface GuideProgress {
    tours: Partial<Record<GuideTourId, GuideTourRecord>>;
    active: GuideActiveTour | null;
    /** 自動提案を「今後表示しない」にしたか */
    suppressSuggestions: boolean;
}

/** 呼び出し側が画面の状態から作る条件の値。Record でも Set でもよい（無いキーは偽）。 */
export type GuideConditionValues = Readonly<Partial<Record<GuideCondition, boolean>>> | ReadonlySet<GuideCondition>;

export function createEmptyGuideProgress(): GuideProgress {
    return { tours: {}, active: null, suppressSuggestions: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 不明な値から検証済みの進行状態を作る。壊れた値・未知のキーは読み飛ばして既定値に戻す。 */
export function parseGuideProgress(raw: unknown): GuideProgress {
    const result = createEmptyGuideProgress();
    if (!isRecord(raw)) return result;

    if (isRecord(raw.tours)) {
        for (const [key, value] of Object.entries(raw.tours)) {
            if (!isGuideTourId(key) || !isRecord(value)) continue;
            if (value.status !== 'done' && value.status !== 'dismissed') continue;
            if (typeof value.at !== 'string') continue;
            result.tours[key] = { status: value.status, at: value.at };
        }
    }

    if (isRecord(raw.active) && isGuideTourId(raw.active.tourId)) {
        const tour = GUIDE_TOURS[raw.active.tourId];
        const savedId = raw.active.stepId;
        const index = raw.active.stepIndex;
        if (typeof savedId === 'string') {
            // 手順の ID を優先する。保存時の添字と食い違っていても、今の定義での位置に解決する。
            // 実在しない ID（手順が削除・改名された）は再開しない
            const found = tour.steps.findIndex(step => step.id === savedId);
            if (found >= 0) result.active = { tourId: tour.id, stepId: savedId, stepIndex: found };
        } else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < tour.steps.length) {
            // stepId を持たない旧版の保存値は添字しか情報が無い。手順の挿入などでずれている可能性は
            // ここでは直せない（PR #220 レビュー指摘: 手順を挿入すると保存済みの再開位置がずれる点）。
            result.active = { tourId: tour.id, stepId: tour.steps[index].id, stepIndex: index };
        }
    }

    result.suppressSuggestions = raw.suppressSuggestions === true;
    return result;
}

/** 保存する値（JSON にできるプレーンなオブジェクト）。 */
export function serializeGuideProgress(progress: GuideProgress): GuideProgress {
    return {
        tours: { ...progress.tours },
        active: progress.active ? { ...progress.active } : null,
        suppressSuggestions: progress.suppressSuggestions,
    };
}

function isConditionTrue(conditions: GuideConditionValues, condition: GuideCondition): boolean {
    if (conditions instanceof Set) return conditions.has(condition);
    return (conditions as Partial<Record<GuideCondition, boolean>>)[condition] === true;
}

/**
 * fromIndex 以降で、skipIf を満たさない最初の手順の位置を返す。全部飛ばす／最後を過ぎたら null（終了）。
 * 開始時は 0、手順を終えたあとは「今の位置 + 1」を渡す。
 */
export function nextStepIndex(
    tour: Pick<TourDefinition, 'steps'>,
    fromIndex: number,
    conditions: GuideConditionValues,
): number | null {
    for (let i = Math.max(0, fromIndex); i < tour.steps.length; i += 1) {
        const skipIf = tour.steps[i].skipIf;
        if (skipIf === undefined || !isConditionTrue(conditions, skipIf)) return i;
    }
    return null;
}

/** イベントでこの手順が進むか。'next' で進む手順はイベントでは進まない。 */
export function shouldAdvance(step: Pick<TourStep, 'advance'>, event: GuideEventName): boolean {
    return step.advance.type === 'events' && step.advance.events.includes(event);
}

export interface GuideSuggestContext {
    /** 今表示している画面。自動提案はプロジェクト選択画面でだけ出す */
    screen: 'project' | 'screening' | 'other';
    platform: 'extension' | 'web';
    capabilities: { createProject: boolean };
    /** このセッションで「あとで」を押したか（保存しない） */
    postponedThisSession?: boolean;
}

/**
 * このプラットフォーム・権限で提案してよいツアー。管理者向けは createProject が真のときだけ。
 * まだ中身の無い枠（draft）は含めない。一覧・提案・開始・テストの照合の対象はすべてこの関数を通る。
 */
export function availableTours(
    context: Pick<GuideSuggestContext, 'platform' | 'capabilities'>,
    tours: ReadonlyArray<TourDefinition> = Object.values(GUIDE_TOURS),
): TourDefinition[] {
    return tours.filter((tour) => {
        if (tour.draft) return false;
        if (!tour.platforms.includes(context.platform)) return false;
        if (tour.audience === 'admin' && !context.capabilities.createProject) return false;
        return true;
    });
}

/** 自動提案を出すか。使えるツアーのどれも済・却下でなく、実行中でもなく、止められても延期されてもいないとき。 */
export function shouldSuggest(progress: GuideProgress, context: GuideSuggestContext): boolean {
    if (context.screen !== 'project') return false;
    if (progress.suppressSuggestions || context.postponedThisSession) return false;
    if (progress.active) return false;
    const tours = availableTours(context);
    if (tours.length === 0) return false;
    return tours.every((tour) => progress.tours[tour.id] === undefined);
}

/**
 * タブ・画面に入ったことを知らせるイベントで、提案の帯に出すツアー（無ければ null）。
 * suggestOn がそのイベントに一致する使えるツアーのうち、まだ済・却下でなく、ほかのツアーが実行中でなく、
 * 全体の「今後表示しない」でないときだけ返す。candidates を渡すと、その中から選ぶ（テスト用。省略時は availableTours）。
 */
export function tourToSuggestOnEvent(
    progress: GuideProgress,
    event: GuideEventName,
    context: Pick<GuideSuggestContext, 'platform' | 'capabilities'>,
    tours: ReadonlyArray<TourDefinition> = Object.values(GUIDE_TOURS),
): TourDefinition | null {
    if (progress.suppressSuggestions || progress.active) return null;
    return availableTours(context, tours).find(tour => tour.suggestOn === event && progress.tours[tour.id] === undefined) ?? null;
}

/**
 * 別の画面（全文の判定ページ）を初めて開いたときに、その画面の上部の提案の帯に出すツアー（無ければ null）。
 * page が一致する使えるツアーのうち、まだ済・却下でなく、ほかのツアーが実行中でなく、
 * 全体の「今後表示しない」でないときだけ返す。tours を渡すと、その中から選ぶ（テスト用。省略時は GUIDE_TOURS）。
 */
export function tourToSuggestOnPage(
    progress: GuideProgress,
    page: TourDefinition['page'],
    context: Pick<GuideSuggestContext, 'platform' | 'capabilities'>,
    tours: ReadonlyArray<TourDefinition> = Object.values(GUIDE_TOURS),
): TourDefinition | null {
    if (progress.suppressSuggestions || progress.active) return null;
    return availableTours(context, tours).find(tour => tour.page === page && progress.tours[tour.id] === undefined) ?? null;
}

function stepIdAt(tourId: GuideTourId, stepIndex: number): string {
    return GUIDE_TOURS[tourId].steps[stepIndex]?.id ?? '';
}

/** ツアーを始める（既に別のツアーが動いていれば置き換える。同時に走るのは1本だけ）。 */
export function startTour(progress: GuideProgress, tourId: GuideTourId, stepIndex = 0): GuideProgress {
    return { ...progress, active: { tourId, stepId: stepIdAt(tourId, stepIndex), stepIndex } };
}

/** 実行中のツアーの手順の位置を更新する。実行中でなければ何もしない。 */
export function setActiveStep(progress: GuideProgress, stepIndex: number): GuideProgress {
    if (!progress.active) return progress;
    return { ...progress, active: { ...progress.active, stepId: stepIdAt(progress.active.tourId, stepIndex), stepIndex } };
}

function endTour(
    progress: GuideProgress,
    tourId: GuideTourId,
    status: GuideTourRecord['status'],
    nowIso: string,
): GuideProgress {
    const active = progress.active && progress.active.tourId === tourId ? null : progress.active;
    return { ...progress, tours: { ...progress.tours, [tourId]: { status, at: nowIso } }, active };
}

/** 最後まで行った。 */
export function completeTour(progress: GuideProgress, tourId: GuideTourId, nowIso: string): GuideProgress {
    return endTour(progress, tourId, 'done', nowIso);
}

/** 「ツアーを終える」で途中で止めた。 */
export function dismissTour(progress: GuideProgress, tourId: GuideTourId, nowIso: string): GuideProgress {
    return endTour(progress, tourId, 'dismissed', nowIso);
}

/** 自動提案を「今後表示しない」にする。 */
export function suppressSuggestions(progress: GuideProgress): GuideProgress {
    return { ...progress, suppressSuggestions: true };
}
