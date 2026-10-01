/**
 * ツアー「assignment-setup」固有の条件（手順の skipIf・unavailableIf）の計算。
 * 条件名は src/lib/guide/tours/assignment-setup.ts の AssignmentSetupCondition に足し、真偽の計算は同じファイルの
 * 純関数 assignmentSetupConditions に書く（ここは画面の状態を読んで渡すだけ）。遅延チャンク `guide-feature` に入る。
 */
import { assignmentSetupConditions } from '../../../../lib/guide/tours/assignment-setup';
import type { AssignmentSetupCondition } from '../../../../lib/guide/tours/assignment-setup';
import { state } from '../../../state';
import { getState } from '../../../store';

/** 担当セットのウィザード（features/assignment.ts が #modal-backdrop に描く）が開いているか。 */
function isWizardOpen(): boolean {
    return document.querySelector('#modal-backdrop:not(.hidden) .assignment-wizard') !== null;
}

export function computeAssignmentSetupConditions(): Record<AssignmentSetupCondition, boolean> {
    const ui = getState().ui;
    return assignmentSetupConditions({
        view: ui.view,
        currentTab: ui.currentTab,
        spreadsheetId: state.spreadsheetId || '',
        isAdmin: state.isAdmin,
        configured: state.assignmentConfig.status === 'configured',
        assignmentSetCount: state.assignmentSets.size,
        wizardOpen: isWizardOpen(),
    });
}
