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

/**
 * 実体化対象のページ集合を、canvas 合計バイト数の上限で絞り込む（Issue #156（#150 工程5）PR3）。
 *
 * PR2 で「可視ページ ± PAGE_MATERIALIZE_WINDOW」だけ実体化するようになったが、可視ページ集合
 * 自体の大きさには上限が無かった。ウィンドウが縦に長い・表示倍率が小さいなどで多数のページが
 * 同時に IntersectionObserver に交差すると、実体化対象の集合はいくらでも大きくなり、canvas 枚数
 * （＝メモリ）もそれに比例して増え続けてしまう。この関数はその安全弁で、`target` を
 * 「最も近い可視ページからの距離」の昇順（同距離ならページ番号昇順。結果を決定的にするため）に
 * 並べ、`bytesOf` で見積もった合計が `maxBytes` を超える手前で打ち切る。
 *
 * ただし `minPages` 件までは、バイト数に関わらず必ず採用する。これが無いと、上限値の選び方
 * 次第では通常の ±1 ウィンドウ（可視1ページなら3枚）すら維持できず、PR2 の機能そのものを
 * 壊しかねない。上限はあくまで「異常に多数のページが同時可視になったとき」を縛る安全弁で、
 * 通常動作を削るものではない、という位置づけのため。
 *
 * @param target 実体化候補のページ集合（computeTargetPages() の戻り値を想定）
 * @param visiblePages 現在ビューポートに交差しているページ番号（距離の基準点。空でもよい）
 * @param bytesOf ページ番号 → 推定 canvas バイト数（width * height * 4 相当）を返す関数
 * @param maxBytes 採用する合計バイト数の上限
 * @param minPages バイト数に関わらず必ず採用する最小件数（近い順に優先）
 */
export function capTargetPagesByBytes(
    target: ReadonlySet<number>,
    visiblePages: readonly number[],
    bytesOf: (pageNumber: number) => number,
    maxBytes: number,
    minPages: number
): Set<number> {
    // visiblePages が空（＝距離の基準点が無い）なら、target 側も通常は空のはず
    // （computeTargetPages() は可視ページを起点にしか候補を作らないため）。呼び出し側の
    // 前提が崩れていた場合でも安全側に倒し、距離を測れない以上は絞り込まずそのまま返す。
    if (visiblePages.length === 0) return new Set(target);

    const distanceOf = (page: number): number =>
        Math.min(...visiblePages.map(v => Math.abs(v - page)));

    const ordered = [...target].sort((a, b) => {
        const d = distanceOf(a) - distanceOf(b);
        return d !== 0 ? d : a - b; // 同距離はページ番号昇順（決定的にするため）
    });

    const result = new Set<number>();
    let bytes = 0;
    for (const page of ordered) {
        if (result.size < minPages) {
            // 最小保証件数までは、バイト数の集計に関わらず必ず採用する。
            result.add(page);
            bytes += bytesOf(page);
            continue;
        }
        const pageBytes = bytesOf(page);
        if (bytes + pageBytes > maxBytes) break; // 以降は距離がより遠いだけなので打ち切ってよい
        result.add(page);
        bytes += pageBytes;
    }
    return result;
}
