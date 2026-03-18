// ファイルフォーマット検出・ディスパッチャー

import type { Reference } from './types';
import { parseRIS } from './ris-parser';
import { parseCTG, isCTGFormat } from './ctg-parser';
import { parseICTRP, isICTRPFormat } from './ictrp-parser';

/** サポートするインポート形式 */
export type ImportFormat = 'ris' | 'ctg-csv' | 'ictrp-xml' | 'unknown';

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
            return 'ictrp-xml';
        default:
            return 'unknown';
    }
}

/**
 * コンテンツからフォーマットを検証・判定（フォールバック用）
 */
function detectFormatByContent(content: string): ImportFormat {
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

    // XML の場合、コンテンツが ICTRP 形式か検証
    if (format === 'ictrp-xml' && !isICTRPFormat(content)) {
        console.warn('[parseImportFile] XMLファイルですが ICTRP 形式ではありません。RISとして処理を試みます。');
        format = 'ris';
    }

    return parseContent(content, format, file.name);
}
