// Google Sheets API ラッパー

import { platform } from '../platform';
import { AUDIT_LOG_HEADERS, buildAuditEventRow } from './audit-log';
import type { AuditLogEvent } from './audit-log';

import {
    SHEETS_API_BASE,
    SheetsAccessDeniedError,
    isSheetsAccessDeniedStatus,
    readSheetsErrorMessage,
    getAuthToken,
    appendRows,
    getSheetIdByName,
    addSheet,
} from './sheets/transport';
import {
    REFERENCES_SHEET,
    DECISIONS_SHEET,
    CONFIG_SHEET,
    AUDIT_LOG_SHEET,
    PUBLICATION_CANDIDATES_HEADERS,
    DUPLICATE_CANDIDATES_HEADERS,
    REFERENCES_HEADERS,
    DECISIONS_HEADERS,
    validateReferencesManagedHeaders,
} from './sheets/schema';
import {
    getDecisionsRaw,
    invalidateDecisionRowCache,
} from './sheets/decisions';
import { getFulltextAiActiveRound, setFulltextAiActiveRound } from './sheets/config';
export {
    SheetsAccessDeniedError,
    isSheetsAccessDeniedStatus,
    getAuthToken,
    REFERENCES_HEADERS,
    PUBLICATION_CANDIDATES_HEADERS,
    DUPLICATE_CANDIDATES_HEADERS,
    validateReferencesManagedHeaders,
    invalidateDecisionRowCache,
};
export { isQuotaExceededError } from './sheets/transport';
export type { ReferencesHeaderConflict, ReferencesManagedHeadersCheck } from './sheets/schema';
export {
    getReferences,
    ensureHeaders,
    invalidateFulltextDriveColumnsMemo,
    validateSpreadsheetFormat,
    buildReferenceInsertRow,
    addReferences,
    updateReferenceFulltextUrl,
    updateReferenceFulltextUrls,
    getReferenceFulltextState,
    getFulltextClaimsSnapshot,
    deleteReferencesBySourceFile,
    updateReferenceScreeningSets,
    updateReferenceFulltextSets,
    setDuplicateOf,
} from './sheets/references';
export type { ReferenceFulltextRowState, FulltextSourceClaim, FulltextClaimsSnapshot } from './sheets/references';
export {
    detectConflict,
    getDecisions,
    saveDecision,
    appendDecisions,
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    getLlmPendingDecisions,
} from './sheets/decisions';
export {
    PRESET_RCT,
    PRESET_SR,
    parseAssignmentConfig,
    parseFulltextAiActiveRound,
    DEFAULT_LLM_CONFIG,
} from './sheets/config-schema';
export type { HighlightKeywords, ProjectConfigBundle, FulltextEvidenceDisplay } from './sheets/config-schema';
export {
    getAssignmentConfig,
    saveAssignmentConfig,
    getFulltextAssignmentConfig,
    saveFulltextAssignmentConfig,
    getProjectConfigBundle,
    getProjectLoadConfig,
    getHighlightKeywords,
    updateConfigKeywords,
    getFulltextPoolRule,
    saveFulltextPoolRule,
    saveReviewCriteria,
    saveExcludeReasonConfig,
    saveImportStats,
    getFulltextAiActiveRound,
    setFulltextAiActiveRound,
    getKeyOpenedStatus,
    setKeyOpenedStatus,
    getFulltextDriveFolderId,
    saveFulltextDriveFolderId,
    getProjectDriveFolderId,
    saveProjectDriveFolderId,
    getLlmConfig,
    updateLlmConfig,
} from './sheets/config';
export {
    getActiveBatchIdsForActiveRun,
    selectActiveBatchIds,
    selectActiveLlmRun,
    getLlmExecutions,
    clearLlmSheetEnsureMemo,
    ensureLlmExecutionsSheet,
    ensureLlmRunsSheet,
    saveLlmExecution,
    updateLlmExecution,
    saveLlmRun,
    updateLlmRun,
    getLlmRuns,
    getLlmHistory,
    findRunByConfigHash,
    getActiveLlmRun,
    getRunForBatchId,
    getBatchIdsForRun,
    getJudgedRefIdsForBatches,
    setSingleActiveRun,
} from './sheets/llm-history';
export {
    ensurePublicationCandidatesSheet,
    savePublicationCandidates,
    getPublicationCandidates,
    updatePublicationCandidateStatus,
} from './sheets/publication-candidates';
export type { PublicationCandidateStatusUpdate } from './sheets/publication-candidates';
export {
    ensureDuplicateCandidatesSheet,
    saveDuplicateCandidates,
    getDuplicateCandidates,
    updateDuplicateCandidateStatus,
} from './sheets/duplicate-candidates';
export {
    getRecentSpreadsheets,
    getLocalRecentSheets,
    rememberLocalRecentSheet,
} from './drive-recent-files';
export type { RecentSpreadsheet, LocalRecentSheet } from './drive-recent-files';
export {
    getFilePermissions,
    getSpreadsheetPermissions,
    DrivePermissionError,
    deletePermission,
    addPermission,
    isUserAdmin,
} from './drive-permissions';
export type { SpreadsheetPermission, AddPermissionOptions } from './drive-permissions';


export {
    getFulltextPageData,
    loadProjectSnapshot,
    selectReferencesWithStatus,
} from './sheets/project-snapshot';
export type {
    ProjectSnapshot,
    ProjectSnapshotParts,
} from './sheets/project-snapshot';

/**
 * ユーザーのメールアドレスを取得（OAuth userinfo APIを使用）
 */
