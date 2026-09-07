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
// Issue #156（#150 工程5）PR2: 表示範囲中心の描画への組み替え。
//   ページ数に比例して canvas 描画時間・メモリが増え続けていた問題への対応。
//   - ページ枠（寸法プレースホルダー）は loadPdf() 時点で全ページ分作る。スクロール全体の高さが
//     最初から確定するのが要点（`.ft-page` は CSS で background:#fff のため、未描画ページも
//     正しい寸法の白紙ページとして見える）。
//   - canvas と DOM テキストレイヤーは「表示中のページ ± PAGE_MATERIALIZE_WINDOW ページ」だけ実体化する。
//     判定（実体化すべき集合・差分）は pdf-page-window.ts の純粋関数に切り出し、単体テストで境界を
//     押さえている（本ファイルは DOM/pdf.js 依存のため node --test から検証できない）。
//   - テキスト索引（quote検索用の rawText/charItemIndex/itemRects）は描画と切り離し、全ページぶん
//     バックグラウンドで先に作り切ってから loadPdf() の Promise を解決する。実測でテキスト抽出自体は
//     全体の3.5%程度（支配的なのは canvas 描画とDOM構築）のため、索引を全ページ先読みしても
//     コストは小さい。これにより highlight() 等の既存APIを同期のまま一切変えずに済む
//     （索引を遅延させると、evidence-controller.ts の同期呼び出し・根拠カード一覧まで非同期化が
//     波及してしまうため）。
//   - ハイライト矩形（.ft-highlight-layer の中身）は canvas と違って安価なので、実体化していない
//     ページにも従来どおり全ページぶん描画したままにする。
//
// Issue #156（#150 工程5）PR3: 可視ページ集合そのものの上限と、未描画ページの表示。
//   - PAGE_MATERIALIZE_WINDOW による絞り込みだけでは、同時に交差する可視ページ数自体には
//     上限が無かった。applyWindow() で capTargetPagesByBytes()（pdf-page-window.ts）に通し、
//     canvas合計バイト数（MAX_MATERIALIZED_CANVAS_BYTES）で安全弁をかける。
//     ensureMaterialized()（根拠ジャンプ先の優先描画）には適用しない。
//   - 未描画ページを無地の白紙のままにせず `.ft-page[data-render-state]` でページ番号を
//     薄く表示する（createPageFrame() で 'placeholder'、描画完了で 'rendered'、
//     detachCanvas() で 'placeholder' に戻す）。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findQuoteItems, bboxToRect, type Rect } from './pdf-text-match';
import { computeTargetPages, diffMaterialization, sumCanvasBytes, capTargetPagesByBytes } from './pdf-page-window';
// scanned（画像only）判定の閾値は、AI判定時の検出（lib/pdf-image-only.ts）と共有する。
import { SCANNED_TEXT_THRESHOLD } from '../lib/pdf-constants';
import { perfSpan, perfNow, perfMeasureFrom } from '../lib/perf';

// worker / リソースは webpack の CopyPlugin で dist 直下へ配置する。
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
const CMAP_URL = chrome.runtime.getURL('cmaps/');
const STANDARD_FONT_URL = chrome.runtime.getURL('standard_fonts/');

// 描画スケールの上限（高すぎるとメモリを圧迫するため）。
const MAX_RENDER_SCALE = 2.0;

// 実体化（canvas + DOM テキストレイヤー）対象の前後ウィンドウ幅。可視ページの前後この枚数まで
// 実体化する。値を大きくするほど先読みが効く代わりにメモリ・描画コストが増える。
const PAGE_MATERIALIZE_WINDOW = 1;

