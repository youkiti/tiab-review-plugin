/**
 * ツアーが画面の状態を読む場所。手順の飛ばし判定（skipIf）の値と、プラットフォームの判別をまとめる。
 * 共通の条件はここで計算し、ツアー固有の条件は ./conditions/<ツアーID>.ts が計算する。
 * 遅延チャンク `guide-feature` に入る。
 */
import { platform } from '../../../platform';
import { state } from '../../state';
import { getState } from '../../store';
import type { GuideConditionValues } from '../../../lib/guide/tour-progress';
import type { CommonGuideCondition, GuideCondition } from '../../../lib/guide/tours';
import { computeAiFirstRunConditions } from './conditions/ai-first-run';
import { computeAssignmentSetupConditions } from './conditions/assignment-setup';
import { computeDuplicateReviewConditions } from './conditions/duplicate-review';
import { computeFulltextPageConditions } from './conditions/fulltext-page';
import { computeFulltextSetupConditions } from './conditions/fulltext-setup';
import { computeMlStartConditions } from './conditions/ml-start';
import { computeResolveConflictsConditions } from './conditions/resolve-conflicts';
import { computeShareInviteConditions } from './conditions/share-invite';

/**
 * 拡張版か Web 版か。PlatformAdapter に識別子が無いため、拡張版だけが持つ
 * capabilities.createProject（Web 版はレビュー専用で偽）で代用する。
 */
export function currentGuidePlatform(): { platform: 'extension' | 'web'; capabilities: { createProject: boolean } } {
    const createProject = platform().capabilities.createProject;
    return { platform: createProject ? 'extension' : 'web', capabilities: { createProject } };
}

/** ツアー固有の条件の計算。ツアーを足したらここにも1つ足す（first-project・join-project は固有の条件が無い）。 */
const TOUR_CONDITION_SOURCES = [
    computeAssignmentSetupConditions,
    computeShareInviteConditions,
    computeResolveConflictsConditions,
    computeDuplicateReviewConditions,
    computeFulltextSetupConditions,
    computeAiFirstRunConditions,
    computeMlStartConditions,
    computeFulltextPageConditions,
] as const;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
    ? I
    : never;
/** 各ツアーの条件ファイルが返す型を1つに合わせたもの。これと共通の条件で GuideCondition を網羅していないとコンパイルが通らない。 */
type TourConditionValues = UnionToIntersection<ReturnType<(typeof TOUR_CONDITION_SOURCES)[number]>>;

function computeCommonConditions(): Record<CommonGuideCondition, boolean> {
    const onScreening = getState().ui.view === 'screening';
    // 担当セットの欄が出る条件は features/assignment.ts の renderAssignmentFilters と同じ
    const hasAssignmentSets = onScreening
        && state.assignmentConfig.status === 'configured'
        && state.assignmentSets.size > 0;
    return {
        'on-screening-screen': onScreening,
        'has-references': onScreening && state.references.length > 0,
        'has-assignment-sets': hasAssignmentSets,
        'no-assignment-sets': onScreening && !hasAssignmentSets,
        'is-admin': state.isAdmin,
    };
}

/** 今の画面の状態から、skipIf の各条件の真偽を作る。 */
export function computeGuideConditions(): GuideConditionValues {
    const own = {} as TourConditionValues;
    for (const compute of TOUR_CONDITION_SOURCES) Object.assign(own, compute());
    const all: Record<GuideCondition, boolean> = { ...computeCommonConditions(), ...own };
    return all;
}
