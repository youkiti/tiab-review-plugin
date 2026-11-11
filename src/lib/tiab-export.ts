/**
 * TiAb エクスポート（CSV/RIS）の本文の組み立て（純関数）
 *
 * state・通信・DOM に依存しない。画面側（sidepanel/features/import-export.ts）は
 * ファイル名・reviewerKeys の算出・トースト・ダウンロード（BOM の付与を含む）を持ち、
 * 本文だけをここへ任せる。列の仕様は src/lib/sheets/AGENTS.md の
 * 「TiAb エクスポート（CSV/RIS）の判定者別列」を参照。
 * シートの行から出力までの通しの検査は tests/manuscript-e2e.test.ts にある。
 */

import { escapeCSVField } from './csv';
import { summarizeTeamDecision, formatDecisionNotes } from './decision-summary';
import type { AssignmentConfig, ReferenceWithStatus } from './types';

export interface TiabExportOptions {
    /** !state.isKeyOpened。ブラインド中は判定者別の列・行を出さない */
    isBlinded: boolean;
    /** ブラインド中は [] */
    reviewerKeys: string[];
    treatMlAsManual: boolean;
    assignmentConfig: AssignmentConfig;
}

/** ヘッダー行つき。改行は \r\n、BOM なし（BOM はダウンロード時に画面側が付ける） */
export function buildTiabExportCsv(refs: ReferenceWithStatus[], options: TiabExportOptions): string {
    const { isBlinded, reviewerKeys, treatMlAsManual, assignmentConfig } = options;

    // CSVヘッダー
    // status は現状の値のまま（既存CSVとの互換のため変更しない）。team_status が新定義。
    const headers = [
        'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'issn',
        'doi', 'pmid', 'status', 'team_status', 'n_judged', 'n_expected',
        ...(isBlinded ? [] : reviewerKeys),
        ...(isBlinded ? [] : ['decision_notes']),
        'note', 'source_file',
    ];

    // CSVデータを構築
    const csvRows: string[] = [];
    csvRows.push(headers.map(escapeCSVField).join(','));

    for (const ref of refs) {
        let teamStatusCell = 'blinded';
        let nJudgedCell = '';
        let nExpectedCell = '';
        let reviewerCells: string[] = [];
        let decisionNotesCell = '';

        if (!isBlinded) {
            const { teamStatus, nJudged, nExpected, byReviewer } = summarizeTeamDecision(
                ref, reviewerKeys, treatMlAsManual, assignmentConfig
            );
            teamStatusCell = teamStatus;
            nJudgedCell = String(nJudged);
            nExpectedCell = String(nExpected);
            reviewerCells = reviewerKeys.map(key => byReviewer.get(key)?.decision || '');
            decisionNotesCell = formatDecisionNotes(byReviewer, reviewerKeys);
        }

        const row = [
            ref.title || '',
            ref.authors || '',
            ref.year?.toString() || '',
            ref.journal || '',
            ref.volume || '',
            ref.issue || '',
            ref.pages || '',
            ref.issn || '',
            ref.doi || '',
            ref.pmid || '',
            ref.status || '',
            teamStatusCell,
            nJudgedCell,
            nExpectedCell,
            ...(isBlinded ? [] : reviewerCells),
            ...(isBlinded ? [] : [decisionNotesCell]),
            ref.myDecision?.note || '',
            ref.source_file || '',
        ];
        csvRows.push(row.map(escapeCSVField).join(','));
    }
    return csvRows.join('\r\n');
}

/** 改行は \r\n、BOM なし */
export function buildTiabExportRis(refs: ReferenceWithStatus[], options: TiabExportOptions): string {
    const { isBlinded, reviewerKeys, treatMlAsManual, assignmentConfig } = options;

    const risLines: string[] = [];

    for (const ref of refs) {
        risLines.push('TY  - JOUR');
        if (ref.title) risLines.push(`TI  - ${ref.title}`);

        if (ref.authors) {
            const authors = ref.authors.split(/;\s*/);
            for (const author of authors) {
                if (author && author !== 'et al.') {
                    risLines.push(`AU  - ${author.trim()}`);
                }
            }
        }

        if (ref.year) risLines.push(`PY  - ${ref.year}`);
        if (ref.journal) risLines.push(`JO  - ${ref.journal}`);
        if (ref.volume) risLines.push(`VL  - ${ref.volume}`);
        if (ref.issue) risLines.push(`IS  - ${ref.issue}`);

        if (ref.pages) {
            const pageMatch = ref.pages.match(/^(\d+)\s*-\s*(\d+)$/);
            if (pageMatch) {
                risLines.push(`SP  - ${pageMatch[1]}`);
                risLines.push(`EP  - ${pageMatch[2]}`);
            } else {
                risLines.push(`SP  - ${ref.pages}`);
            }
        }

        if (ref.issn) risLines.push(`SN  - ${ref.issn}`);
        if (ref.doi) risLines.push(`DO  - ${ref.doi}`);
        if (ref.pmid) risLines.push(`AN  - ${ref.pmid}`);
        if (ref.abstract) risLines.push(`AB  - ${ref.abstract}`);

        // URL
        if (ref.pmid) {
            risLines.push(`UR  - https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`);
        } else if (ref.doi) {
            risLines.push(`UR  - https://doi.org/${ref.doi}`);
        }

        // カスタムフィールド
        if (ref.myDecision?.note) {
            risLines.push(`N1  - ${ref.myDecision.note}`);
        }
        if (ref.status) {
            risLines.push(`C1  - Status: ${ref.status}`);
        }
        if (isBlinded) {
            risLines.push('C1  - Team status: blinded');
        } else {
            const { teamStatus, byReviewer } = summarizeTeamDecision(
                ref, reviewerKeys, treatMlAsManual, assignmentConfig
            );
            risLines.push(`C1  - Team status: ${teamStatus}`);

            if (byReviewer.size > 0) {
                const decisionsText = reviewerKeys
                    .map(key => {
                        const d = byReviewer.get(key);
                        return d ? `${key}=${d.decision}` : null;
                    })
                    .filter((entry): entry is string => Boolean(entry))
                    .join('; ');
                risLines.push(`C2  - Decisions: ${decisionsText}`);
            }
        }
        if (ref.source_file) {
            risLines.push(`DB  - ${ref.source_file}`);
        }

        risLines.push('ER  - ');
        risLines.push('');
    }
    return risLines.join('\r\n');
}
