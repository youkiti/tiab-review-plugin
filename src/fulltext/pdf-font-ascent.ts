// pdf-font-ascent.ts - pdf.js の文字層と同じ方法でフォントの ascent 比を計測する。
//
// ハイライト矩形の位置を文字層の span に合わせるために利用する。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Issue #272: 文字層の span は上端を「ベースライン − 文字高 × ascent 比」に置く（pdf.js TextLayer の
// #appendText / #getAscent）。以前は「ベースライン − 文字高」で計算していたため、帯が文字より
// 文字高 ×（1 − ascent 比）だけ上にずれ、下の縁が取り消し線のように見えていた。
// 索引は文字層の DOM と切り離して全ページ分を先に作るので、span の位置は読めない。pdf.js と同じ
// canvas の計測で ascent 比を出す。pdf.js 側の関数は private（#getAscent）で呼べない。
export const DEFAULT_FONT_ASCENT = 0.8; // pdf.js の既定値と同じ
const ASCENT_MEASURE_FONT_SIZE = 30; // pdf.js の DEFAULT_FONT_SIZE と同じ
const ascentRatioCache = new Map<string, number>();
let ascentMeasureCtx: CanvasRenderingContext2D | null | undefined;

/** フォントの ascent 比（ascent /（ascent + descent））。計測できなければ pdf.js の既定値 0.8 */
export function fontAscentRatio(fontFamily: string | undefined, lang: string | null): number {
    if (!fontFamily) return DEFAULT_FONT_ASCENT;
    // pdf.js は Windows の Firefox で sans-serif / monospace を置き換える（TextLayer.fontFamilyMap）
    const family = (pdfjsLib.TextLayer as any)?.fontFamilyMap?.get?.(fontFamily) || fontFamily;
    const key = `${lang ?? ''}\u0000${family}`;
    const cached = ascentRatioCache.get(key);
    if (cached !== undefined) return cached;

    let ratio = DEFAULT_FONT_ASCENT;
    try {
        if (ascentMeasureCtx === undefined) {
            ascentMeasureCtx = typeof document !== 'undefined'
                ? document.createElement('canvas').getContext('2d')
                : null;
        }
        const ctx = ascentMeasureCtx;
        if (ctx) {
            // pdf.js は lang ごとに canvas を分けている。lang でフォントの解決が変わりうるため合わせる。
            ctx.canvas.lang = lang ?? '';
            ctx.font = `${ASCENT_MEASURE_FONT_SIZE}px ${family}`;
            const metrics = ctx.measureText('');
            const ascent = metrics.fontBoundingBoxAscent;
            const descent = Math.abs(metrics.fontBoundingBoxDescent);
            if (ascent) ratio = ascent / (ascent + descent);
        }
    } catch {
        ratio = DEFAULT_FONT_ASCENT;
    }
    ascentRatioCache.set(key, ratio);
    return ratio;
}
