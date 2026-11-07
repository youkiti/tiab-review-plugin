// pdf-text-index.ts - 全文 PDF のテキスト索引を構築する。
//
// quote 検索用の rawText・charItemIndex・itemRects を作る関数。pdf-renderer.ts から切り出した。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { type Rect } from './pdf-text-match';
import { DEFAULT_FONT_ASCENT, fontAscentRatio } from './pdf-font-ascent';

// ---------------------------------------------------------------------------
// テキストインデックス構築 / マッチング（モジュール関数: 単体テスト容易化のため外出し）
// ---------------------------------------------------------------------------

/**
 * テキストアイテム配列から、マッチ用の生テキスト・文字→アイテム対応・アイテム矩形を構築する。
 * 矩形は pdf.js の text layer と同じ式（Util.transform）でビューポート座標へ変換する。
 */
export function buildTextIndex(
    items: any[],
    viewport: any,
    styles?: Record<string, any>,
    lang?: string | null
): { rawText: string; charItemIndex: number[]; itemRects: Rect[] } {
    let rawText = '';
    const charItemIndex: number[] = [];
    const itemRects: Rect[] = [];

    items.forEach((item, idx) => {
        // マーク（hasEOL のみで str を持たない要素）は矩形なしで扱う
        const str: string = typeof item.str === 'string' ? item.str : '';
        // 矩形を計算（str を持つアイテムのみ意味がある）
        const fontFamily: string | undefined = styles?.[item.fontName]?.fontFamily;
        itemRects[idx] = computeItemRect(item, viewport, fontAscentRatio(fontFamily, lang ?? null));

        for (const ch of str) {
            rawText += ch;
            charItemIndex.push(idx);
        }
        if (item.hasEOL) {
            rawText += '\n';
            charItemIndex.push(idx);
        }
    });

    return { rawText, charItemIndex, itemRects };
}

/** 1つのテキストアイテムのビューポート座標矩形（CSSピクセル, ページ左上原点）を求める */
function computeItemRect(item: any, viewport: any, ascentRatio: number = DEFAULT_FONT_ASCENT): Rect {
    if (!item.transform || typeof item.width !== 'number') {
        return { left: 0, top: 0, width: 0, height: 0 };
    }
    // pdf.js TextLayer と同じ変換: アイテムの transform をビューポート transform と合成。
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || (item.height ?? 0);
    const width = item.width * viewport.scale;
    // tx[5] はベースライン。文字層の span と同じく、上端はベースライン − 文字高 × ascent 比。
    const fontAscent = fontHeight * ascentRatio;
    const angle = Math.atan2(tx[1], tx[0]);
    const left = angle === 0 ? tx[4] : tx[4] + fontAscent * Math.sin(angle);
    const top = angle === 0 ? tx[5] - fontAscent : tx[5] - fontAscent * Math.cos(angle);
    return { left, top, width, height: fontHeight };
}
