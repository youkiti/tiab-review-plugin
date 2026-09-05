// publication-candidates.ts - Publication_Candidates タブの読み書き（論文候補の保存契約）
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema を参照。
// 候補の重複除去（filterNewCandidates）は ../publication-suggest を参照。

import type { PublicationCandidate, PublicationCandidateStrategy, PublicationCandidateStatus } from '../types';
import { filterNewCandidates } from '../publication-suggest';
import type { PublicationCandidateDraft } from '../publication-suggest';
import {
    getSheetValues,
    appendRows,
    updateRange,
    addSheet,
    batchUpdateRanges,
} from './transport';
import {
    PUBLICATION_CANDIDATES_SHEET,
    PUBLICATION_CANDIDATES_HEADERS,
    PUBLICATION_CANDIDATES_LAST_COLUMN,
    columnNumberToLetter,
} from './schema';

/**
 * Publication_Candidates シートを初期化（存在しない場合）
 * ensureLlmRunsSheet() と完全に同じ ensure パターン（ヘッダー欠落は末尾へ追記、
 * タブ欠落は addSheet → ヘッダー append、それ以外の例外は再送出）。
 * Issue #118 チャンク2 パスB（レジストリ連携フェーズ1: 論文候補探索）で追加。
 */
export async function ensurePublicationCandidatesSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${PUBLICATION_CANDIDATES_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, PUBLICATION_CANDIDATES_SHEET, [PUBLICATION_CANDIDATES_HEADERS]);
            return;
        }

        const missingHeaders = PUBLICATION_CANDIDATES_HEADERS.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
            const newHeaders = [...existingHeaders, ...missingHeaders];
            const startCol = columnNumberToLetter(existingHeaders.length);
            const endCol = columnNumberToLetter(newHeaders.length - 1);
            await updateRange(
                spreadsheetId,
                `${PUBLICATION_CANDIDATES_SHEET}!${startCol}1:${endCol}1`,
                [missingHeaders]
            );
            console.log(`[ensurePublicationCandidatesSheet] Added missing columns: ${missingHeaders.join(', ')}`);
        }
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[ensurePublicationCandidatesSheet] Creating Publication_Candidates sheet...');
            await addSheet(spreadsheetId, PUBLICATION_CANDIDATES_SHEET);
            await appendRows(spreadsheetId, PUBLICATION_CANDIDATES_SHEET, [PUBLICATION_CANDIDATES_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * Publication_Candidates シートの全行を読む（ensure は呼ばない内部専用ヘルパー）。
 * savePublicationCandidates() が自分で ensure 済みの直後に使うため、ここで二重に
 * ensurePublicationCandidatesSheet() を呼ばないよう分離している（1行の候補保存のたびに
 * ensure→全行読み取り→ensure(二重)→appendRows という無駄なリクエストが積み重なり、
 * registration行が多いプロジェクトでSheets APIの読み取りクォータを焼き切っていたため）。
 * 失敗時は例外をそのまま投げる（呼び出し側の savePublicationCandidates() 経由で
 * さらに呼び出し元の try/catch に委ねる。ここで握りつぶすと「既存候補が読めなかった」
 * ことに気付けないまま重複候補を書きかねない）。
 */
async function readPublicationCandidatesRows(spreadsheetId: string): Promise<PublicationCandidate[]> {
    const values = await getSheetValues(spreadsheetId, `${PUBLICATION_CANDIDATES_SHEET}!A:${PUBLICATION_CANDIDATES_LAST_COLUMN}`);

    if (values.length <= 1) return [];

    const headers = values[0];
    const rows = values.slice(1);

    return rows.map(row => {
        const candidate: Record<string, unknown> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            switch (header) {
                case 'year':
                    candidate[header] = value ? parseInt(value, 10) : undefined;
                    break;
                case 'pmid':
                case 'doi':
                case 'title':
                case 'journal':
                case 'decided_by':
                case 'decided_at':
                case 'imported_ref_id':
                    candidate[header] = value || undefined;
                    break;
                case 'strategy':
                    candidate[header] = value as PublicationCandidateStrategy;
                    break;
                case 'status':
                    candidate[header] = (value || 'suggested') as PublicationCandidateStatus;
                    break;
                default:
                    candidate[header] = value;
            }
        });
        return candidate as unknown as PublicationCandidate;
    });
}

/**
 * 論文候補を Publication_Candidates シートへ保存する。
 *
 * ensure → 既存行を読んで（readPublicationCandidatesRows、ensureは呼ばない） filterNewCandidates()
 * で重複除去 → 残りを appendRows。「一括検索を2回流しても行が重複しない」ことがこの重複除去の目的
 * （既に記録済みの候補は再度渡されても書き込まない）。
 *
 * 呼び出し側（fulltext-tab.ts）は候補をため込んで、一括検索1回につき数回（5件ごとのflush単位）
 * だけこの関数を呼ぶこと。registration行1件ごとに呼ぶとリクエスト数が行数に比例して膨らみ、
 * Sheets APIの読み取りクォータ（ユーザーあたり毎分60読み取り）を容易に超える。
 *
 * 行の組み立ては saveLlmExecution() と同じ位置ベース（ヘッダ名は見ない。PUBLICATION_CANDIDATES_HEADERS
 * の並びと1対1で対応させる）。candidate_id は crypto.randomUUID()、status は常に 'suggested'、
 * suggested_at は呼び出し時点の ISO 8601。decided_by/decided_at/imported_ref_id はチャンク3で使う列
 * のため、このチャンクでは常に空文字で書く。
 */
