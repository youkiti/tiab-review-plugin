// pdf-text-match.ts - PDFテキストレイヤーへの quote ファジーマッチ / bbox 変換（純粋関数）
//
// pdf.js / chrome 依存を持たないため単体テスト可能。pdf-renderer.ts から利用する。

/** ページ内の矩形（CSSピクセル, ページ左上原点） */
export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * 正規化（小文字化・空白圧縮・任意で記号除去）を行い、
 * 正規化文字列と「正規化index → 元index」の対応表を返す。
 * @param stripPunct true なら英数字以外を除去（よりラフなマッチ）
 */
export function normalizeWithMap(raw: string, stripPunct: boolean): { norm: string; map: number[] } {
    let norm = '';
    const map: number[] = [];
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
            // 連続空白は1つに圧縮（norm末尾が空白でない時だけ追加）
            if (norm.length > 0 && norm[norm.length - 1] !== ' ') {
                norm += ' ';
                map.push(i);
            }
            continue;
        }
        if (stripPunct && !/[\p{L}\p{N}]/u.test(ch)) {
            continue;
        }
        norm += ch.toLowerCase();
        map.push(i);
    }
    return { norm, map };
}

/**
 * 生テキスト内で quote にマッチする範囲を探し、該当するテキストアイテムのインデックス集合を返す。
 * 1段階目は空白圧縮のみ、見つからなければ2段階目で記号も除去してラフに再試行する。
 * @param charItemIndex raw の各文字が属するテキストアイテムのインデックス
 */
export function findQuoteItems(rawText: string, charItemIndex: number[], quote: string): number[] | null {
    for (const stripPunct of [false, true]) {
        const { norm, map } = normalizeWithMap(rawText, stripPunct);
        const q = normalizeWithMap(quote, stripPunct).norm.trim();
        if (q.length < 3) continue;
        const pos = norm.indexOf(q);
        if (pos < 0) continue;
        const rawStart = map[pos];
        const rawEnd = map[Math.min(pos + q.length - 1, map.length - 1)];
        const itemSet = new Set<number>();
        for (let i = rawStart; i <= rawEnd; i++) {
            const idx = charItemIndex[i];
            if (idx !== undefined) itemSet.add(idx);
        }
        return [...itemSet].sort((a, b) => a - b);
    }
    return null;
}

/** 正規化bbox [l,t,r,b]（0-1, ページ左上原点）をページ内CSSピクセル矩形へ変換 */
export function bboxToRect(
    bbox: [number, number, number, number],
    widthPx: number,
    heightPx: number
): Rect | null {
    let [l, t, r, b] = bbox;
    if (![l, t, r, b].every(v => typeof v === 'number' && v >= 0 && v <= 1)) return null;
    if (r < l) [l, r] = [r, l];
    if (b < t) [t, b] = [b, t];
    const left = l * widthPx;
    const top = t * heightPx;
    const width = (r - l) * widthPx;
    const height = (b - t) * heightPx;
    if (width <= 0 || height <= 0) return null;
    return { left, top, width, height };
}
