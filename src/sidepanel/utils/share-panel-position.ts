export const SHARE_PANEL_MARGIN = 8;

/** 基準位置を保ち、画面端に収まらない分だけ共有パネルを移動・縮小する。 */
export function computeSharePanelPosition(
    left: number,
    width: number,
    viewportWidth: number,
    margin: number = SHARE_PANEL_MARGIN
): { offset: number; width: number } {
    const fittedWidth = Math.min(width, Math.max(0, viewportWidth - margin * 2));
    const fittedLeft = Math.max(margin, Math.min(left, viewportWidth - margin - fittedWidth));
    return { offset: fittedLeft - left, width: fittedWidth };
}
