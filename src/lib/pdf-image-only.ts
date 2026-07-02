// pdf-image-only.ts - PDFがスキャン(画像only)かどうかをテキスト抽出量から判定する
//
// フルテキストAI判定の実行時（sidepanel）に呼び、結果を FulltextLlmDecisionNote.image_only
// として保存する。ビューア（fulltext/pdf-renderer.ts）の scanned 判定と同じ閾値を使い、
// 表示経路によらず「スキャンPDFのためハイライト精度が落ちる」注意を出せるようにする。
//
// MV3 制約: worker は拡張同梱の `pdf.worker.min.mjs` をローカル参照（remote script 禁止）。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// 抽出できた非空白文字の総数がこの値未満なら scanned（画像only）とみなす。
// 1文字も無いとは限らない（透明テキストの断片やページ番号のみ等）ため、ある程度の閾値を置く。
export const SCANNED_TEXT_THRESHOLD = 100;

/**
 * PDFバイト列からテキストを抽出し、スキャン(画像only)PDFかどうかを判定する。
 * 閾値に達した時点で走査を打ち切るため、totalTextLength は打ち切り時点までの数。
 * 渡されたバイト列はコピーして使う（pdf.js が buffer を transfer するため）。
 */
export async function detectImageOnlyPdf(
    data: ArrayBuffer | Uint8Array
): Promise<{ imageOnly: boolean; totalTextLength: number }> {
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    const loadingTask = pdfjsLib.getDocument({
        data: bytes,
        cMapUrl: chrome.runtime.getURL('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: chrome.runtime.getURL('standard_fonts/'),
    });
    const pdf = await loadingTask.promise;
    try {
        let total = 0;
        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const textContent = await page.getTextContent();
            for (const item of textContent.items as Array<{ str?: unknown }>) {
                const str = typeof item.str === 'string' ? item.str : '';
                total += str.replace(/\s/g, '').length;
            }
            if (total >= SCANNED_TEXT_THRESHOLD) {
                return { imageOnly: false, totalTextLength: total };
            }
        }
        return { imageOnly: total < SCANNED_TEXT_THRESHOLD, totalTextLength: total };
    } finally {
        try { pdf.destroy(); } catch { /* noop */ }
    }
}
