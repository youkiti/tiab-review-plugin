// Node の PDF.js で開いた文書を拡張と共通の抽出・整形関数に渡す。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextFromPdfDocument, prepareFulltextForTypeSafe } from '../../src/lib/pdf-text-extract';
import { SCANNED_TEXT_THRESHOLD } from '../../src/lib/pdf-constants';

const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<{ getDocument: typeof getDocument }>;
export async function extractPdf(file: string) {
    const root = path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [process.cwd()] }));
    const pdfjs = await importEsm(pathToFileURL(path.join(root, 'legacy/build/pdf.mjs')).href);
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)),
        cMapUrl: path.join(root, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true,
        standardFontDataUrl: path.join(root, 'standard_fonts').replace(/\\/g, '/') + '/' });
    try {
        const document = await loadingTask.promise;
        const extracted = await extractTextFromPdfDocument(document);
        return { ...prepareFulltextForTypeSafe(extracted.text), totalTextLength: extracted.totalTextLength,
            imageOnly: extracted.totalTextLength < SCANNED_TEXT_THRESHOLD };
    } finally {
        await loadingTask.destroy();
    }
}