// 実体化対象の canvas 合計バイト数（推定）の上限（Issue #156（#150 工程5）PR3）。
// PAGE_MATERIALIZE_WINDOW による「可視 ± 1」の絞り込みだけでは、可視ページ集合そのものの
// 大きさ（ウィンドウが縦に長い・表示倍率が小さい等で同時に交差するページ数）には上限が無いため、
// 安全弁として合計バイト数を縛る。
//
// createPageFrame() の式（fit = min((availWidth-24)/unscaledWidth, MAX_RENDER_SCALE)）と
// A4（595x842pt）を仮定して見積もると、canvas 1枚・3枚合計（実体化ウィンドウの既定枚数）は
// おおよそ次のとおり（幅700px・devicePixelRatio 2 は一般的なノートPC相当、幅1000px・dpr2は
// 高解像度ディスプレイ相当）:
//   320px/dpr1: 0.47MB/枚, 3枚で1.42MB（ベンチ実測 約465KB/枚・常時1.3MBと一致）
//   700px/dpr1: 2.47MB/枚, 3枚で7.40MB
//   700px/dpr2: 9.87MB/枚, 3枚で29.60MB
//   1000px/dpr2: 20.57MB/枚, 3枚で61.70MB
// 実画面では3枚（既定ウィンドウ）だけで最大60MB強に達しうるため、上限はこれを下回ってはならない。
// 128MBはこの最悪ケースの2倍以上の余裕を持たせつつ、極端に多数のページが同時可視になった
// 場合（例: 非常に小さい表示倍率で多数ページが一度に画面へ収まる）に際限なくメモリを
// 食い続けることは防げる値として採用した。下記 MIN_MATERIALIZED_PAGES を置いているため、
// 通常のウィンドウ幅ぶん（既定3枚）は、この上限を下回っていてもバイト数に関わらず必ず維持される
// （上限値そのものの厳密さより、安全弁として機能することを優先する）。
const MAX_MATERIALIZED_CANVAS_BYTES = 128 * 1024 * 1024;

// バイト数に関わらず必ず実体化を維持する最小ページ数。PAGE_MATERIALIZE_WINDOW による
// 既定のウィンドウ幅（可視1ページなら前後1ページずつの3枚）を、MAX_MATERIALIZED_CANVAS_BYTES の
// 選び方に関わらず必ず確保するための下限（PR2 の「可視 ± 1」機能自体を壊さないため）。
const MIN_MATERIALIZED_PAGES = PAGE_MATERIALIZE_WINDOW * 2 + 1;

// IntersectionObserver のマージン。可視になる前に実体化を開始できるよう、ビューポート相当の
// 余白を前後に持たせる（root: null のため、祖先のスクロールによるクリップも考慮される）。
const INTERSECTION_ROOT_MARGIN = '100% 0px';

// ai_evidence: polarity（組入/除外）を伏せた中立表示。ブラインド中のAI evidence に使う。
export type HighlightCategory = 'include_evidence' | 'exclude_evidence' | 'data_point' | 'ai_evidence';

interface PageInfo {
    pageNumber: number;
    scale: number;
    widthPx: number;
    heightPx: number;
    pageDiv: HTMLElement;
    // 実体化されている間だけ非null。解放時に DOM から外して null に戻す。
    canvasEl: HTMLCanvasElement | null;
    textLayerEl: HTMLElement;
    highlightLayer: HTMLElement;
    // 実体化中の RenderTask（キャンセル用）。実体化していない間・render完了後は null。
    renderTask: { cancel: () => void; promise: Promise<void> } | null;
    // テキストマッチ用: 抽出テキストと、各文字がどのテキストアイテムに属するかの対応
    // （バックグラウンドの索引構築が終わるまでは空のまま。loadPdf() の解決前に全ページ分埋まる）
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

/** tiab:pdf.allPages の detail（perfSpan の fn 完了後に読まれるため破壊的更新で埋める）。値は数値のみ。 */
interface AllPagesDetail {
    pageCount?: number;
    /** loadPdf() 解決時点で実体化されていた canvas 枚数 */
    canvasCount?: number;
    /** 同時点の canvas 合計バイト数（各 width * height * 4 の合計） */
    canvasBytes?: number;
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
    // 現在ビューポート（＋マージン）に交差しているページ番号。observer のコールバックが増減させる。
    private visiblePages = new Set<number>();
    // 現在 canvas / DOM テキストレイヤーを実体化しているページ番号。
    private materializedPages = new Set<number>();
    // ページ番号ごとの「実体化が進行中の promise」。同じページに対する materializePage() の
    // 二重起動を防ぐ（理由は materializePage() のコメント参照）。完了したら自分でエントリを消す。
    private materializePromises = new Map<number, Promise<void>>();

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
        this.teardownObserver();
        this.cancelAllRenderTasks();
        this.pages = [];
        this.materializedPages = new Set();
        this.visiblePages = new Set();
        // 進行中の materializePage() 呼び出し自体は止められないが、Map から切り離しておくことで
        // 次の loadPdf() がこのページ番号を再利用しても古い promise を誤って使い回さないようにする
        // （古い呼び出しは token チェックで自然に無害化される。ページ実体化のコメント参照）。
        this.materializePromises = new Map();
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
        // Issue #151（#150 工程0）: tiab:pdf.allPages は loadPdf() 全体（この関数）の計測。
        // ページ数は fn の完了後にしか確定しないため、呼び出し時点では値の決まっていない
        // detail オブジェクトを渡し、fn 側がそれを書き換える（perfSpan は fn の完了後に detail を
        // 読むため、この破壊的更新が計測へ反映される）。
        // Issue #156（#150 工程5）PR2: 中身の意味が「全ページ canvas 描画完了」から
        // 「全ページ索引完成＋初期表示ぶんの描画完了」に変わっている（scripts/bench/README.md 参照）。
        const allPagesDetail: AllPagesDetail = {};
        return perfSpan('tiab:pdf.allPages', () => this.loadPdfCore(data, allPagesDetail), allPagesDetail);
    }