export async function getUserEmail(): Promise<string> {
    const token = await getAuthToken();

    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error('Failed to get user info');
    }

    const userInfo = await response.json();
    if (!userInfo.email) {
        throw new Error('No email found');
    }

    return userInfo.email;
}

/**
 * トークンをクリアして再認証（スコープ変更時に使用）
 */
export async function forceReauth(): Promise<string> {
    return platform().forceReauth();
}


/**
 * 新しいスプレッドシートを作成
 */
export async function createSpreadsheet(title: string): Promise<string> {
    const token = await getAuthToken();

    const response = await fetch(SHEETS_API_BASE, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: {
                title: title
            },
            sheets: [
                {
                    properties: { title: REFERENCES_SHEET }
                },
                {
                    properties: { title: DECISIONS_SHEET }
                },
                {
                    properties: { title: CONFIG_SHEET }
                }
            ]
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to create spreadsheet: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const spreadsheetId = data.spreadsheetId;

    // ヘッダー行を追加
    await appendRows(spreadsheetId, REFERENCES_SHEET, [REFERENCES_HEADERS]);
    await appendRows(spreadsheetId, DECISIONS_SHEET, [DECISIONS_HEADERS]);

    return spreadsheetId;
}


/**
 * スプレッドシートの存在確認とタイトル取得
 */
export async function getSpreadsheetInfo(spreadsheetId: string): Promise<{ title: string }> {
    const token = await getAuthToken();

    const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}?fields=properties.title`, {
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        const message = await readSheetsErrorMessage(response);
        if (isSheetsAccessDeniedStatus(response.status)) {
            throw new SheetsAccessDeniedError(spreadsheetId, response.status, message);
        }
        throw new Error(`Failed to get spreadsheet info: ${message}`);
    }

    const data = await response.json();
    return { title: data.properties.title };
}

/**
 * key開閉などの監査イベントを Audit_Log タブへ1行追記する（AGENTS.md「Audit_Log タブ」参照）。
 * タブが無いプロジェクトでは addSheet → [ヘッダ行, 本体行] を1回の append でまとめて書き込む
 * （trySaveConfigValue と同じ「Config タブ欠落時の自動作成」パターンを踏襲）。
 * ヘッダ行と本体行を別々の append に分けると、ヘッダ側だけが失敗（かつベストエフォートで
 * 握り潰される）した場合に「タブは存在するがヘッダー無し」の状態が恒久化してしまう
 * （2回目以降はタブが既にあるため最初の append がそのまま成功してしまい、気づけない）。
 * 1回の append にまとめることで、成功・失敗のいずれでもヘッダーと本体行が揃った状態を保つ。
 *
 * 監査ログはベストエフォート: この関数は絶対に throw を外へ漏らさない。失敗しても
 * console.warn するだけで、呼び出し元の本体操作（key開閉そのもの）を壊してはならない。
 */
export async function logAuditEvent(
    spreadsheetId: string,
    event: Omit<AuditLogEvent, 'event_id'>
): Promise<void> {
    try {
        const row = buildAuditEventRow({ event_id: crypto.randomUUID(), ...event });
        try {
            await appendRows(spreadsheetId, AUDIT_LOG_SHEET, [row]);
        } catch (error) {
            const message = String((error as { message?: unknown } | undefined)?.message ?? error);
            if (message.includes('Unable to parse range') || message.includes('not found')) {
                console.log('[logAuditEvent] Audit_Log sheet missing, creating...');
                await addSheet(spreadsheetId, AUDIT_LOG_SHEET);
                await appendRows(spreadsheetId, AUDIT_LOG_SHEET, [AUDIT_LOG_HEADERS, row]);
            } else {
                throw error;
            }
        }
    } catch (error) {
        // ベストエフォート: 監査ログの失敗で本体操作（key開閉）を失敗させない
        console.warn('[logAuditEvent] Failed to record audit event (best-effort, ignored):', error);
    }
}


/**
 * フルテキストAI判定の1ラウンド（特定 reviewer_id・fulltext フェーズ）の判定行を全削除する。
 * 採用中ラウンドを削除した場合は採用を解除する。
 * ラウンドの履歴行を1行残らず消す必要があるため、畳み込み後ではなく生の全行を使う。
 * @returns 削除した行数
 */
export async function deleteFulltextAiRound(spreadsheetId: string, reviewerId: string): Promise<number> {
    const decisionsData = await getDecisionsRaw(spreadsheetId);
    const targetRows = decisionsData
        .filter(({ decision }) =>
            decision.reviewer_id === reviewerId &&
            (decision.screening_phase ?? 'tiab') === 'fulltext'
        )
        .map(({ rowIndex }) => rowIndex); // 1始まりのシート行番号

    if (targetRows.length === 0) return 0;

    const sheetId = await getSheetIdByName(spreadsheetId, DECISIONS_SHEET);
    if (sheetId === null) throw new Error('Decisions sheet not found');

    // deleteDimension は 0-indexed。後ろの行から削除してインデックスのズレを防ぐ。
    const sorted = [...new Set(targetRows)].sort((a, b) => b - a);
    const requests = sorted.map(r => ({
        deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r },
        },
    }));

    const token = await getAuthToken();
    const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || response.statusText);
    }

    // 削除により Decisions の行番号がずれるため、行番号キャッシュを必ず無効化する
    invalidateDecisionRowCache();

    // 採用中ラウンドを消したら採用解除
    const active = await getFulltextAiActiveRound(spreadsheetId);
    if (active === reviewerId) {
        await setFulltextAiActiveRound(spreadsheetId, null).catch(() => { /* 解除失敗は致命でない */ });
    }

    return targetRows.length;
}
