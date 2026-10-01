/**
 * ツアー定義の集約。ツアー1本ごとの定義は同じディレクトリの <ツアーID>.ts にあり、ここでは
 * 型（イベント名・条件名）と GUIDE_TOURS への登録だけを持つ。ツアーを足すときは、自分のツアーのファイル
 * （と、固有のイベント・条件を足すならそのファイルの型）だけを触り、このファイルは触らない
 * （ID の登録は topics.ts の GuideTourId と、このファイルの GUIDE_TOURS の1行ずつ。枠は作成済み）。
 */
import type { GuideTourId } from '../topics';
import { ASSIGNMENT_SETUP_TOUR, type AssignmentSetupCondition, type AssignmentSetupEvent } from './assignment-setup';
import { AI_FIRST_RUN_TOUR, type AiFirstRunCondition, type AiFirstRunEvent } from './ai-first-run';
import { DUPLICATE_REVIEW_TOUR, type DuplicateReviewCondition, type DuplicateReviewEvent } from './duplicate-review';
import { FIRST_PROJECT_TOUR, type FirstProjectCondition, type FirstProjectEvent } from './first-project';
import { FULLTEXT_PAGE_TOUR, type FulltextPageCondition, type FulltextPageEvent } from './fulltext-page';
import { FULLTEXT_SETUP_TOUR, type FulltextSetupCondition, type FulltextSetupEvent } from './fulltext-setup';
import { JOIN_PROJECT_TOUR, type JoinProjectCondition, type JoinProjectEvent } from './join-project';
import { ML_START_TOUR, type MlStartCondition, type MlStartEvent } from './ml-start';
import { RESOLVE_CONFLICTS_TOUR, type ResolveConflictsCondition, type ResolveConflictsEvent } from './resolve-conflicts';
import { SHARE_INVITE_TOUR, type ShareInviteCondition, type ShareInviteEvent } from './share-invite';
import type {
    CommonGuideCondition,
    CommonGuideEventName,
    TourAdvance,
    TourDefinitionOf,
    TourStepOf,
} from './types';

export type { CommonGuideCondition, CommonGuideEventName } from './types';
export { stepKey, tourKeyBase } from './keys';

/** 画面側が投げる、ツアーを進めるためのイベント名。共通のイベント ∪ 各ツアーのファイルが足したイベント。 */
export type GuideEventName =
    | CommonGuideEventName
    | AssignmentSetupEvent
    | ShareInviteEvent
    | ResolveConflictsEvent
    | DuplicateReviewEvent
    | FulltextSetupEvent
    | AiFirstRunEvent
    | MlStartEvent
    | FulltextPageEvent
    | FirstProjectEvent
    | JoinProjectEvent;

/** 手順の飛ばし判定に使う、画面の状態。共通の条件 ∪ 各ツアーのファイルが足した条件。 */
export type GuideCondition =
    | CommonGuideCondition
    | AssignmentSetupCondition
    | ShareInviteCondition
    | ResolveConflictsCondition
    | DuplicateReviewCondition
    | FulltextSetupCondition
    | AiFirstRunCondition
    | MlStartCondition
    | FulltextPageCondition
    | FirstProjectCondition
    | JoinProjectCondition;

export type TourStep = TourStepOf<GuideEventName, GuideCondition>;
export type TourDefinition = TourDefinitionOf<GuideEventName, GuideCondition>;
export type GuideTourAdvance = TourAdvance<GuideEventName>;

export const GUIDE_TOURS: Record<GuideTourId, TourDefinition> = {
    'first-project': FIRST_PROJECT_TOUR,
    'join-project': JOIN_PROJECT_TOUR,
    'assignment-setup': ASSIGNMENT_SETUP_TOUR,
    'share-invite': SHARE_INVITE_TOUR,
    'resolve-conflicts': RESOLVE_CONFLICTS_TOUR,
    'duplicate-review': DUPLICATE_REVIEW_TOUR,
    'fulltext-setup': FULLTEXT_SETUP_TOUR,
    'ai-first-run': AI_FIRST_RUN_TOUR,
    'ml-start': ML_START_TOUR,
    'fulltext-page': FULLTEXT_PAGE_TOUR,
};

export const GUIDE_TOUR_IDS = Object.keys(GUIDE_TOURS) as GuideTourId[];

export function isGuideTourId(value: unknown): value is GuideTourId {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GUIDE_TOURS, value);
}