    /**
     * loadPdf() の実処理（perfSpan で tiab:pdf.allPages を包むために private 関数へ切り出している）。
     * 1) 全ページのページ枠（寸法プレースホルダー）を作る（canvas はまだ作らない）。
     * 2) 1ページ目を実体化 → tiab:pdf.firstPage を計測。
     * 3) IntersectionObserver をセットアップし、以後は表示範囲 ± ウィンドウ幅を自動で実体化/解放する。
     * 4) バックグラウンドで全ページの索引（quote検索用）を構築 → tiab:pdf.textIndex を計測。
     * 5) 索引が揃った時点で isImageOnly / totalTextLength を確定し、canvas 枚数・バイト数を
     *    detail に足して返す。
     */
    private async loadPdfCore(data: ArrayBuffer | Uint8Array, allPagesDetail: AllPagesDetail): Promise<LoadedPdf> {
        const token = ++this.renderToken;
        // 前の描画を破棄（destroy だと token を進めて自分を stale 化してしまうため手動で）
        this.teardownObserver();
        this.cancelAllRenderTasks();
        this.pages = [];
        this.materializedPages = new Set();
        this.visiblePages = new Set();
        // 古い文献の in-flight materialize と新しい文献のページ番号がMapキー上で衝突しないよう
        // 切り離す（destroy() と同じ理由。古い呼び出しは token チェックで自然に無害化される）。
        this.materializePromises = new Map();
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
        const stale = { numPages: 0, isImageOnly: false, totalTextLength: 0 };

        // tiab:pdf.firstPage は「読み込み開始 → 先頭ページ描画完了」の意味を変えない（ブリーフの
        // 明示要件）。このPRで手順1として新設した「全ページぶんの pdf.getPage(n)」も、先頭ページが
        // 画面に出るまでの実時間には実際に含まれる（1ページ目の枠を作るのも手順1のループの中）ため、
        // 起点は手順1より前（computeFitScale() の直後）に置く。ここを手順1の後に置くと、このPRが
        // 新たに臨界パスへ足した「全ページ分の getPage(n)」の分だけ計測から消え、実際には速くなって
        // いないのに数値だけ改善したように見えてしまう。
        const firstPageStart = perfNow();

        // 1) 全ページのページ枠を作る。スクロール全体の高さが最初から確定する。
        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            if (token !== this.renderToken) return stale;
            this.pages.push(this.createPageFrame(page, n, fitScale));
        }

        // 2) 1ページ目の canvas / DOM テキストレイヤーを実体化する。
        if (pdf.numPages > 0) {
            this.materializedPages.add(1);
            await this.materializePage(1, token);
            perfMeasureFrom('tiab:pdf.firstPage', firstPageStart);
        }
        if (token !== this.renderToken) return stale;

        // 3) 表示範囲のページを継続的に実体化/解放する。
        this.setupObserver();

        // 4) バックグラウンドで全ページの索引を構築する（highlight() を同期のまま保つための前提。
        //    実測でテキスト抽出自体は全体の3.5%程度のため、全ページ先読みしてもコストは小さい）。
        const textIndexStart = perfNow();
        let totalTextLength = 0;
        for (const info of this.pages) {
            const page = await pdf.getPage(info.pageNumber);
            if (token !== this.renderToken) return stale;
            const viewport = page.getViewport({ scale: info.scale });
            const textContent = await page.getTextContent();
            if (token !== this.renderToken) return stale;
            const { rawText, charItemIndex, itemRects } = buildTextIndex(textContent.items, viewport);
            info.rawText = rawText;
            info.charItemIndex = charItemIndex;
            info.itemRects = itemRects;
            totalTextLength += rawText.replace(/\s/g, '').length;
        }
        perfMeasureFrom('tiab:pdf.textIndex', textIndexStart);

