import { applyFulltextRefUpdate, parseFulltextRefUpdatedMessage } from '../../../lib/fulltext-ref-update';
import { platform } from '../../../platform';
import { state } from '../../state';
import { rerenderFulltextTabIfLoaded } from './lazy';

/** 全文タブを開く前から、判定画面での全文状態の変更を受け取る。 */
export function setupFulltextRefUpdateListener(): void {
    platform().onMessage(message => {
        const update = parseFulltextRefUpdatedMessage(message, state.spreadsheetId);
        if (!update) return;
        const updated = applyFulltextRefUpdate(state.references, update);
        const allUpdated = applyFulltextRefUpdate(state.allReferences, update);
        if (updated || allUpdated) rerenderFulltextTabIfLoaded();
    });
}
