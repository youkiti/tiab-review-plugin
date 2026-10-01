/**
 * ツアー「duplicate-review」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/duplicate-review.ts の DuplicateReviewCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 *
 * 重複の確認の本体（features/duplicate-review.ts）は guide/lazy の emitGuideEvent を import しており、
 * lazy は本体チャンク（このファイルを含む）を動的 import する。ここから重複の確認の本体を import すると
 * 循環になるため、DOM の印（data-tour・data-pending）だけを読む。
 */
import { getState } from '../../../store';
import type { DuplicateReviewCondition } from '../../../../lib/guide/tours/duplicate-review';

/** セクションが持つ未確認件数。まだ読み込み中・失敗のときと、セクションが無いときは null。 */
function pendingCount(): number | null {
    const raw = document.querySelector<HTMLElement>('[data-tour="duplicate-section"]')?.dataset.pending;
    if (raw === undefined || raw === '') return null;
    const count = Number(raw);
    return Number.isFinite(count) ? count : null;
}

/** 表示中の要素があるか（ダイアログが閉じていれば、中の要素は表示中に数えない） */
function hasVisible(target: string): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`))
        .some(element => element.getClientRects().length > 0);
}

export function computeDuplicateReviewConditions(): Record<DuplicateReviewCondition, boolean> {
    const { ui } = getState();
    const none = pendingCount() === 0;
    return {
        'duplicate-manual-tab-open': ui.view === 'screening' && ui.currentTab === 'screening',
        'no-duplicate-candidates': none,
        'duplicate-candidates-present': !none,
        'duplicate-modal-closed': !hasVisible('duplicate-bulk'),
        'duplicate-no-hint-needed': none
            || document.querySelector<HTMLElement>('[data-tour="duplicate-section"]')?.dataset.reviewOpened === '1',
    };
}