        // 5) この時点の実体化状況を計測に足す。
        allPagesDetail.pageCount = pdf.numPages;
        allPagesDetail.canvasCount = this.materializedPages.size;
        allPagesDetail.canvasBytes = sumCanvasBytes(
            [...this.materializedPages]
                .map(n => this.pages[n - 1]?.canvasEl)
                .filter((c): c is HTMLCanvasElement => !!c)
                .map(c => ({ width: c.width, height: c.height }))
        );

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
     * 指定ページを実体化した場合の canvas バイト数を見積もる（未実体化でも計算できる）。
     * materializePageImpl() が実際に canvas を作るときの式（width/height に devicePixelRatio を
     * 掛けて floor → width * height * 4）に合わせている。実体化済みページについても実際の
     * canvas から取り直さず、この見積りで一貫させる（単純さのため）。
     */
    private estimateCanvasBytes(pageNumber: number): number {
        const info = this.pages[pageNumber - 1];
        if (!info) return 0;
        const outputScale = window.devicePixelRatio || 1;
        const width = Math.floor(info.widthPx * outputScale);
        const height = Math.floor(info.heightPx * outputScale);
        return width * height * 4;
    }

    /**
     * 1ページ分の「枠」を作る（寸法プレースホルダー + 空のテキスト/ハイライトレイヤー）。
     * canvas はここでは作らない（実体化は materializePage() が担う）。
     */
    private createPageFrame(page: any, pageNumber: number, availWidth: number): PageInfo {
        const unscaled = page.getViewport({ scale: 1 });
        // コンテナ幅にフィット（左右パディング分を差し引く）。上限スケールでメモリを抑える。
        const fit = Math.min((availWidth - 24) / unscaled.width, MAX_RENDER_SCALE);
        const scale = fit > 0 ? fit : 1;
        const viewport = page.getViewport({ scale });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'ft-page';
        pageDiv.dataset.page = String(pageNumber);
        // 未描画（白紙）状態。materializePageImpl() の描画完了で 'rendered' に、
        // detachCanvas() での解放で 'placeholder' に戻す（CSSで薄いページ番号を出す）。
        pageDiv.dataset.renderState = 'placeholder';
        pageDiv.style.width = `${Math.floor(viewport.width)}px`;
        pageDiv.style.height = `${Math.floor(viewport.height)}px`;
        // PDF.js 4.x の TextLayer は span 位置を calc(var(--scale-factor)*…) で出力する。
        // 未設定だと calc が無効化されテキストレイヤーがずれるため、viewport の scale を渡す。
        pageDiv.style.setProperty('--scale-factor', String(scale));

        // --- text layer（選択可能・透明。実体化されるまで空） ---
        const textLayer = document.createElement('div');
        textLayer.className = 'ft-text-layer';

        // --- highlight layer（矩形オーバーレイ。canvas と違って安価なので常に全ページぶん描く） ---
        const highlightLayer = document.createElement('div');
        highlightLayer.className = 'ft-highlight-layer';

        pageDiv.appendChild(textLayer);
        pageDiv.appendChild(highlightLayer);
        this.container.appendChild(pageDiv);

        return {
            pageNumber,
            scale,
            widthPx: viewport.width,
            heightPx: viewport.height,
            pageDiv,
            canvasEl: null,
            textLayerEl: textLayer,
            highlightLayer,
            renderTask: null,
            rawText: '',
            charItemIndex: [],
            itemRects: [],
        };
    }

