/**
 * フルテキスト担当セットフィルタの選択状態の読み込み・初期化。
 *
 * project.ts の loadDataAndShowScreening から、プロジェクト読み込み時に state.fulltextAssignment
 * 設定後に必ず実行される（担当セットのチェックボックス絞り込みは TiAb 側の絞り込みでも使う）ため、
 * フルテキストタブ本体（features/fulltext/**、Issue #155（#150 工程4）で遅延読み込み化）とは
 * 独立した軽量モジュールに切り出している。ウィザードでの割り振り作成・編集・状態行の描画は
 * features/fulltext/assignment-ui.ts が担う。
 */

import { state } from '../state';
import { platform } from '../../platform';
import { setSelectedFulltextSets as storeSetSelectedFulltextSets } from '../store/compat';
import { initialSelectedFulltextSets, normalizeStoredFulltextSets } from '../../lib/fulltext-assignment';

/** selectedFulltextSets の永続化キー。値は { [spreadsheetId]: string[] }（プロジェクトごとに保持） */
export const FULLTEXT_ASSIGNMENT_STORAGE_KEY = 'selectedFulltextSets';

/**
 * 担当セットフィルタの選択状態を初期化する（保存値の読み込み＋正規化、無ければ初期選択）。
 * project.ts の loadDataAndShowScreening から、state.fulltextAssignment 設定後に呼ぶ。
 */
export async function initializeFulltextAssignmentSelection(spreadsheetId: string, userEmail: string): Promise<void> {
    const config = state.fulltextAssignment;
    let selected = initialSelectedFulltextSets(config, userEmail);
    try {
        const stored = await platform().storageGet([FULLTEXT_ASSIGNMENT_STORAGE_KEY]);
        const map = stored[FULLTEXT_ASSIGNMENT_STORAGE_KEY] as Record<string, string[]> | undefined;
        const storedForProject = map?.[spreadsheetId];
        if (storedForProject) {
            selected = normalizeStoredFulltextSets(storedForProject, config, userEmail);
        }
    } catch (error) {
        console.warn('[ftAssign] 選択状態の読み込みに失敗:', error);
    }
    storeSetSelectedFulltextSets(selected);
}
