/**
 * ツアー「resolve-conflicts」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/resolve-conflicts.ts の ResolveConflictsCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { ResolveConflictsCondition } from '../../../../lib/guide/tours/resolve-conflicts';
import { dom } from '../../../dom';
import { state } from '../../../state';

/** 要素が画面にあり、`hidden` クラスが付いていない */
function isShown(element: HTMLElement | null): boolean {
    return element !== null && !element.classList.contains('hidden');
}

export function computeResolveConflictsConditions(): Record<ResolveConflictsCondition, boolean> {
    const keyOpened = state.isKeyOpened;
    return {
        'not-admin': !state.isAdmin,
        'key-opened': keyOpened,
        'key-closed': !keyOpened,
        // バナー・他の人の判定の一覧は、描画（features/screening/render.ts）がキー開封後にだけ出す
        'conflict-banner-shown-or-blind': !keyOpened || isShown(dom.conflictBanner),
        'no-other-decisions-shown': !keyOpened || !isShown(dom.allDecisionsDiv),
    };
}