    /**
     * 指定ページを実体化する（canvas を作って render() → DOM テキストレイヤーを構築）。
     * 同じページ番号に対する呼び出しは1本にまとめる（materializePromises で進行中の promise を
     * 共有する）。理由: applyWindow() は IntersectionObserver の発火のたびに独立して
     * materialize/release を判断するため、対策なしだと次の順序で二重起動しうる:
     *   1. ページNの実体化を開始（getPage(N) 待ち。この時点では canvasEl も renderTask もまだ無い）
     *   2. スクロールでNが解放対象になる → releasePage(N)（renderTask が無いためキャンセルする
     *      ものが無く、進行中の1.の呼び出しには何も起きない）
     *   3. さらにNが実体化対象に戻る → materializePage(N) がもう一度呼ばれる
     * ここで1.と3.を別々に走らせてしまうと、両方が canvas を作って pageDiv.insertBefore() し、
     * 最後に代入した方だけが info.canvasEl に残る。先に代入されていた canvas は DOM に残ったまま
     * releasePage()/sumCanvasBytes() のどちらからも見えなくなる（info.canvasEl 経由でしか
     * 参照していないため）。ページ単位で進行中の promise を共有し、二重起動そのものを防ぐ。
     */
    private materializePage(pageNumber: number, token: number): Promise<void> {
        const existing = this.materializePromises.get(pageNumber);
        if (existing) return existing;
        const promise = this.materializePageImpl(pageNumber, token).finally(() => {
            this.materializePromises.delete(pageNumber);
        });
        this.materializePromises.set(pageNumber, promise);
        return promise;
    }

    /**
     * materializePage() の実処理。実体化中に「もう不要になった」（token が進んだ、または
     * materializedPages から外れた）場合は、各 await の直後で中断し、途中まで作った canvas を
     * 後始末する。
     */
    private async materializePageImpl(pageNumber: number, token: number): Promise<void> {
        const info = this.pages[pageNumber - 1];
        if (!info || info.canvasEl) return;
        const stillWanted = () => token === this.renderToken && this.materializedPages.has(pageNumber);

        const page = await this.pdfDoc.getPage(pageNumber);
        // await の直後: 待っている間に解放された／別経路で既に canvas が付いた場合はここで打ち切る
        // （materializePromises による単一化が効いていれば info.canvasEl は基本的に null のはずだが、
        // 万一の漏れに対する最終防衛として明示的に確認する）。
        if (!stillWanted() || info.canvasEl) return;

        const viewport = page.getViewport({ scale: info.scale });
        const canvas = document.createElement('canvas');
        canvas.className = 'ft-page-canvas';
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d');
        // canvas は常にページの先頭（テキスト/ハイライトレイヤーの下）に挿入する。
        info.pageDiv.insertBefore(canvas, info.pageDiv.firstChild);
        info.canvasEl = canvas;

        if (ctx) {
            const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
            const renderTask = page.render({ canvasContext: ctx, viewport, transform });
            info.renderTask = renderTask;
            try {
                await renderTask.promise;
            } catch (err) {
                info.renderTask = null;
                if (isCancelledRenderError(err)) return;
                throw err;
            }
            info.renderTask = null;
            // 描画が実際に完了した時点でのみ 'rendered' にする（canvasをDOMに挿しただけの
            // 時点ではまだピクセルが無いため 'placeholder' のまま。ctxが取れず描画自体を
            // 行わなかった場合もここへは来ない）。
            info.pageDiv.dataset.renderState = 'rendered';
        }
        if (!stillWanted()) { this.detachCanvas(info); return; }

        try {
            const textContent = await page.getTextContent();
            if (!stillWanted()) { this.detachCanvas(info); return; }
            const tl = new pdfjsLib.TextLayer({
                textContentSource: textContent,
                container: info.textLayerEl,
                viewport,
            });
            await tl.render();
        } catch (err) {
            if (!isCancelledRenderError(err)) {
                console.warn(`[pdf-renderer] text layer render failed (page ${pageNumber}):`, err);
            }
        }
    }

    /** 実体化済みの canvas を DOM から外し、幅・高さを0にして解放する。テキストレイヤーの中身も空にする。 */
    private detachCanvas(info: PageInfo): void {
        if (info.canvasEl) {
            info.canvasEl.remove();
            info.canvasEl.width = 0;
            info.canvasEl.height = 0;
            info.canvasEl = null;
        }
        info.textLayerEl.innerHTML = '';
        // 解放後はまた白紙になるため、描画完了前に中断した場合も含めて 'placeholder' に戻す。
        info.pageDiv.dataset.renderState = 'placeholder';
    }

    /**
     * 指定ページを解放する（= detachCanvas）。実体化中なら RenderTask をキャンセルする。
     * `.ft-page` の寸法・`--scale-factor`・ハイライトレイヤーの中身は残す
     * （スクロール位置とハイライトを壊さないため）。
     */
    private releasePage(pageNumber: number): void {
        const info = this.pages[pageNumber - 1];
        if (!info) return;
        if (info.renderTask) {
            try { info.renderTask.cancel(); } catch { /* noop */ }
            info.renderTask = null;
        }
        this.detachCanvas(info);
    }

