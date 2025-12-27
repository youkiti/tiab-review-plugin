// RIS ファイルパーサー

import type { Reference } from './types';

/**
 * RIS タグと Reference フィールドのマッピング
 */
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
    'DP': 'year', // PubMed Date of Publication
    'AU': 'authors',
    'A1': 'authors',
    'FAU': 'authors', // PubMed Full Author
    'JO': 'journal',
    'JF': 'journal',
    'T2': 'journal',
    'TA': 'journal', // PubMed Journal Title Abbreviation
    'JT': 'journal', // PubMed Journal Title
    'DO': 'doi',
    'LID': 'doi', // PubMed Location Identifier (often DOI)
    'AN': 'pmid',
    'PMID': 'pmid', // PubMed ID
    'UR': 'url',
    'L1': 'url',
    'DB': 'source',
};

/**
 * RIS ファイルをパースして Reference 配列に変換
 */
export function parseRIS(content: string, sourceFile?: string): Reference[] {
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
                // 年部分のみ抽出 (例: "2024/01/15" → 2024, "2025 Nov" -> 2025)
                const yearMatch = currentValue.match(/\d{4}/);
                if (yearMatch) {
                    currentRecord.year = parseInt(yearMatch[0], 10);
                }
            } else if (field === 'journal') {
                // journal は優先順位付き（JO > JF > T2 > TA > JT）
                // 既存がある場合、短い略称よりも正式名称などを優先したいが、
                // 単純に上書きせず、空なら入れる戦略にするか、タグの優先度を見るか。
                // ここでは単純に後勝ちにするが、PubMedの場合は TA, JT などがある。
                if (!currentRecord.journal || currentTag === 'JO' || currentTag === 'JT') {
                    currentRecord.journal = currentValue.trim();
                }
            } else if (field === 'doi') {
                // LID - 10.7759/cureus.96660 [doi] みたいな形式への対応
                let doi = currentValue.trim();
                const doiMatch = doi.match(/^(\S+)\s*\[doi\]$/); // [doi] suffix removal
                if (doiMatch) {
                    doi = doiMatch[1];
                }
                currentRecord.doi = doi;
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
                source_file: sourceFile,
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
        // RIS タグ: "XX  - value" (2 chars)
        // PubMed (NBIB): "PMID- value" (4 chars), "TI  - value" (2 chars + spaces)
        // 汎用的な正規表現: (Tag) + (spaces/dash) + (value)

        // Tag catch: Start of line, non-whitespace characters, followed by whitespace or dash
        const tagMatch = line.match(/^([A-Z0-9]+)\s*-\s?(.*)/);

        if (tagMatch) {
            // Check if it looks like a tag (uppercase alphanumeric)
            // Some descriptions might start with something looking like a tag, but usually they are indented.
            // Regex enforces start of line.

            saveCurrentTag();
            currentTag = tagMatch[1].trim(); // Trim just in case
            currentValue = tagMatch[2];

            // ER タグでレコード終了 (RIS)
            if (currentTag === 'ER') {
                finalizeRecord();
            }
        } else if (currentTag && line.startsWith('      ')) {
            // 継続行（NBIBは6スペースインデントが多い）
            currentValue += ' ' + line.trim();
        } else if (currentTag && line.startsWith(' ')) {
            // RISの継続行もインデントされていることが一般的だが、幅はまちまち
            // ここでは単純にインデントがあれば継続とみなす
            currentValue += ' ' + line.trim();
        } else if (line.trim() === '') {
            // 空行は無視 (NBIBはレコード間に空行が入ることがある)
            // RISもレコード間に空行が入ることがある
            // 特に区切りとして使われている場合、ここでリセットすべき？
            // NBIBの場合、空行でレコード区切りの場合があるが、RISはER必須。
            // PubMed形式は明確な終了タグがない場合がある（空行区切り）。

            // 下記ロジックだと、次のタグが来た時に前のレコードのタグとして処理されてしまう可能性があるが、
            // currentTagが空になるので saveCurrentTag() は空振りする。
            // ただし、もし前のレコードの続きではなく新しいレコードの開始だった場合、
            // finalizeRecordが呼ばれていないのでデータが混ざる。

            // NBIB (PubMed) format is separated by blank lines usually.
            // However, relying on blank lines is risky if descriptions have blank lines.
            // But usually fields don't have blank lines inside.

            // 安全策：次の行が PMID などの開始タグなら finalize する方が良いが、
            // 逐次処理なので先読みは面倒。
            // 空行が来たらレコード終了とみなす（PubMed形式の場合）。
            // RIS形式の場合、ERがあるのでそこで切れるが、空行があっても害はない（はず）。
            // ただし、レコード内のフィールド間に空行が入る変則的なファイルだと壊れる。
            // 一般的なフォーマット仕様として、空行はレコード区切りとみなして良いか？
            // PubMed format: "each record is separated by a blank line"
            if (currentTag) {
                saveCurrentTag();
            }
            if (currentRecord.title || currentRecord.pmid) {
                finalizeRecord();
            }
        }
    }

    // 最後のレコードを処理（ER タグがない場合）
    if (currentRecord.title || (currentRecord as any).pmid) { // PMIDだけでもある程度許容
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
    return parseRIS(content, file.name);
}
