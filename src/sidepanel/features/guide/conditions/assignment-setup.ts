/**
 * ツアー「assignment-setup」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/assignment-setup.ts の AssignmentSetupCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { AssignmentSetupCondition } from '../../../../lib/guide/tours/assignment-setup';

export function computeAssignmentSetupConditions(): Record<AssignmentSetupCondition, boolean> {
    return {};
}
