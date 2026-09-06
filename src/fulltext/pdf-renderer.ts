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
//
// 表示範囲中心の描画（Issue #156（#150 工程5））:
//   長いPDFで全ページを一括描画すると canvas 数とメモリがページ数に比例して増え続ける。
//   loadPdf() はまず全ページ分の「プレースホルダー」（寸法確定済みの div + ハイライト層 +
//   空のテキスト層）とテキスト索引（quote検索・isImageOnly判定用）だけを作り、canvas描画と
//   選択可能なテキストレイヤーは先頭ページ（優先）と、その後は IntersectionObserver が
//   報告する表示中ページ＋前後 RENDER_RADIUS ページだけに絞る。描画済み総数は
//   MAX_RENDERED_PAGES を超えないよう、表示範囲から遠いページを解放する（`src/lib/pdf-page-window.ts`
//   の純関数 planPdfPageWindow() が「次に描画すべきページ」「解放すべきページ」を決める）。
//   ページ div の寸法・ハイライト層・テキスト索引は解放時も保持するため、ハイライト矩形の描画
//   （highlight()）と scrollToHighlight() はページの描画状態に関わらず動く。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findQuoteItems, bboxToRect, type Rect } from './pdf-text-match';
// scanned（画像only）判定の閾値は、AI判定時の検出（lib/pdf-image-only.ts）と共有する。
import { SCANNED_TEXT_THRESHOLD } from '../lib/pdf-constants';
import { perfSpan, perfNow, perfMeasureFrom } from '../lib/perf';
import { planPdfPageWindow } from '../lib/pdf-page-window';

// worker / リソースは webpack の CopyPlugin で dist 直下へ配置する。
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
const CMAP_URL = chrome.runtime.getURL('cmaps/');
const STANDARD_FONT_URL = chrome.runtime.getURL('standard_fonts/');

// 描画スケールの上限（高すぎるとメモリを圧迫するため）。
const MAX_RENDER_SCALE = 2.0;

// 同時に描画済み（canvas + テキストレイヤーあり）として保持するページ数の上限。
// 数百ページのPDFでも canvas 数を一定に抑えるのが目的。可視ページ数（通常1〜2）+
// 前後 RENDER_RADIUS のバッファに、スクロール方向転換時の再描画を減らす余裕を足した値。
const MAX_RENDERED_PAGES = 12;
// 表示中ページの前後、追加で描画しておくページ数（スクロール時に空白が見える猶予を作る）。
const RENDER_RADIUS = 2;

// ai_evidence: polarity（組入/除外）を伏せた中立表示。ブラインド中のAI evidence に使う。
export type HighlightCategory = 'include_evidence' | 'exclude_evidence' | 'data_point' | 'ai_evidence';

/** ページの描画状態。プレースホルダー（未描画）→ 描画中 → 描画済み、解放で再びプレースホルダーへ戻る。 */
type PageRenderState = 'placeholder' | 'rendering' | 'rendered';

