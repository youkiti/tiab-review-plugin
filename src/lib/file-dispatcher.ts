// ファイルフォーマット検出・ディスパッチャー

import type { Reference } from './types';
import { parseRIS } from './ris-parser';
import { parseCTG, isCTGFormat } from './ctg-parser';
import { parseICTRP, isICTRPFormat } from './ictrp-parser';
import { parseEndNoteXML, isEndNoteXMLFormat } from './endnote-xml-parser';
import { parseEndNoteEnl, parseEndNoteEnlp, isEndNoteLibraryFile } from './endnote-enl-parser';

/** サポートするインポート形式 */
export type ImportFormat = 'ris' | 'ctg-csv' | 'ictrp-xml' | 'endnote-xml' | 'unknown';

/**
 * ファイル拡張子からフォーマットを判定
 */
function detectFormatByExtension(filename: string): ImportFormat {
    const ext = filename.toLowerCase().split('.').pop() || '';
    switch (ext) {
        case 'ris':
        case 'nbib':
        case 'txt':
            return 'ris';
        case 'csv':
            return 'ctg-csv';
        case 'xml':
            // XML は EndNote / ICTRP の両方が存在するためコンテンツで確定する
            return 'unknown';
        default:
            return 'unknown';
    }
}

/**
 * コンテンツからフォーマットを検証・判定（フォールバック用）。
 * EndNote のシグナル（<source-app name="EndNote">）は ICTRP の <Trial> より明確なため
 * 先に EndNote をチェックする。
 */
function detectFormatByContent(content: string): ImportFormat {
    if (isEndNoteXMLFormat(content)) return 'endnote-xml';
    if (isCTGFormat(content)) return 'ctg-csv';
    if (isICTRPFormat(content)) return 'ictrp-xml';
    return 'unknown';
}

/**
 * フォーマットに応じてパースを実行
 */
function parseContent(content: string, format: ImportFormat, sourceFile: string): Reference[] {
    switch (format) {
        case 'ris':
            return parseRIS(content, sourceFile);
        case 'ctg-csv':
            return parseCTG(content, sourceFile);
        case 'ictrp-xml':
            return parseICTRP(content, sourceFile);
        case 'endnote-xml':
            return parseEndNoteXML(content, sourceFile);
        default:
            // フォールバック: RIS として試みる
            return parseRIS(content, sourceFile);
    }
}

/**
 * ファイルをインポートするメインエントリポイント
 * 拡張子でフォーマットを判定し、適切なパーサーにディスパッチ
 */
export async function parseImportFile(file: File): Promise<Reference[]> {
    // EndNote のライブラリ（.enl / .enlp）はバイナリ（SQLite / ZIP）なので専用パーサーで処理する。
    const endnoteLib = isEndNoteLibraryFile(file.name);
    if (endnoteLib) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return endnoteLib === 'enlp'
            ? parseEndNoteEnlp(bytes, file.name)
            : parseEndNoteEnl(bytes, file.name);
    }

    const content = await file.text();
    let format = detectFormatByExtension(file.name);

    // 拡張子で判定できない場合、コンテンツから判定
    if (format === 'unknown') {
        format = detectFormatByContent(content);
    }

    // CSV の場合、コンテンツが CTG 形式か検証
    if (format === 'ctg-csv' && !isCTGFormat(content)) {
        // CTG形式でないCSVはRISとしてフォールバック
        console.warn('[parseImportFile] CSVファイルですが ClinicalTrials.gov 形式ではありません。RISとして処理を試みます。');
        format = 'ris';
    }

    // XML の場合、最終的に EndNote / ICTRP のいずれでもなければ RIS フォールバック
    if (format === 'unknown') {
        const ext = file.name.toLowerCase().split('.').pop() || '';
        if (ext === 'xml') {
            console.warn('[parseImportFile] XMLファイルですが EndNote / ICTRP のいずれの形式でもありません。RISとして処理を試みます。');
            format = 'ris';
        }
    }

    return parseContent(content, format, file.name);
}
