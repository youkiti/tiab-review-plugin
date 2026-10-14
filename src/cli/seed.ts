// 人の判定を検査して一括追記し、読み戻した結果で後続処理の可否を決める。
import { randomUUID } from 'node:crypto';
import { getReferences, getDecisionsRaw, getSheetValues, CONFIG_SHEET, parseAssignmentConfig, setKeyOpenedStatus, appendImportedDecisions } from '../lib/sheets-api';
import { dismissAssignment } from '../lib/assignment-dismiss';
import { getClientVersion, humanDecisionSuffix, isHumanDecision } from '../lib/client-version';
import type { Decision } from '../lib/types';
import { resolveDecisionInputs, type DecisionInput } from './decision-csv';

export class SeedInterruptedError extends Error {
    constructor(public readonly spreadsheetId: string, public readonly confirmed: number | null,
        public readonly expected: number, public readonly cause: unknown) {
        super('判定取り込みの途中で停止しました。自動再試行はしません。');
    }
}

/** 判定の保存・照合が完了した後の設定保存の失敗を区別する。 */
export class SeedPostProcessingError extends Error {
    constructor(public readonly spreadsheetId: string, public readonly confirmed: number,
        public readonly operation: 'キー開封' | '担当セット案内の非表示', public readonly cause: unknown) {
        super(`判定は全 ${confirmed} 件の書き込みと読み戻し照合が完了していますが、${operation}に失敗しました。seed を再実行すると行が二重になりうるため、再実行しないでください。Config を確認してください。`);
    }
}

export async function runSeed(input: { spreadsheetId: string; rows: DecisionInput[]; source: string; openKey: boolean }) {
    const { spreadsheetId, rows, source, openKey } = input;
    const [references, raw, config] = await Promise.all([
        getReferences(spreadsheetId), getDecisionsRaw(spreadsheetId),
        getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`),
    ]);
    const resolved = resolveDecisionInputs(rows, references, raw.map(r => r.decision).filter(d => isHumanDecision(d.client_version)));
    const decisions: Decision[] = resolved.map(row => ({
        decision_id: randomUUID(), ref_id: row.ref_id, reviewer_id: row.reviewer_id,
        decision: row.decision, note: row.note, decided_at: row.decided_at,
        client_version: getClientVersion(humanDecisionSuffix(false, false)), screening_phase: 'tiab',
        context_json: JSON.stringify({ imported: true, by: 'cli', source }),
    }));
    let confirmed: number | null = null;
    let appendError: unknown;
    try { await appendImportedDecisions(spreadsheetId, decisions); }
    catch (error) { appendError = error; }
    try {
        const reread = (await getDecisionsRaw(spreadsheetId)).map(r => r.decision);
        const ids = new Set(decisions.map(d => d.decision_id));
        const imported = reread.filter(d => ids.has(d.decision_id));
        confirmed = imported.length;
        const matches = imported.length === decisions.length && decisions.every(expected => {
            const found = imported.filter(d => d.decision_id === expected.decision_id);
            return found.length === 1 && found[0].ref_id === expected.ref_id && found[0].reviewer_id === expected.reviewer_id &&
                found[0].decision === expected.decision && (found[0].note ?? '') === expected.note;
        });
        if (appendError || !matches) throw new SeedInterruptedError(spreadsheetId, confirmed, decisions.length, appendError);
    } catch (error) {
        if (error instanceof SeedInterruptedError) throw error;
        throw new SeedInterruptedError(spreadsheetId, confirmed, decisions.length, appendError ?? error);
    }
    const assignment = parseAssignmentConfig(config);
    if (openKey) {
        try { await setKeyOpenedStatus(spreadsheetId, true); }
        catch (error) { throw new SeedPostProcessingError(spreadsheetId, decisions.length, 'キー開封', error); }
    }
    if (assignment.status === 'none') {
        try { await dismissAssignment(spreadsheetId); }
        catch (error) { throw new SeedPostProcessingError(spreadsheetId, decisions.length, '担当セット案内の非表示', error); }
    }
    return { imported: confirmed, assignment: assignment.status === 'configured'
        ? '作成済みの担当セットは変更しませんでした。' : '担当セット案内は非表示です。' };
}
