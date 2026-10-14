// CLI の読み取りと判定取り込み。列順はシートのスキーマだけを参照する。
import type { Decision } from '../types';
import { DECISIONS_HEADERS, DECISIONS_SHEET } from './schema';
import { SHEETS_API_BASE, getAuthToken } from './transport';
import { invalidateDecisionRowCache } from './decisions';

/** CSV のメモや日付をそのまま保存するため RAW を使い、追記は一度だけ送る。 */
export async function appendImportedDecisions(spreadsheetId: string, decisions: Decision[]): Promise<void> {
    if (!decisions.length) return;
    const token = await getAuthToken();
    const values = decisions.map(decision => DECISIONS_HEADERS.map(header =>
        header === 'labels' ? '' : (decision as unknown as Record<string, string | undefined>)[header] ?? ''));
    try {
        const response = await fetch(
            `${SHEETS_API_BASE}/${spreadsheetId}/values/${DECISIONS_SHEET}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
        );
        if (!response.ok) throw Object.assign(new Error('判定の追記に失敗しました。'), { status: response.status });
    } finally {
        invalidateDecisionRowCache();
    }
}