export async function savePublicationCandidates(
    spreadsheetId: string,
    candidates: PublicationCandidateDraft[]
): Promise<void> {
    if (candidates.length === 0) return;

    await ensurePublicationCandidatesSheet(spreadsheetId);

    const existing = await readPublicationCandidatesRows(spreadsheetId);
    const newCandidates = filterNewCandidates(existing, candidates);
    if (newCandidates.length === 0) return;

    const suggestedAt = new Date().toISOString();
    const rows = newCandidates.map(candidate => [
        crypto.randomUUID(),
        candidate.refId,
        candidate.trialId,
        candidate.pmid ?? '',
        candidate.doi ?? '',
        candidate.title ?? '',
        candidate.journal ?? '',
        candidate.year?.toString() ?? '',
        candidate.strategy,
        'suggested',
        suggestedAt,
        '', // decided_by（チャンク3で使用）
        '', // decided_at（チャンク3で使用）
        '', // imported_ref_id（チャンク3で使用）
    ]);

    await appendRows(spreadsheetId, PUBLICATION_CANDIDATES_SHEET, rows);
}

/**
 * Publication_Candidates シートの全行を取得する（ヘッダ駆動。getLlmExecutions() と同じ流儀）。
 * チャンク3（候補パネル表示）向けの公開API。ensure してから読む。失敗時は空配列を返す
 * （getLlmExecutions() と同じ「読み取り単体は失敗を握りつぶす」流儀）。
 */
export async function getPublicationCandidates(spreadsheetId: string): Promise<PublicationCandidate[]> {
    try {
        await ensurePublicationCandidatesSheet(spreadsheetId);
        return await readPublicationCandidatesRows(spreadsheetId);
    } catch (error) {
        console.error('[getPublicationCandidates] Error:', error);
        return [];
    }
}

/** updatePublicationCandidateStatus() の1件分の更新指示 */
export interface PublicationCandidateStatusUpdate {
    candidateId: string;
    status: Extract<PublicationCandidateStatus, 'imported' | 'dismissed'>;
    decidedBy: string;
    /** 'imported' のときのみ渡す想定。省略時（'dismissed' 等）は imported_ref_id 列を空文字で書く */
    importedRefId?: string;
}

/**
 * Publication_Candidates シートの候補ステータス（取り込み/棄却）を一括更新する
 * （Issue #118 チャンク3）。
 *
 * candidate_id 列で行を特定し、status / decided_by / decided_at（この呼び出し時点の
 * ISO 8601、全件同一時刻） / imported_ref_id を更新する。列位置は updateReferenceColumnByRefId()
 * と同じ「ヘッダー行から都度引く」流儀（ハードコード禁止）だが、そちらが1列ずつの更新なのに対し、
 * こちらは1件の候補につき4列を更新するため、全 update × 4列ぶんの range をまとめて
 * 1回の values:batchUpdate（batchUpdateRanges()）で送る。ensurePublicationCandidatesSheet() を
 * 先に呼ぶ。該当 candidate_id が見つからない更新は黙ってスキップする
 * （updateReferenceColumnByRefId() と同じ振る舞い）。
 */
export async function updatePublicationCandidateStatus(
    spreadsheetId: string,
    updates: PublicationCandidateStatusUpdate[]
): Promise<void> {
    if (updates.length === 0) return;

    await ensurePublicationCandidatesSheet(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, `${PUBLICATION_CANDIDATES_SHEET}!A:${PUBLICATION_CANDIDATES_LAST_COLUMN}`);
    if (values.length <= 1) return;

    const headers = values[0];
    const candidateIdIndex = headers.indexOf('candidate_id');
    const statusIndex = headers.indexOf('status');
    const decidedByIndex = headers.indexOf('decided_by');
    const decidedAtIndex = headers.indexOf('decided_at');
    const importedRefIdIndex = headers.indexOf('imported_ref_id');

    if (candidateIdIndex === -1 || statusIndex === -1 || decidedByIndex === -1 ||
        decidedAtIndex === -1 || importedRefIdIndex === -1) {
        throw new Error('Publication_Candidates column not found');
    }

    const rowIndexByCandidateId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const candidateId = (row[candidateIdIndex] || '').trim();
        if (candidateId) {
            rowIndexByCandidateId.set(candidateId, index + 2);
        }
    });

    const decidedAt = new Date().toISOString();
    const columnUpdaters: Array<{ index: number; value: (u: PublicationCandidateStatusUpdate) => string }> = [
        { index: statusIndex, value: (u) => u.status },
        { index: decidedByIndex, value: (u) => u.decidedBy },
        { index: decidedAtIndex, value: () => decidedAt },
        { index: importedRefIdIndex, value: (u) => u.importedRefId || '' },
    ];

    const batchUpdates: Array<{ range: string; values: string[][] }> = [];
    for (const update of updates) {
        const rowIndex = rowIndexByCandidateId.get(update.candidateId);
        if (!rowIndex) continue;
        for (const col of columnUpdaters) {
            batchUpdates.push({
                range: `${PUBLICATION_CANDIDATES_SHEET}!${columnNumberToLetter(col.index)}${rowIndex}`,
                values: [[col.value(update)]],
            });
        }
    }

    if (batchUpdates.length === 0) return;

    const batchSize = 500;
    for (let i = 0; i < batchUpdates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, batchUpdates.slice(i, i + batchSize));
    }
}
