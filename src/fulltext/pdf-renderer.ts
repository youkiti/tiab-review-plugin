// pdf-renderer.ts - PDF.js による全文PDFの描画・テキスト抽出・ハイライト基盤
//
// 役割（Phase 0）:
//   - Drive 保存済みPDF(blob)を PDF.js で canvas 描画する（Chrome内蔵iframeビュワーの置換）。
//   - 各ページに「テキストレイヤー（選択可能）」と「ハイライトレイヤー（矩形オーバーレイ）」を重ねる。
//   - テキスト抽出量から scanned（画像only）判定フラグを立てる。
//
// ハイライト解決（Phase 2 で利用する API）:
//   - highlightByText(quote, pageHint): テキストレイヤーの文字列に quote をファジーマッチして矩形描画。
//   - highlightByBBox(page, bbox):      Gemini が返した正規化bboxを画像座標へ展開して矩形描画（画像PDF用）。
//
// MV3 制約への対応:
//   - worker は拡張同梱の `pdf.worker.min.mjs` をローカル参照（remote script 禁止のため）。
//   - cMap / standard_fonts も拡張同梱物を参照する。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findQuoteItems, bboxToRect, type Rect } from './pdf-text-match';

// worker / リソースは webpack の CopyPlugin で dist 直下へ配置する。
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
const CMAP_URL = chrome.runtime.getURL('cmaps/');
const STANDARD_FONT_URL = chrome.runtime.getURL('standard_fonts/');

// テキストレイヤーの抽出文字数がこの値未満なら scanned（画像only）とみなす。
// 1文字も無いとは限らない（透明テキストの断片やページ番号のみ等）ため、ある程度の閾値を置く。
const SCANNED_TEXT_THRESHOLD = 100;

// 描画スケールの上限（高すぎるとメモリを圧迫するため）。
const MAX_RENDER_SCALE = 2.0;

// ai_evidence: polarity（組入/除外）を伏せた中立表示。ブラインド中のAI evidence に使う。
export type HighlightCategory = 'include_evidence' | 'exclude_evidence' | 'data_point' | 'ai_evidence';

interface PageInfo {
    pageNumber: number;
    scale: number;
    widthPx: number;
    heightPx: number;
    pageDiv: HTMLElement;
    highlightLayer: HTMLElement;
    // テキストマッチ用: 抽出テキストと、各文字がどのテキストアイテムに属するかの対応
    rawText: string;
    charItemIndex: number[];
    itemRects: Rect[]; // テキストアイテムごとの矩形（CSSピクセル）
}

export interface LoadedPdf {
    numPages: number;
    /** テキストレイヤーがほぼ空 = 画像onlyのスキャンPDFと判定 */
    isImageOnly: boolean;
    /** 抽出できた総文字数（判定根拠の表示用） */
    totalTextLength: number;
}

/** 1件のハイライト描画指示 */
export interface HighlightRequest {
    id: string;
    category: HighlightCategory;
    /** 経路A: テキスト文字列マッチ */
    quote?: string;
    /** ヒントとなるページ番号（1始まり）。未指定なら全ページ走査。 */
    page?: number;
    /** 経路B: 正規化bbox [left, top, right, bottom]（各0-1, ページ左上原点） */
    bbox?: [number, number, number, number];
    /** ホバー時などに表示するツールチップ */
    title?: string;
}

export interface HighlightResult {
    id: string;
    /** 描画できたか（false ならフォールバック導線が必要） */
    resolved: boolean;
    /** 解決経路 */
    via: 'text' | 'bbox' | 'none';
    /** 描画されたページ番号（resolved 時） */
    page?: number;
}

/**
 * PDF.js による全文ビューア。
 * 1インスタンス = 1つのコンテナ。loadPdf を呼ぶたびに前の描画を破棄して描き直す。
 */
export class PdfRenderer {
    private container: HTMLElement;
    private pdfDoc: any = null;
    private pages: PageInfo[] = [];
    private renderToken = 0;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    /** 現在の描画を破棄し、リソースを解放する */
    destroy(): void {
        this.renderToken++;
        this.pages = [];
        if (this.pdfDoc) {
            try { this.pdfDoc.destroy(); } catch { /* noop */ }
            this.pdfDoc = null;
        }
        this.container.innerHTML = '';
    }