    /** 全ページの RenderTask をキャンセルする（新しい loadPdf() 開始時・destroy() 時に呼ぶ）。 */
    private cancelAllRenderTasks(): void {
        for (const info of this.pages) {
            if (info.renderTask) {
                try { info.renderTask.cancel(); } catch { /* noop */ }
                info.renderTask = null;
            }
        }
    }

    /**
     * IntersectionObserver をセットアップし、以後は表示範囲 ± PAGE_MATERIALIZE_WINDOW を
     * 自動で実体化/解放する。root: null なので、祖先のスクロールによるクリップも考慮される
     * （スクロール要素を自前で探す必要がない）。
     */
    private setupObserver(): void {
        this.teardownObserver();
        const token = this.renderToken;
        this.observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const pageNumber = Number((entry.target as HTMLElement).dataset.page);
                if (!pageNumber) continue;
                if (entry.isIntersecting) this.visiblePages.add(pageNumber);
                else this.visiblePages.delete(pageNumber);
            }
            this.applyWindow(token);
        }, { root: null, rootMargin: INTERSECTION_ROOT_MARGIN });
        for (const info of this.pages) this.observer.observe(info.pageDiv);
    }

    private teardownObserver(): void {
        this.observer?.disconnect();
        this.observer = null;
    }

    /** 現在の可視ページ集合から実体化すべき集合を求め、差分ぶんだけ実体化/解放する。 */
    private applyWindow(token: number): void {
        if (token !== this.renderToken) return;
        const visible = [...this.visiblePages];
        const target = computeTargetPages(visible, PAGE_MATERIALIZE_WINDOW, this.pages.length);
        // 可視ページ集合そのものの大きさには上限が無いため、canvas合計バイト数の安全弁で絞り込む
        // （IntersectionObserver 経由の実体化にのみ適用する。ensureMaterialized() 経由の
        // 根拠ジャンプ先の優先描画には適用しない。理由は ensureMaterialized() のコメント参照）。
        const capped = capTargetPagesByBytes(
            target,
            visible,
            n => this.estimateCanvasBytes(n),
            MAX_MATERIALIZED_CANVAS_BYTES,
            MIN_MATERIALIZED_PAGES
        );
        const { toMaterialize, toRelease } = diffMaterialization(this.materializedPages, capped);
        for (const n of toRelease) {
            this.materializedPages.delete(n);
            this.releasePage(n);
        }
        for (const n of toMaterialize) {
            this.materializedPages.add(n);
            void this.materializePage(n, token).catch(err => {
                if (!isCancelledRenderError(err)) {
                    console.warn(`[pdf-renderer] materialize failed (page ${n}):`, err);
                }
            });
        }
    }

    /**
     * 指定ページがまだ実体化されていなければ実体化を開始する（投げっぱなし）。
     * scrollToHighlight() / scrollToPage()（根拠ジャンプ）からのみ呼ばれる経路で、
     * applyWindow() の canvas合計バイト数の上限（MAX_MATERIALIZED_CANVAS_BYTES、
     * capTargetPagesByBytes()）はここには適用しない。ジャンプ先ページは、既に上限に達して
     * いる場合でも必ず描く必要があるため（Issue #156 の「根拠ジャンプ時は対象ページを
     * 優先描画する」という要件）。
     */
    private ensureMaterialized(pageNumber: number): void {
        if (this.materializedPages.has(pageNumber)) return;
        const token = this.renderToken;
        this.materializedPages.add(pageNumber);
        void this.materializePage(pageNumber, token).catch(err => {
            if (!isCancelledRenderError(err)) {
                console.warn(`[pdf-renderer] materialize failed (page ${pageNumber}):`, err);
            }
        });
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
        if (page) this.ensureMaterialized(pageNumber);
        page?.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /** 特定ハイライト（id）の位置へスクロールする */
    scrollToHighlight(id: string): void {
        const el = this.container.querySelector(`.ft-highlight[data-hl-id="${cssEscape(id)}"]`) as HTMLElement | null;
        const pageDiv = el?.closest('.ft-page') as HTMLElement | null;
        const pageNumber = pageDiv?.dataset.page ? Number(pageDiv.dataset.page) : undefined;
        if (pageNumber) this.ensureMaterialized(pageNumber);
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

/** RenderTask.cancel() 後に render() の promise が reject する例外かどうか（握りつぶす対象）。 */
function isCancelledRenderError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'RenderingCancelledException';
}