interface PageInfo {
    pageNumber: number;
    scale: number;
    widthPx: number;
    heightPx: number;
    pageDiv: HTMLElement;
    highlightLayer: HTMLElement;
    textLayerEl: HTMLElement;
    // テキストマッチ用: 抽出テキストと、各文字がどのテキストアイテムに属するかの対応
    rawText: string;
    charItemIndex: number[];
    itemRects: Rect[]; // テキストアイテムごとの矩形（CSSピクセル）
    renderState: PageRenderState;
    /**
     * このページに対する「描画の試行」の世代番号。renderPageByNumber() が新しい描画を
     * 開始するたび、releasePageByNumber() が解放するたびにインクリメントする。
     * renderPageVisual() は各 await の後にこの値を捕捉した世代と比較し、一致しなければ
     * （その間に解放→再描画が割り込んで別の世代が進行中ということなので）何もせず戻る。
     * token（PDF全体の再読み込み判定）だけでは、同一PDF内での「あるページの解放→即再描画」
     * という世代交代を区別できないため、ページ単位でこの値を持つ。
     */
    renderGeneration: number;
    canvas: HTMLCanvasElement | null;
    /** 進行中の page.render() タスク（cancel() 用に保持。完了/キャンセル後は null に戻す） */
    renderTask: { promise: Promise<void>; cancel: () => void } | null;
    /**
     * 進行中の TextLayer 描画タスク（cancel() 用に保持。完了/中断後は null に戻す）。
     * renderTask と同じ流儀で保持する。保持しないと releasePageByNumber() が
     * textLayerEl.innerHTML を空にした後でも render() が span を追記し続けてしまい、
     * 解放済み（canvasの無い白紙）ページの上に選択可能テキストだけが残る
     * （PR #185 レビュー指摘。Issue #156）。
     */
    textLayerTask: { cancel: () => void } | null;
    /** pdf.js の PDFPageProxy（描画・再描画のたびに render()/getTextContent() を呼ぶため保持） */
    pdfPage: any;
    /** pdf.js の PageViewport（描画のたびに再計算しないよう保持） */
    viewport: any;
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

/** page.render() のキャンセルによる中断（解放/破棄時に想定内で発生する）かどうか。 */
function isRenderCancelled(err: unknown): boolean {
    return err instanceof pdfjsLib.RenderingCancelledException;
}

/**
 * TextLayer.cancel() による中断（解放/破棄時に想定内で発生する）かどうか。
 * pdf.js は cancel() 呼び出し時、render() が返す Promise を AbortException で reject する
 * （PR #185 レビュー指摘。Issue #156）。isRenderCancelled() と同様、想定内の中断として
 * 呼び出し側で黙って無視するために使う。
 */
function isAbortException(err: unknown): boolean {
    return err instanceof pdfjsLib.AbortException;
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
    private observer: IntersectionObserver | null = null;
    /** IntersectionObserver が現在「表示中」と報告しているページ番号の集合。 */
    private visiblePages = new Set<number>();

    /**
     * PDF上のハイライト矩形クリック時に呼ばれるコールバック（引数はハイライトid）。
     * 右ペインの根拠カードへの連動スクロール・強調に使う。
     */
    onHighlightClick: ((id: string) => void) | null = null;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    /** 現在の描画を破棄し、リソースを解放する */
    destroy(): void {
        this.renderToken++;
        this.disconnectObserver();
        this.cancelAllRenderTasks();
        this.pages = [];
        this.visiblePages = new Set();
        if (this.pdfDoc) {
            try { this.pdfDoc.destroy(); } catch { /* noop */ }
            this.pdfDoc = null;
        }
        this.container.innerHTML = '';
    }

    /**
     * PDFバイト列を読み込み、全ページ分のプレースホルダー・テキスト索引を構築したうえで
     * 先頭ページを描画する。以降のページは IntersectionObserver が表示範囲に応じて描画する。
     * @param data PDFのバイト列（ArrayBuffer / Uint8Array）
     */
    async loadPdf(data: ArrayBuffer | Uint8Array): Promise<LoadedPdf> {
        // Issue #156（#150 工程5）: tiab:pdf.allPages は loadPdf() 全体（この関数）の計測。
        // 表示範囲中心の描画に変えた後も、意味は「プレースホルダー構築＋全ページのテキスト索引
        // 構築＋先頭ページの描画」が完了するまでの時間のまま変わらない（ページ数に応じて
        // 増えるのは索引構築のみで、canvas描画は先頭ページ1枚だけになった点が変化）。
        // ページ数は fn の完了後にしか確定しないため、呼び出し時点では値の決まっていない
        // detail オブジェクトを渡し、fn 側がそれを書き換える（perfSpan は fn の完了後に detail を
        // 読むため、この破壊的更新が計測へ反映される）。
        const allPagesDetail: { pageCount?: number } = {};
        return perfSpan('tiab:pdf.allPages', () => this.loadPdfCore(data, allPagesDetail), allPagesDetail);
    }

    /**
     * loadPdf() の実処理（perfSpan で tiab:pdf.allPages を包むために private 関数へ切り出している）。
     * tiab:pdf.firstPage は「先頭ページの canvas + テキストレイヤー描画」完了時点で計測する
     * （プレースホルダー構築だけでは白紙のため、Issue #151（#150 工程0）時点の意味を維持する）。
     */
    private async loadPdfCore(data: ArrayBuffer | Uint8Array, allPagesDetail: { pageCount?: number }): Promise<LoadedPdf> {
        const token = ++this.renderToken;
        // 前の描画を破棄（destroy だと token を進めて自分を stale 化してしまうため手動で）
        this.disconnectObserver();
        this.cancelAllRenderTasks();
        this.pages = [];
        this.visiblePages = new Set();
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
        const firstPageStart = perfNow();

        for (let n = 1; n <= pdf.numPages; n++) {
            const pdfPage = await pdf.getPage(n);
            if (token !== this.renderToken) break;
            const info = await this.buildPlaceholder(pdfPage, n, fitScale, token);
            if (token !== this.renderToken || !info) break;
            this.pages.push(info);
            totalTextLength += info.rawText.replace(/\s/g, '').length;

            if (n === 1) {
                // 先頭ページは索引構築の直後、他ページを待たずに優先描画する。
                await this.renderPageByNumber(1, token);
                if (token !== this.renderToken) break;
                perfMeasureFrom('tiab:pdf.firstPage', firstPageStart);
            }
        }

        if (token !== this.renderToken) {
            return { numPages: 0, isImageOnly: false, totalTextLength: 0 };
        }

        allPagesDetail.pageCount = pdf.numPages;
        this.setupObserver();
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

    /**
     * 1ページ分のプレースホルダー（寸法確定済みの div・ハイライト層・空のテキスト層）と
     * テキスト索引（quote検索・isImageOnly判定用）を構築する。canvas描画・選択可能な
     * テキストレイヤーはここでは作らない（表示範囲に入ったときに renderPageVisual() が行う）。
     */
    private async buildPlaceholder(pdfPage: any, pageNumber: number, availWidth: number, token: number): Promise<PageInfo | null> {
        const unscaled = pdfPage.getViewport({ scale: 1 });
        // コンテナ幅にフィット（左右パディング分を差し引く）。上限スケールでメモリを抑える。
        const fit = Math.min((availWidth - 24) / unscaled.width, MAX_RENDER_SCALE);
        const scale = fit > 0 ? fit : 1;
        const viewport = pdfPage.getViewport({ scale });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'ft-page';
        pageDiv.dataset.page = String(pageNumber);
        pageDiv.dataset.renderState = 'placeholder';
        pageDiv.style.width = `${Math.floor(viewport.width)}px`;
        pageDiv.style.height = `${Math.floor(viewport.height)}px`;
        // PDF.js 4.x の TextLayer は span 位置を calc(var(--scale-factor)*…) で出力する。
        // 未設定だと calc が無効化されテキストレイヤーがずれるため、viewport の scale を渡す。
        pageDiv.style.setProperty('--scale-factor', String(scale));

        // --- text layer（選択可能・透明。中身は描画対象になってから敷く） ---
        const textLayer = document.createElement('div');
        textLayer.className = 'ft-text-layer';

        // --- highlight layer（矩形オーバーレイ。描画状態に関わらず常に存在させる） ---
        const highlightLayer = document.createElement('div');
        highlightLayer.className = 'ft-highlight-layer';

        pageDiv.appendChild(textLayer);
        pageDiv.appendChild(highlightLayer);
        this.container.appendChild(pageDiv);

        // マッチ用の生テキスト・文字→アイテム対応・アイテム矩形は全ページ分を先読みで構築する
        // （quote検索とisImageOnly判定を「先頭ページだけで確定」にしないため）。
        const textContent = await pdfPage.getTextContent();
        if (token !== this.renderToken) return null;
        const { rawText, charItemIndex, itemRects } = buildTextIndex(textContent.items, viewport);

        return {
            pageNumber,
            scale,
            widthPx: viewport.width,
            heightPx: viewport.height,
            pageDiv,
            highlightLayer,
            textLayerEl: textLayer,
            rawText,
            charItemIndex,
            itemRects,
            renderState: 'placeholder',
            renderGeneration: 0,
            canvas: null,
            renderTask: null,
            textLayerTask: null,
            pdfPage,
            viewport,
        };
    }

    /** IntersectionObserver をスクロールコンテナに張り、全ページ div を監視対象にする。 */
    private setupObserver(): void {
        this.disconnectObserver();
        if (this.pages.length === 0) return;
        // #ft-pdf-canvas-container（this.container）の親が #ft-pdf-viewer（overflow:auto の
        // スクロールコンテナ）。fulltext.html / fulltext.css 参照。
        const root = this.container.parentElement;
        // rootMargin は「前後1ページ相当」の近似として先頭ページの高さを使う（同一論文なら
        // ページ高がほぼ一定なため。用紙サイズが混在するPDFでは厳密ではないが、先読みの
        // 目安としては十分。極端に小さいPDFでも最低200pxは確保する）。
        const margin = Math.max(200, Math.ceil(this.pages[0].heightPx));
        this.observer = new IntersectionObserver(
            entries => this.onIntersect(entries),
            { root, rootMargin: `${margin}px 0px`, threshold: 0 }
        );
        for (const p of this.pages) this.observer.observe(p.pageDiv);
    }

    private disconnectObserver(): void {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    /**
     * 進行中の page.render() / TextLayer 描画タスクを全ページ分キャンセルする
     * （destroy() / 再ロード時に呼ぶ）。この直後に呼び出し元が pdfDoc.destroy() するため、
     * pdf.js 側のページリソース（オペレータリスト・フォント/画像オブジェクト）の解放は
     * ここでは行わない。WorkerTransport.destroy() がキャッシュ済みの全ページに対して
     * page._destroy() を呼び、cleanup() より強く（force: true でオペレータリストを中断し
     * objs を clear する）まとめて解放するため（PR #185 レビュー指摘。Issue #156）。
     */
    private cancelAllRenderTasks(): void {
        for (const p of this.pages) {
            if (p.renderTask) {
                try { p.renderTask.cancel(); } catch { /* noop */ }
                p.renderTask = null;
            }
            if (p.textLayerTask) {
                try { p.textLayerTask.cancel(); } catch { /* noop */ }
                p.textLayerTask = null;
            }
        }
    }

    private onIntersect(entries: IntersectionObserverEntry[]): void {
        const token = this.renderToken;
        for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.page);
            if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;
            if (entry.isIntersecting) this.visiblePages.add(pageNumber);
            else this.visiblePages.delete(pageNumber);
        }
        // disconnect() 直前に既にキューされていた通知が届く可能性への防御（destroy/再ロード後は
        // this.pages が別のPDFのものに入れ替わっているため、ここで処理を打ち切る）。
        if (token !== this.renderToken) return;
        this.applyWindowPlan(token);
    }

    /** 現在の表示範囲・描画済み状況から次の描画/解放計画を求め、実行する。 */
    private applyWindowPlan(token: number): void {
        if (this.pages.length === 0) return;
        // 'rendering' も「これから描画済みになる」ものとして扱い、同じページへの重複要求を防ぐ
        // （合流。renderPageByNumber() は 'placeholder' 以外を早期returnする）。
        const renderedOrRendering = this.pages
            .filter(p => p.renderState !== 'placeholder')
            .map(p => p.pageNumber);
        const plan = planPdfPageWindow({
            numPages: this.pages.length,
            visiblePages: Array.from(this.visiblePages),
            radius: RENDER_RADIUS,
            renderedPages: renderedOrRendering,
            maxRenderedPages: MAX_RENDERED_PAGES,
        });
        for (const pageNumber of plan.toRelease) this.releasePageByNumber(pageNumber, token);
        for (const pageNumber of plan.toRender) void this.renderPageByNumber(pageNumber, token);
    }

    /** 指定ページを描画する（既に描画中/描画済みなら何もしない。合流のための冪等ガード）。 */
    private async renderPageByNumber(pageNumber: number, token: number): Promise<void> {
        if (token !== this.renderToken) return;
        const page = this.pages.find(p => p.pageNumber === pageNumber);
        if (!page || page.renderState !== 'placeholder') return;
        // この描画試行の世代を確定する。renderPageVisual() 内の各 await 後にこの値と
        // page.renderGeneration を比較し、途中で解放→再描画（世代交代）が割り込んでいたら
        // 何もせず戻る（Issue #156 レビュー指摘: 解放直後の再描画とテキストレイヤー構築が
        // 競合すると span が二重に敷かれ得た）。
        const generation = ++page.renderGeneration;
        page.renderState = 'rendering';
        page.pageDiv.dataset.renderState = 'rendering';
        try {
            await this.renderPageVisual(page, token, generation);
            if (token === this.renderToken && page.renderGeneration === generation && page.renderState === 'rendering') {
                page.renderState = 'rendered';
                page.pageDiv.dataset.renderState = 'rendered';
            }
        } catch (err) {
            if (isRenderCancelled(err)) return; // 解放/破棄によるキャンセルは想定内なので無視する
            console.warn(`[pdf-renderer] ページ${pageNumber}の描画に失敗しました:`, err);
            if (page.renderGeneration === generation && page.renderState === 'rendering') {
                page.renderState = 'placeholder';
                page.pageDiv.dataset.renderState = 'placeholder';
            }
        }
    }

    /** canvas描画 + 選択可能なテキストレイヤーの構築（1ページ分）。 */
    private async renderPageVisual(page: PageInfo, token: number, generation: number): Promise<void> {
        const canvas = document.createElement('canvas');
        canvas.className = 'ft-page-canvas';
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(page.viewport.width * outputScale);
        canvas.height = Math.floor(page.viewport.height * outputScale);
        canvas.style.width = `${Math.floor(page.viewport.width)}px`;
        canvas.style.height = `${Math.floor(page.viewport.height)}px`;
        page.pageDiv.insertBefore(canvas, page.pageDiv.firstChild);
        page.canvas = canvas;

        const ctx = canvas.getContext('2d');
        if (ctx) {
            const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
            const task = page.pdfPage.render({ canvasContext: ctx, viewport: page.viewport, transform });
            page.renderTask = task;
            try {
                await task.promise;
            } finally {
                if (page.renderTask === task) page.renderTask = null;
            }
        }
        // 解放/破棄、または解放→再描画による世代交代がこの間に起きていたら、テキストレイヤーは
        // 敷かない（世代交代後は自分はもう「最新の描画試行」ではないため、以降の副作用は
        // 新しい世代のものだけが行う）。
        if (token !== this.renderToken || page.renderGeneration !== generation || page.renderState !== 'rendering') return;

        // テキストレイヤー用に getTextContent() を再取得する（索引構築時に読んだものは
        // 保持していない。全ページ分の textContent を持ち続けるとページ数に比例して
        // メモリを圧迫するため、実際に描画するページ分だけ読み直す）。
        try {
            const textContent = await page.pdfPage.getTextContent();
            if (token !== this.renderToken || page.renderGeneration !== generation || page.renderState !== 'rendering') return;
            page.textLayerEl.innerHTML = '';
            const tl = new pdfjsLib.TextLayer({
                textContentSource: textContent,
                container: page.textLayerEl,
                viewport: page.viewport,
            });
            // 解放時に cancel() で中断できるよう保持する（PR #185 レビュー指摘。Issue #156）。
            page.textLayerTask = tl;
            try {
                await tl.render();
            } finally {
                if (page.textLayerTask === tl) page.textLayerTask = null;
            }
            if (token !== this.renderToken || page.renderGeneration !== generation || page.renderState !== 'rendering') return;
        } catch (err) {
            // cancel() による想定内の中断（解放/破棄）は isRenderCancelled() と同様に無視する。
            // 無視しないと解放のたびに警告が出る（PR #185 レビュー指摘。Issue #156）。
            if (isAbortException(err)) return;
            console.warn(`[pdf-renderer] text layer render failed (page ${page.pageNumber}):`, err);
        }
    }

    /** 指定ページの描画を解放する（canvas破棄・テキストレイヤーの中身を空にする）。 */
    private releasePageByNumber(pageNumber: number, token: number): void {
        if (token !== this.renderToken) return;
        const page = this.pages.find(p => p.pageNumber === pageNumber);
        if (!page) return;
        // 進行中の描画試行（renderPageVisual）がこの解放を古い世代として検知できるよう、
        // 先に世代を進める（Issue #156 レビュー指摘対応）。
        page.renderGeneration++;
        if (page.renderTask) {
            try { page.renderTask.cancel(); } catch { /* noop */ }
            page.renderTask = null;
        }
        // pdf.js 側が保持するこのページのリソース（オペレータリスト・フォント/画像オブジェクト）を
        // 解放する（PR #185 レビュー指摘。Issue #156）。上の renderTask.cancel() は完了コールバックを
        // 同期的に呼び、その中でレンダータスクの登録も同期的に外れるため、同一同期ブロックの
        // 直後で呼んでも cleanup() 側が「まだ描画中」と誤判定することはない。cleanup() は
        // best-effort で、描画中やオペレータリストがワーカーから流れ切っていない場合は何もせず
        // false を返すだけなので、戻り値は見ず再試行もしない。cleanup() 後もページは再利用でき
        // （次の render()/getTextContent() がワーカーから読み直す）、ハイライト用のテキスト索引
        // （rawText / charItemIndex / itemRects）は PageInfo 側が保持しているため影響を受けない。
        try { page.pdfPage.cleanup(); } catch { /* noop */ }
        if (page.textLayerTask) {
            // 進行中の TextLayer 描画を中断する（PR #185 レビュー指摘。Issue #156）。中断しないと、
            // すぐ下の textLayerEl.innerHTML = '' の後でも render() が span を追記し続け、解放済み
            // （canvasの無い白紙）ページの上に選択可能テキストだけが残ってしまう。
            try { page.textLayerTask.cancel(); } catch { /* noop */ }
            page.textLayerTask = null;
        }
        if (page.canvas) {
            page.canvas.remove();
            page.canvas = null;
        }
        // ページ div の寸法・ハイライト層・テキスト索引（rawText等）は保持する。
        // ハイライト矩形の描画・scrollToHighlight() は解放後も動く必要があるため。
        page.textLayerEl.innerHTML = '';
        page.renderState = 'placeholder';
        page.pageDiv.dataset.renderState = 'placeholder';
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
     * ページの描画状態に関わらず動く（テキスト索引・矩形計算はプレースホルダー段階で確定済み）。
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
        if (!page) return;
        // IntersectionObserver がスクロール後に描画を起こすが、先行して要求しておくことで
        // スクロール直後の空白（プレースホルダー）が見える時間を減らす。結果は待たない。
        void this.renderPageByNumber(pageNumber, this.renderToken);
        page.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /** 特定ハイライト（id）の位置へスクロールする */
    scrollToHighlight(id: string): void {
        const el = this.container.querySelector(`.ft-highlight[data-hl-id="${cssEscape(id)}"]`) as HTMLElement | null;
        if (el) {
            const pageNumber = Number(el.dataset.page);
            if (Number.isFinite(pageNumber) && pageNumber > 0) {
                // scrollToPage() と同じ理由で先行描画を要求する（結果は待たない）。
                void this.renderPageByNumber(pageNumber, this.renderToken);
            }
        }
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * 特定ハイライト（id）を一時的に強調する（スクロール後の視線誘導用）。
     * flash クラスを付け直してCSSアニメーションを再始動し、終了後に外す。
     */
    flashHighlight(id: string): void {
        const els = this.container.querySelectorAll(`.ft-highlight[data-hl-id="${cssEscape(id)}"]`);
        els.forEach(node => {
            const el = node as HTMLElement;
            el.classList.remove('ft-highlight-flash');
            void el.offsetWidth; // reflow でアニメーションをリセット
            el.classList.add('ft-highlight-flash');
            window.setTimeout(() => el.classList.remove('ft-highlight-flash'), 1300);
        });
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
            // scrollToHighlight() が「対象ページの先行描画」を要求するために使う。
            el.dataset.page = String(page.pageNumber);
            if (req.title) el.title = req.title;
            el.style.left = `${r.left}px`;
            el.style.top = `${r.top}px`;
            el.style.width = `${r.width}px`;
            el.style.height = `${r.height}px`;
            el.addEventListener('click', () => this.onHighlightClick?.(req.id));
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
