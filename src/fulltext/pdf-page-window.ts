// pdf-page-window.ts - 表示範囲まわりの実体化ページ集合を求める純粋関数群（Issue #156（#150 工程5）PR2）
//
// pdf.js / DOM に依存しないため単体テスト可能。pdf-renderer.ts の IntersectionObserver ハンドラから
// 呼び出し、「今どのページに canvas / DOM テキストレイヤーを持たせるべきか」を決める。

/**
 * 可視ページ集合 ＋ 前後ウィンドウ幅 ＋ 総ページ数 から、実体化すべきページ番号の集合を求める。
 * 可視ページごとに前後 windowSize 分を加え、1〜totalPages の範囲外は切り捨てる。
 * @param visiblePages 現在ビューポートに交差しているページ番号（重複・順不同で構わない）
 * @param windowSize 可視ページの前後何ページまで実体化するか
 * @param totalPages PDFの総ページ数
 */
export function computeTargetPages(
    visiblePages: readonly number[],
    windowSize: number,
    totalPages: number
): Set<number> {
    const target = new Set<number>();
    if (totalPages <= 0) return target;
    for (const p of visiblePages) {
        for (let n = p - windowSize; n <= p + windowSize; n++) {
            if (n >= 1 && n <= totalPages) target.add(n);
        }
    }
    return target;
}

/**
 * 現在実体化しているページ集合 ＋ 実体化すべき集合 から、新たに実体化する集合と解放する集合を求める。
 * 戻り値はどちらもページ番号昇順（呼び出し側の処理順序を安定させるため）。
 */
export function diffMaterialization(
    current: ReadonlySet<number>,
    target: ReadonlySet<number>
): { toMaterialize: number[]; toRelease: number[] } {
    const toMaterialize: number[] = [];
    const toRelease: number[] = [];
    for (const p of target) {
        if (!current.has(p)) toMaterialize.push(p);
    }
    for (const p of current) {
        if (!target.has(p)) toRelease.push(p);
    }
    toMaterialize.sort((a, b) => a - b);
    toRelease.sort((a, b) => a - b);
    return { toMaterialize, toRelease };
}

/** canvas バイト数の集計（各 canvas の width * height * 4 の合計）。 */
export function sumCanvasBytes(dims: readonly { width: number; height: number }[]): number {
    return dims.reduce((sum, d) => sum + d.width * d.height * 4, 0);
}
