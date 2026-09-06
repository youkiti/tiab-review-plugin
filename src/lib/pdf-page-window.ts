// pdf-page-window.ts - PDFページの「どのページを描画/解放すべきか」を決める純関数（Issue #156）
//
// 長いPDFで全ページを一括描画すると canvas 数とメモリがページ数に比例して増え続ける
// （PR #180 で分割した後も pdf-renderer.ts が抱えていた課題）。この関数は
// 「表示範囲中心の描画」の意思決定だけを DOM から切り離して持つ。IntersectionObserver の
// コールバックや scrollToPage() 等から呼ばれ、実際の canvas 生成・破棄は呼び出し側
// （pdf-renderer.ts）が行う。
//
// 優先度モデル: 先頭ページ（page 1）と現在表示中のページを最優先（優先度0）とし、それ以外は
// 最も近い表示中ページとの距離を優先度とする（小さいほど優先）。描画済み総数の上限
// （maxRenderedPages）を超える場合は、優先度が低い（＝遠い）ページから「保持しない」側へ回す。
// 既に描画済みでも保持対象から外れたページは toRelease に入る（cap 到達によって、表示範囲の
// すぐ外側のページが解放されることもある）。

export interface PdfPageWindowInput {
    /** PDFの総ページ数（1始まりの範囲で扱う） */
    numPages: number;
    /** 現在ビューポートに交差しているページ番号（1始まり、順不同・重複可） */
    visiblePages: number[];
    /** 表示中ページの前後、追加で保持したいページ数（0以上） */
    radius: number;
    /** 現在描画済み（canvasが存在する）ページ番号 */
    renderedPages: number[];
    /** 同時に描画済みとして保持してよいページ数の上限 */
    maxRenderedPages: number;
}

export interface PdfPageWindowPlan {
    /** 新たに描画すべきページ（優先度が高い順） */
    toRender: number[];
    /** 描画を解放すべきページ（昇順） */
    toRelease: number[];
}

/**
 * 表示範囲・先頭ページ・上限から、次に描画すべきページと解放すべきページを決める。
 * DOM・pdf.js に一切依存しない純関数。
 */
export function planPdfPageWindow(input: PdfPageWindowInput): PdfPageWindowPlan {
    const { numPages } = input;
    if (!Number.isFinite(numPages) || numPages <= 0) {
        return { toRender: [], toRelease: [] };
    }

    const clamp = (n: number): number => Math.min(Math.max(n, 1), numPages);
    const radius = Math.max(0, Math.floor(input.radius));
    const maxRendered = Math.max(1, Math.floor(input.maxRenderedPages));

    const visible = Array.from(
        new Set(input.visiblePages.filter(p => Number.isFinite(p) && p >= 1 && p <= numPages))
    );
    const visibleSet = new Set(visible);
    const rendered = new Set(
        input.renderedPages.filter(p => Number.isFinite(p) && p >= 1 && p <= numPages)
    );

    // 望ましいウィンドウ = 先頭ページ ∪ 表示中ページ ∪ その前後radius
    const desired = new Set<number>([1]);
    for (const v of visible) {
        for (let p = clamp(v - radius); p <= clamp(v + radius); p++) {
            desired.add(p);
        }
    }

    // 優先度（小さいほど優先）: 先頭ページ・表示中ページ = 0、それ以外は最寄りの表示中ページとの距離。
    // 表示中ページが1件も無い場合（Observerがまだ何も報告していない初期状態等）は、
    // 先頭ページ以外の優先度はすべて等しく扱う（同着はページ番号昇順で決着する）。
    const priorityOf = (page: number): number => {
        if (page === 1 || visibleSet.has(page)) return 0;
        if (visible.length === 0) return 1;
        let min = Infinity;
        for (const v of visible) {
            const d = Math.abs(page - v);
            if (d < min) min = d;
        }
        return min;
    };

    const desiredList = Array.from(desired).sort((a, b) => {
        const diff = priorityOf(a) - priorityOf(b);
        return diff !== 0 ? diff : a - b;
    });

    // 上限を超える分は、優先度が低い（遠い）ページから保持対象外にする。
    const keep = new Set(desiredList.slice(0, maxRendered));

    // toRender は「保持すべきだがまだ描画されていない」もの。desiredList の優先度順を維持する
    // （表示中に近いページから先に描画されるよう、呼び出し側がそのまま順に処理できる）。
    const toRender = desiredList.filter(p => keep.has(p) && !rendered.has(p));

    // toRelease は「描画済みだが、もう保持対象ではない」もの（望ましいウィンドウの外、または
    // 上限超過で優先度trimされたもの）。
    const toRelease = Array.from(rendered)
        .filter(p => !keep.has(p))
        .sort((a, b) => a - b);

    return { toRender, toRelease };
}
