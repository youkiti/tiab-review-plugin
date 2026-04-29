// EndNote XML パーサー
//
// EndNote XML（公式 DTD）からエクスポートされた文献を Reference に変換する。
// - DOI:    <electronic-resource-num>（公式 DTD で DOI 用）
// - ISSN:   <isbn>（EndNote の DTD は ISSN 専用フィールドを持たず、ISBN フィールドに格納される）
// - issue:  <number>。存在しない場合は <volume> の "6(2)" 形式から抽出（Embase 経由のエクスポート対応）
// - pmid:   <accession-num>（ただし <remote-database-name> が PubMed の場合のみ）
// - journal: <periodical><full-title> を優先、無ければ <titles><secondary-title>
// テキスト値は <style face="..." font="..." size="...">value</style> でラップされているが
// Element.textContent でそのまま取得できる。

import type { Reference } from './types';
import { truncateAuthors, truncateAbstract, truncateField, generateDedupeKey } from './import-helpers';

/** 第1子要素の textContent を取り出す（trim 済み）。無ければ空文字。 */
function getChildText(parent: Element, tagName: string): string {
    // querySelector は子孫を探索するため、ネストした同名タグも拾える。
    // EndNote では同一階層に同名タグは1個しか出現しない構造なので問題ない。
    const el = parent.querySelector(tagName);
    return el?.textContent?.trim() || '';
}

/** EndNote の <volume> "6(2)" 形式から volume と issue を分離する */
function splitVolumeIssue(volumeText: string): { volume: string; issue: string } {
    const m = volumeText.match(/^([^(]+?)\s*\(\s*([^)]+?)\s*\)\s*$/);
    if (m) {
        return { volume: m[1].trim(), issue: m[2].trim() };
    }
    return { volume: volumeText.trim(), issue: '' };
}

/** ISSN 形式かどうかの簡易判定（XXXX-XXXX または XXXXXXXX、末尾は数字またはX） */
function isIssnLike(value: string): boolean {
    const v = value.trim();
    return /^\d{4}-?\d{3}[\dXx]$/.test(v);
}

/** DOI 文字列の末尾に付くことがある "[doi]" 等のサフィックスを除去 */
function cleanDoi(raw: string): string {
    const m = raw.match(/^(\S+)\s*\[doi\]\s*$/i);
    return (m ? m[1] : raw).trim();
}

/** record 要素から Reference に変換 */
function recordToReference(record: Element, sourceFile?: string): Reference | null {
    // タイトル（必須）。<titles><title>
    const titlesEl = record.querySelector('titles');
    const title = titlesEl ? (titlesEl.querySelector('title')?.textContent?.trim() || '') : '';
    if (!title) return null;

    // 著者
    const authorEls = record.querySelectorAll('contributors > authors > author');
    const authors: string[] = [];
    authorEls.forEach(a => {
        const name = a.textContent?.trim();
        if (name) authors.push(name);
    });

    // 年
    const yearText = record.querySelector('dates > year')?.textContent?.trim() || '';
    const yearMatch = yearText.match(/\d{4}/);
    const year = yearMatch ? parseInt(yearMatch[0], 10) : undefined;

    // ジャーナル: <periodical><full-title> 優先 → <titles><secondary-title>
    const fullTitle = record.querySelector('periodical > full-title')?.textContent?.trim() || '';
    const secondaryTitle = titlesEl?.querySelector('secondary-title')?.textContent?.trim() || '';
    const journal = fullTitle || secondaryTitle || '';

    // volume / issue
    const volumeRaw = getChildText(record, 'volume');
    const numberRaw = getChildText(record, 'number');
    let volume = volumeRaw;
    let issue = numberRaw;
    if (!issue && volumeRaw) {
        const split = splitVolumeIssue(volumeRaw);
        volume = split.volume;
        issue = split.issue;
    }

    // pages
    const pages = getChildText(record, 'pages');

    // ISSN: <isbn> に ISSN 形式が入っているケースのみ採用
    const isbnText = getChildText(record, 'isbn');
    const issn = isIssnLike(isbnText) ? isbnText : '';

    // DOI: <electronic-resource-num>
    const doiRaw = getChildText(record, 'electronic-resource-num');
    const doi = doiRaw ? cleanDoi(doiRaw) : '';

    // accession-num: <remote-database-name> が PubMed の場合のみ pmid に格納
    const accessionNum = getChildText(record, 'accession-num');
    const remoteDb = getChildText(record, 'remote-database-name');
    const isPubMed = /pubmed/i.test(remoteDb);
    const pmid = (isPubMed && accessionNum) ? accessionNum : '';

    // URL: 最初の <urls><related-urls><url>
    const urlEl = record.querySelector('urls > related-urls > url');
    const url = urlEl?.textContent?.trim() || '';

    // abstract
    const abstract = getChildText(record, 'abstract');

    // source: <remote-database-name> があればそれ、無ければ "EndNote"
    const source = remoteDb || 'EndNote';

    return {
        ref_id: crypto.randomUUID(),
        title: truncateField(title)!,
        abstract: truncateAbstract(abstract || undefined),
        year,
        authors: authors.length > 0 ? truncateAuthors(authors) : undefined,
        journal: truncateField(journal || undefined),
        volume: truncateField(volume || undefined),
        issue: truncateField(issue || undefined),
        pages: truncateField(pages || undefined),
        issn: truncateField(issn || undefined),
        doi: truncateField(doi || undefined),
        pmid: truncateField(pmid || undefined),
        url: truncateField(url || undefined),
        source: truncateField(source),
        source_file: truncateField(sourceFile),
        imported_at: new Date().toISOString(),
        dedupe_key: generateDedupeKey(title, pmid || undefined, doi || undefined),
    };
}

/** EndNote XML コンテンツをパースして Reference 配列に変換 */
export function parseEndNoteXML(content: string, sourceFile?: string): Reference[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        console.error('[parseEndNoteXML] XML parse error:', parseError.textContent);
        return [];
    }

    const records = doc.querySelectorAll('records > record');
    const references: Reference[] = [];

    records.forEach(record => {
        const ref = recordToReference(record, sourceFile);
        if (ref) references.push(ref);
    });

    return references;
}

/** EndNote XML ファイルをパース */
export async function parseEndNoteXMLFile(file: File): Promise<Reference[]> {
    const content = await file.text();
    return parseEndNoteXML(content, file.name);
}

/**
 * XML コンテンツが EndNote 形式かどうか判定。
 * EndNote は <source-app name="EndNote" ...> を必ず出力する。念のため
 * <xml><records><record> のルート構造でもフォールバック判定する。
 */
export function isEndNoteXMLFormat(content: string): boolean {
    if (/<source-app[^>]*name=["']EndNote["']/i.test(content)) return true;
    // ルート要素 <xml> 配下に <records> があり、その中に <record> がある場合
    if (/<xml[^>]*>\s*<records[^>]*>\s*<record[^>]*>/i.test(content)) return true;
    return false;
}
