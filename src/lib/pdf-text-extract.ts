// PDF の構造型から本文を組み立て、全文判定用のテキストを整形する。
// ブラウザや PDF ライブラリに依存せず、評価スクリプトからも利用できる。

export const FULLTEXT_TEXT_MAX_CHARS = 85000;
export const REFERENCES_MIN_POSITION_RATIO = 0.4;

interface PdfTextDocument {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}

export async function extractTextFromPdfDocument(pdf: PdfTextDocument) {
    const pages: string[] = [];
    let totalTextLength = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
            const value = item !== null && typeof item === 'object'
                ? item as { str?: unknown; hasEOL?: unknown } : {};
            const str = typeof value.str === 'string' ? value.str : '';
            totalTextLength += str.replace(/\s/g, '').length;
            text += str;
            if (value.hasEOL === true) {
                text += '\n';
            }
        }
        pages.push(text);
    }
    return { text: pages.join('\n\n'), totalTextLength, numPages: pdf.numPages };
}

export function prepareFulltextForTypeSafe(rawText: string, maxChars = FULLTEXT_TEXT_MAX_CHARS) {
    const rawLength = rawText.length;
    let text = rawText.split(/\r?\n/).map(line => line.trim().replace(/[ \t]+/g, ' '))
        .join('\n').replace(/\n{4,}/g, '\n\n');
    // ローマ数字の番号は後ろの「.」を必須にする（i フラグで語の一部を番号と読まないため）。
    const heading = /^(?:\d+\.?\s*|[IVXLCDM]+\.\s*)?(?:references|reference list|bibliography|literature cited|works cited|参考文献|引用文献|文献):?$/i;
    let offset = 0;
    let referencesStart = -1;
    for (const line of text.split('\n')) {
        if (offset >= text.length * REFERENCES_MIN_POSITION_RATIO && heading.test(line)) {
            referencesStart = offset;
        }
        offset += line.length + 1;
    }
    const referencesRemoved = referencesStart >= 0;
    if (referencesRemoved) {
        text = text.slice(0, referencesStart).trimEnd();
    }
    const truncated = text.length > maxChars;
    return { text: text.slice(0, maxChars), referencesRemoved, truncated, rawLength };
}
