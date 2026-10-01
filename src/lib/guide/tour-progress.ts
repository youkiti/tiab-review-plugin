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
    /** 実行中の手順の位置（steps の添字） */
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
        const index = raw.active.stepIndex;
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < tour.steps.length) {
            result.active = { tourId: tour.id, stepIndex: index };
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

/** このプラットフォーム・権限で提案してよいツアー。管理者向けは createProject が真のときだけ。 */
export function availableTours(context: Pick<GuideSuggestContext, 'platform' | 'capabilities'>): TourDefinition[] {
    return Object.values(GUIDE_TOURS).filter((tour) => {
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

/** ツアーを始める（既に別のツアーが動いていれば置き換える。同時に走るのは1本だけ）。 */
export function startTour(progress: GuideProgress, tourId: GuideTourId, stepIndex = 0): GuideProgress {
    return { ...progress, active: { tourId, stepIndex } };
}

/** 実行中のツアーの手順の位置を更新する。実行中でなければ何もしない。 */
export function setActiveStep(progress: GuideProgress, stepIndex: number): GuideProgress {
    if (!progress.active) return progress;
    return { ...progress, active: { ...progress.active, stepIndex } };
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
