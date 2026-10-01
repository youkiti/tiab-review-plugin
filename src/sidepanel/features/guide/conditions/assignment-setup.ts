/**
 * ツアー「assignment-setup」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/assignment-setup.ts の AssignmentSetupCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { AssignmentSetupCondition } from '../../../../lib/guide/tours/assignment-setup';
import { state } from '../../../state';
import { getState } from '../../../store';

/** 担当セットのウィザード（features/assignment.ts が #modal-backdrop に描く）が開いているか。 */
function isWizardOpen(): boolean {
    return document.querySelector('#modal-backdrop:not(.hidden) .assignment-wizard') !== null;
}

export function computeAssignmentSetupConditions(): Record<AssignmentSetupCondition, boolean> {
    const onSettings = getState().ui.view === 'settings';
    const configured = state.assignmentConfig.status === 'configured';
    const wizardOpen = isWizardOpen();
    return {
        'settings-screen-or-wizard-open': onSettings || wizardOpen,
        'wizard-open-or-configured': wizardOpen || configured,
        'wizard-closed': !wizardOpen,
        'settings-screen-or-unconfigured': onSettings || !configured,
        'assignment-unconfigured': !configured,
    };
}