    /**
     * PDFバイト列を読み込み、全ページを描画する。
     * @param data PDFのバイト列（ArrayBuffer / Uint8Array）
     */
    async loadPdf(data: ArrayBuffer | Uint8Array): Promise<LoadedPdf> {
        const token = ++this.renderToken;
        // 前の描画を破棄（destroy だと token を進めて自分を stale 化してしまうため手動で）
        this.pages = [];
        if (this.pdfDoc) {
            try { this.pdfDoc.destroy(); } catch { /* noop */ }
            this.pdfDoc = null;
        }
        this.container.innerHTML = '';

        // getDocument は渡された Uint8Array を transferable として消費するためコピーして渡す。
        const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
        const loadingTask = pdfjsLib.getDocument({
            data: bytes,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_URL,
        });
        const pdf = await loadingTask.promise;
        if (token !== this.renderToken) {
            try { pdf.destroy(); } catch { /* noop */ }
            return { numPages: 0, isImageOnly: false, totalTextLength: 0 };
        }
        this.pdfDoc = pdf;

        const fitScale = this.computeFitScale();
        let totalTextLength = 0;

        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            if (token !== this.renderToken) break;
            const info = await this.renderPage(page, n, fitScale, token);
            if (token !== this.renderToken) break;
            if (info) {
                this.pages.push(info);
                totalTextLength += info.rawText.replace(/\s/g, '').length;
            }
        }

