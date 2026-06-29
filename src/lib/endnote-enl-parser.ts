// EndNote ライブラリ（.enl / .enlp）パーサー
//
// EndNote の .enl は SQLite データベース。参照テーブル（バージョンにより "refs" または
// "enl_refs"。カラム構成は同一）を 1 つ読み、各行を Reference に変換する。
// .enlp はそれを含む ZIP アーカイブなので、解凍して中の .enl を取り出してから同じ処理を行う。
//
// 列マッピング（EndNote のフィールド名がそのまま列名になっている）:
// - author:                      著者（複数は CR/LF 区切りの "Last, First"）
// - secondary_title:             ジャーナル名
// - number:                      issue（空なら volume の "6(2)" 形式から抽出）
// - isbn:                        ISSN が "0140-6736 (Print)\r..." の形で入る
// - electronic_resource_number:  DOI
// - accession_number:            PubMed 由来なら PMID
// - name_of_database:            出典データベース名

import type { Reference } from './types';
import { truncateAuthors, truncateAbstract, truncateField, generateDedupeKey } from './import-helpers';
import { openSqlite, type SqlValue } from './sqlite-reader';
import { unzip } from './zip-reader';

/** 参照テーブルの候補名（バージョン差）。いずれも無ければ列構成から推定する。 */
const REF_TABLE_NAMES = ['refs', 'enl_refs'];

function asString(v: SqlValue | undefined): string {
    return typeof v === 'string' ? v.trim() : '';
}

/** CR/LF 区切りの値を配列にする（EndNote の著者・キーワード等） */
function splitMulti(value: string): string[] {
    return value.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
}

/** EndNote の volume "6(2)" 形式から volume と issue を分離する */
function splitVolumeIssue(volumeText: string): { volume: string; issue: string } {
    const m = volumeText.match(/^([^(]+?)\s*\(\s*([^)]+?)\s*\)\s*$/);
    if (m) return { volume: m[1].trim(), issue: m[2].trim() };
    return { volume: volumeText.trim(), issue: '' };
}

/** ISSN 形式かどうかの簡易判定（XXXX-XXXX または XXXXXXXX、末尾は数字または X） */
function isIssnLike(value: string): boolean {
    return /^\d{4}-?\d{3}[\dXx]$/.test(value.trim());
}

/** isbn 列（"0140-6736 (Print)\r0140-6736 (Linking)" 等）から最初の ISSN を取り出す */
function extractIssn(isbnField: string): string {
    for (const token of splitMulti(isbnField)) {
        // " (Print)" 等の注記を除去
        const cleaned = token.replace(/\s*\(.*?\)\s*$/, '').trim();
        if (isIssnLike(cleaned)) return cleaned;
    }
    return '';
}

/** DOI 文字列末尾の "[doi]" 等のサフィックスを除去 */
function cleanDoi(raw: string): string {
    const m = raw.match(/^(\S+)\s*\[doi\]\s*$/i);
    return (m ? m[1] : raw).trim();
}

/** accession_number が PMID とみなせるか（数字のみ かつ PubMed 由来のシグナルがある） */
function looksLikePmid(accession: string, dbName: string, url: string): boolean {
    if (!/^\d+$/.test(accession)) return false;
    if (/pubmed|medline/i.test(dbName)) return true;
    if (/\/pubmed\/|ncbi\.nlm\.nih\.gov/i.test(url)) return true;
    return false;
}

/** 参照テーブルの 1 行を Reference に変換（不可なら null） */
function rowToReference(row: Record<string, SqlValue>, sourceFile?: string): Reference | null {
    // ゴミ箱（trash_state !== 0）はスキップ
    const trash = row['trash_state'];
    if (typeof trash === 'number' && trash !== 0) return null;

    const title = asString(row['title']);
    if (!title) return null;

    const authors = splitMulti(asString(row['author']));

    // 年: year 列優先、無ければ date 列から 4 桁を抽出
    const yearRaw = asString(row['year']) || asString(row['date']);
    const yearMatch = yearRaw.match(/\d{4}/);
    const year = yearMatch ? parseInt(yearMatch[0], 10) : undefined;

    const journal = asString(row['secondary_title']);

    const volumeRaw = asString(row['volume']);
    const numberRaw = asString(row['number']);
    let volume = volumeRaw;
    let issue = numberRaw;
    if (!issue && volumeRaw) {
        const split = splitVolumeIssue(volumeRaw);
        volume = split.volume;
        issue = split.issue;
    }

    const pages = asString(row['pages']);
    const issn = extractIssn(asString(row['isbn']));

    const doiRaw = asString(row['electronic_resource_number']);
    const doi = doiRaw ? cleanDoi(doiRaw) : '';

    const url = asString(row['url']);
    const dbName = asString(row['name_of_database']);
    const accession = asString(row['accession_number']);
    const pmid = looksLikePmid(accession, dbName, url) ? accession : '';

    const abstract = asString(row['abstract']);
    const source = dbName || 'EndNote';

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

/** SQLite データベース中から参照テーブルを特定する */
function findRefTable(db: ReturnType<typeof openSqlite>): string | null {
    for (const name of REF_TABLE_NAMES) {
        if (db.tableNames.includes(name)) return name;
    }
    // 名前が想定外でも、参照らしい列を持つテーブルを探す
    for (const name of db.tableNames) {
        const t = db.getTable(name);
        if (!t) continue;
        const cols = new Set(t.columns);
        if (cols.has('title') && cols.has('author') && cols.has('secondary_title')) return name;
    }
    return null;
}

/** EndNote .enl（SQLite バイト列）をパースして Reference 配列に変換 */
export function parseEndNoteEnl(data: Uint8Array, sourceFile?: string): Reference[] {
    const db = openSqlite(data);
    const tableName = findRefTable(db);
    if (!tableName) {
        throw new Error('EndNote library: reference table not found');
    }
    const table = db.getTable(tableName);
    if (!table) return [];

    const references: Reference[] = [];
    for (const row of table.rows) {
        const ref = rowToReference(row, sourceFile);
        if (ref) references.push(ref);
    }
    return references;
}

/** EndNote .enlp（ZIP）をパース。中の .enl を取り出して parseEndNoteEnl に委譲する */
export async function parseEndNoteEnlp(data: Uint8Array, sourceFile?: string): Promise<Reference[]> {
    const files = await unzip(data);
    // .enl 拡張子かつ SQLite マジックを持つエントリを探す（__MACOSX や .Data/*.eni を除外）
    let enl: Uint8Array | undefined;
    for (const [name, bytes] of files) {
        if (name.includes('__MACOSX/')) continue;
        if (!/\.enl$/i.test(name)) continue;
        if (!hasSqliteMagic(bytes)) continue;
        enl = bytes;
        break;
    }
    if (!enl) {
        throw new Error('EndNote .enlp: no .enl database found inside the package');
    }
    return parseEndNoteEnl(enl, sourceFile);
}

/** 先頭 15 バイトが SQLite マジックか */
function hasSqliteMagic(bytes: Uint8Array): boolean {
    if (bytes.length < 16) return false;
    return new TextDecoder('latin1').decode(bytes.subarray(0, 15)) === 'SQLite format 3';
}

/** 拡張子が EndNote ライブラリ（.enl / .enlp）か */
export function isEndNoteLibraryFile(filename: string): 'enl' | 'enlp' | null {
    const ext = filename.toLowerCase().split('.').pop() || '';
    if (ext === 'enl') return 'enl';
    if (ext === 'enlp') return 'enlp';
    return null;
}
