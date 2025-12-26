// RIS ファイルパーサー

import type { Reference } from './types';

/**
 * RIS タグと Reference フィールドのマッピング
 */
const RIS_TAG_MAP: Record<string, keyof Reference | 'firstAuthor'> = {
    'TI': 'title',
    'T1': 'title',
    'AB': 'abstract',
    'N2': 'abstract',
    'PY': 'year',
    'Y1': 'year',
    'AU': 'authors',
    'A1': 'authors',
    'JO': 'journal',
    'JF': 'journal',
    'T2': 'journal',
    'DO': 'doi',
    'AN': 'pmid',
    'UR': 'url',
    'L1': 'url',
    'DB': 'source',
};

/**
 * RIS ファイルをパースして Reference 配列に変換
 */
export function parseRIS(content: string): Reference[] {
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);

    let currentRecord: Partial<Reference> & { _authors: string[] } = { _authors: [] };
    let currentTag = '';
    let currentValue = '';

    const saveCurrentTag = () => {
        if (currentTag && currentValue) {
            const field = RIS_TAG_MAP[currentTag];
            if (field === 'authors') {
                currentRecord._authors.push(currentValue.trim());
            } else if (field === 'year') {
                // 年部分のみ抽出 (例: "2024/01/15" → 2024)
                const yearMatch = currentValue.match(/\d{4}/);
                if (yearMatch) {
                    currentRecord.year = parseInt(yearMatch[0], 10);
                }
            } else if (field === 'journal') {
                // journal は優先順位付き（JO > JF > T2）
                if (!currentRecord.journal || currentTag === 'JO') {
                    currentRecord.journal = currentValue.trim();
                }
            } else if (field && field !== 'firstAuthor') {
                // 既存値がなければセット
                if (!(field in currentRecord) || !currentRecord[field]) {
                    (currentRecord as Record<string, unknown>)[field] = currentValue.trim();
                }
            }
        }
        currentTag = '';
        currentValue = '';
    };

    const finalizeRecord = () => {
        saveCurrentTag();

        if (currentRecord.title) {
            const ref: Reference = {
                ref_id: crypto.randomUUID(),
                title: currentRecord.title,
                abstract: truncateAbstract(currentRecord.abstract),
                year: currentRecord.year,
                authors: currentRecord._authors.join('; '),
                journal: currentRecord.journal,
                doi: currentRecord.doi,
                pmid: currentRecord.pmid,
                url: currentRecord.url,
                source: currentRecord.source,
                imported_at: new Date().toISOString(),
                dedupe_key: generateDedupeKey(
                    currentRecord.title,
                    currentRecord.year,
                    currentRecord._authors[0],
                    currentRecord.doi
                ),
            };
            references.push(ref);
        }

        currentRecord = { _authors: [] };
    };

    for (const line of lines) {
        // RIS タグ行: "XX  - value"
        const tagMatch = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)/);

        if (tagMatch) {
            saveCurrentTag();
            currentTag = tagMatch[1];
            currentValue = tagMatch[2];

            // ER タグでレコード終了
            if (currentTag === 'ER') {
                finalizeRecord();
            }
        } else if (currentTag && line.startsWith('      ')) {
            // 継続行（6スペースインデント）
            currentValue += ' ' + line.trim();
        }
    }

    // 最後のレコードを処理（ER タグがない場合）
    if (currentRecord.title) {
        finalizeRecord();
    }

    return references;
}

/**
 * Abstract を 15,000 文字に切り詰め
 */
function truncateAbstract(abstract?: string): string | undefined {
    if (!abstract) return undefined;
    if (abstract.length <= 15000) return abstract;
    return abstract.substring(0, 15000) + '...';
}

/**
 * 重複検出キーを生成
 */
function generateDedupeKey(
    title?: string,
    year?: number,
    firstAuthor?: string,
    doi?: string
): string {
    // DOI があれば DOI を優先
    if (doi) {
        return `doi:${doi.toLowerCase()}`;
    }

    const normalizedTitle = normalizeText(title || '').substring(0, 100);
    const normalizedAuthor = normalizeText(extractLastName(firstAuthor || ''));
    const yearStr = year?.toString() || '';

    return `${normalizedTitle}|${yearStr}|${normalizedAuthor}`;
}

/**
 * テキストを正規化（小文字化、記号除去、空白正規化）
 */
function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 著者名から姓を抽出
 */
function extractLastName(author: string): string {
    // "Smith, John" → "Smith"
    // "John Smith" → "Smith"
    const parts = author.split(/[,\s]+/);
    return parts[0] || '';
}

/**
 * ファイルからRISをパース
 */
export async function parseRISFile(file: File): Promise<Reference[]> {
    const content = await file.text();
    return parseRIS(content);
}