        return {
            numPages: pdf.numPages,
            isImageOnly: totalTextLength < SCANNED_TEXT_THRESHOLD,
            totalTextLength,
        };
    }

    /** コンテナ幅に合わせた描画スケールを求める */
    private computeFitScale(): number {
        const avail = this.container.clientWidth || 700;
        // 標準的な論文（幅595pt前後）を基準にフィットさせる。後で page ごとに再計算する。
        return avail;
    }

    /** 1ページを描画し、テキスト/ハイライトレイヤーを構築する */
    private async renderPage(page: any, pageNumber: number, availWidth: number, token: number): Promise<PageInfo | null> {
        const unscaled = page.getViewport({ scale: 1 });
        // コンテナ幅にフィット（左右パディング分を差し引く）。上限スケールでメモリを抑える。
        const fit = Math.min((availWidth - 24) / unscaled.width, MAX_RENDER_SCALE);
        const scale = fit > 0 ? fit : 1;
        const viewport = page.getViewport({ scale });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'ft-page';
        pageDiv.dataset.page = String(pageNumber);
        pageDiv.style.width = `${Math.floor(viewport.width)}px`;
        pageDiv.style.height = `${Math.floor(viewport.height)}px`;
        // PDF.js 4.x の TextLayer は span 位置を calc(var(--scale-factor)*…) で出力する。
        // 未設定だと calc が無効化されテキストレイヤーがずれるため、viewport の scale を渡す。
        pageDiv.style.setProperty('--scale-factor', String(scale));

        // --- canvas（描画） ---
        const canvas = document.createElement('canvas');
        canvas.className = 'ft-page-canvas';
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d');
        pageDiv.appendChild(canvas);

        // --- text layer（選択可能・透明） ---
        const textLayer = document.createElement('div');
        textLayer.className = 'ft-text-layer';

        // --- highlight layer（矩形オーバーレイ） ---
        const highlightLayer = document.createElement('div');
        highlightLayer.className = 'ft-highlight-layer';

        pageDiv.appendChild(textLayer);
        pageDiv.appendChild(highlightLayer);
        this.container.appendChild(pageDiv);

        // 描画
        if (ctx) {
            const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
            await page.render({ canvasContext: ctx, viewport, transform }).promise;
        }
        if (token !== this.renderToken) return null;

        // テキスト抽出 + テキストレイヤー構築
        const textContent = await page.getTextContent();
        if (token !== this.renderToken) return null;

        try {
            const tl = new pdfjsLib.TextLayer({
                textContentSource: textContent,
                container: textLayer,
                viewport,
            });
            await tl.render();
        } catch (err) {
            console.warn(`[pdf-renderer] text layer render failed (page ${pageNumber}):`, err);
        }

        // マッチ用の生テキスト・文字→アイテム対応・アイテム矩形を構築
        const { rawText, charItemIndex, itemRects } = buildTextIndex(textContent.items, viewport);

        return {
            pageNumber,
            scale,
            widthPx: viewport.width,
            heightPx: viewport.height,
            pageDiv,
            highlightLayer,
            rawText,
            charItemIndex,
            itemRects,
        };
    }

    /** 全ハイライトを消す */
    clearHighlights(): void {
        for (const p of this.pages) {
            p.highlightLayer.innerHTML = '';
        }
    }

    /** ハイライト表示/非表示を切り替える */
    setHighlightsVisible(visible: boolean): void {
        for (const p of this.pages) {
            p.highlightLayer.style.display = visible ? '' : 'none';
        }
    }

    /**
     * 1件のハイライト要求を解決して描画する。
     * 経路A（quote文字列マッチ）→ 失敗時に経路B（bbox）→ どちらも不可なら resolved:false。
     */
    highlight(req: HighlightRequest): HighlightResult {
        // 経路A: テキストマッチ
        if (req.quote && req.quote.trim().length >= 3) {
            const hit = this.matchQuote(req.quote, req.page);
            if (hit) {
                this.drawRects(hit.page, hit.rects, req);
                return { id: req.id, resolved: true, via: 'text', page: hit.pageNumber };
            }
        }
        // 経路B: bbox
        if (req.bbox && req.page) {
            const page = this.pages.find(p => p.pageNumber === req.page);
            if (page) {
                const rect = bboxToRect(req.bbox, page.widthPx, page.heightPx);
                if (rect) {
                    this.drawRects(page, [rect], req);
                    return { id: req.id, resolved: true, via: 'bbox', page: page.pageNumber };
                }
            }
        }
        return { id: req.id, resolved: false, via: 'none' };
    }

    /** 指定ページ（1始まり）の先頭が見えるようスクロールする */
    scrollToPage(pageNumber: number): void {
        const page = this.pages.find(p => p.pageNumber === pageNumber);
        page?.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /** 特定ハイライト（id）の位置へスクロールする */
    scrollToHighlight(id: string): void {
        const el = this.container.querySelector(`.ft-highlight[data-hl-id="${cssEscape(id)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // -----------------------------------------------------------------------

    /** quote をテキストレイヤーにマッチさせ、該当アイテムの矩形群を返す */
    private matchQuote(quote: string, pageHint?: number): { page: PageInfo; pageNumber: number; rects: Rect[] } | null {
        const targets = pageHint
            ? this.pages.filter(p => p.pageNumber === pageHint).concat(this.pages.filter(p => p.pageNumber !== pageHint))
            : this.pages;

        for (const page of targets) {
            const itemIdxs = findQuoteItems(page.rawText, page.charItemIndex, quote);
            if (itemIdxs && itemIdxs.length > 0) {
                const rects = itemIdxs
                    .map(i => page.itemRects[i])
                    .filter((r): r is Rect => !!r && r.width > 0 && r.height > 0);
                if (rects.length > 0) {
                    return { page, pageNumber: page.pageNumber, rects };
                }
            }
        }
        return null;
    }

    /** 矩形群をハイライトレイヤーに描画する */
    private drawRects(page: PageInfo, rects: Rect[], req: HighlightRequest): void {
        for (const r of rects) {
            const el = document.createElement('div');
            el.className = 'ft-highlight';
            el.dataset.category = req.category;
            el.dataset.hlId = req.id;
            if (req.title) el.title = req.title;
            el.style.left = `${r.left}px`;
            el.style.top = `${r.top}px`;
            el.style.width = `${r.width}px`;
            el.style.height = `${r.height}px`;
            page.highlightLayer.appendChild(el);
        }
    }
}

// ---------------------------------------------------------------------------
// テキストインデックス構築 / マッチング（モジュール関数: 単体テスト容易化のため外出し）
// ---------------------------------------------------------------------------

/**
 * テキストアイテム配列から、マッチ用の生テキスト・文字→アイテム対応・アイテム矩形を構築する。
 * 矩形は pdf.js の text layer と同じ式（Util.transform）でビューポート座標へ変換する。
 */
function buildTextIndex(
    items: any[],
    viewport: any
): { rawText: string; charItemIndex: number[]; itemRects: Rect[] } {
    let rawText = '';
    const charItemIndex: number[] = [];
    const itemRects: Rect[] = [];

    items.forEach((item, idx) => {
        // マーク（hasEOL のみで str を持たない要素）は矩形なしで扱う
        const str: string = typeof item.str === 'string' ? item.str : '';
        // 矩形を計算（str を持つアイテムのみ意味がある）
        itemRects[idx] = computeItemRect(item, viewport);

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
function computeItemRect(item: any, viewport: any): Rect {
    if (!item.transform || typeof item.width !== 'number') {
        return { left: 0, top: 0, width: 0, height: 0 };
    }
    // pdf.js TextLayer と同じ変換: アイテムの transform をビューポート transform と合成。
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || (item.height ?? 0);
    const width = item.width * viewport.scale;
    const left = tx[4];
    const top = tx[5] - fontHeight; // tx[5] はベースライン。矩形上端はベースライン - 文字高。
    return { left, top, width, height: fontHeight };
}

/** querySelector 用に id をエスケープ（CSS.escape が無い環境向けの簡易版） */
function cssEscape(s: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return s.replace(/["\\]/g, '\\$&');
}
