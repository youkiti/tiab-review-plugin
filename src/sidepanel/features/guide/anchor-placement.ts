/** 吹き出し・一覧パネルを、起点のボタンの近くに置く共通処理。 */

export const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

/** ボタンの近くに置き、サイドパネルの幅（左右）と高さ（下端）からはみ出さないよう寄せる。 */
export function placeNear(element: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft);
    let top = rect.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
        top = Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - height);
    }
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
}
