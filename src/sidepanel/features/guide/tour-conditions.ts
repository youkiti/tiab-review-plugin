/**
 * ツアーが画面の状態を読む場所。手順の飛ばし判定（skipIf）の値と、プラットフォームの判別をまとめる。
 * 遅延チャンク `guide-feature` に入る。
 */
import { platform } from '../../../platform';
import { state } from '../../state';
import { getState } from '../../store';
import type { GuideConditionValues } from '../../../lib/guide/tour-progress';

/**
 * 拡張版か Web 版か。PlatformAdapter に識別子が無いため、拡張版だけが持つ
 * capabilities.createProject（Web 版はレビュー専用で偽）で代用する。
 */
export function currentGuidePlatform(): { platform: 'extension' | 'web'; capabilities: { createProject: boolean } } {
    const createProject = platform().capabilities.createProject;
    return { platform: createProject ? 'extension' : 'web', capabilities: { createProject } };
}

/** 今の画面の状態から、skipIf の各条件の真偽を作る。 */
export function computeGuideConditions(): GuideConditionValues {
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
