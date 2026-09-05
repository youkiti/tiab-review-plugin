// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, LlmCriteria, LlmExecution, LlmRun, PublicationCandidate, PublicationCandidateStrategy, PublicationCandidateStatus, DuplicateCandidate, DuplicateCandidateStatus, DuplicateCandidateDraft, DuplicateCandidateStatusUpdate } from './types';
import { platform } from '../platform';
import { createAsyncCoalescer } from './async-coalesce';
import { computeConfigHash, isHashable, legacyHash } from './llm-config-hash';
import { pickRunByConfigHash, pickLegacyRunByConfigHash, collectJudgedRefIds } from './llm-batch-target';
import { parseLlmTargetMode } from './llm-target-selection';
import { driveFetch } from './drive-shared-drive';
import { AUDIT_LOG_HEADERS, buildAuditEventRow } from './audit-log';
import { isLogicallyDeleted, filterNewDuplicatePairs } from './duplicate-detect';
import type { AuditLogEvent } from './audit-log';
import { filterNewCandidates } from './publication-suggest';
import type { PublicationCandidateDraft } from './publication-suggest';

import {
    SHEETS_API_BASE,
    SheetsAccessDeniedError,
    isSheetsAccessDeniedStatus,
    readSheetsErrorMessage,
    getAuthToken,
    getSheetValues,
    getSheetValuesBatch,
    appendRows,
    updateRange,
    getSheetIdByName,
    batchUpdateRanges,
    addSheet,
    isSheetMissingError,
} from './sheets/transport';
import {
    REFERENCES_SHEET,
    DECISIONS_SHEET,
    CONFIG_SHEET,
    LLM_EXECUTIONS_SHEET,
    LLM_RUNS_SHEET,
    AUDIT_LOG_SHEET,
    PUBLICATION_CANDIDATES_SHEET,
    DUPLICATE_CANDIDATES_SHEET,
    LLM_EXECUTIONS_HEADERS,
    LLM_RUNS_HEADERS,
    PUBLICATION_CANDIDATES_HEADERS,
    DUPLICATE_CANDIDATES_HEADERS,
    REFERENCES_HEADERS,
    DECISIONS_HEADERS,
    columnNumberToLetter,
    PUBLICATION_CANDIDATES_LAST_COLUMN,
    DECISIONS_LAST_COLUMN,
    REFERENCES_LAST_COLUMN,
    validateReferencesManagedHeaders,
} from './sheets/schema';
import { parseReferenceValues, parseDecisionValues } from './sheets/codecs';
import { getReferences } from './sheets/references';
import {
    getDecisions,
    getDecisionsRaw,
    detectConflict,
    buildMyFulltextDecisionMap,
    buildAllFulltextDecisionsMap,
    collapseToLatestDecisions,
    primeDecisionRowCache,
    filterDecisionsForBlind,
    invalidateDecisionRowCache,
} from './sheets/decisions';
import type { ProjectConfigBundle } from './sheets/config-schema';
import { DEFAULT_CONFIG_BUNDLE, parseConfigBundle } from './sheets/config-schema';
import { getFulltextAiActiveRound, setFulltextAiActiveRound } from './sheets/config';
export {
    SheetsAccessDeniedError,
    isSheetsAccessDeniedStatus,
    getAuthToken,
    REFERENCES_HEADERS,
    PUBLICATION_CANDIDATES_HEADERS,
    DUPLICATE_CANDIDATES_HEADERS,
    validateReferencesManagedHeaders,
    getReferences,
    getDecisions,
    detectConflict,
    invalidateDecisionRowCache,
};
export { isQuotaExceededError } from './sheets/transport';
export type { ReferencesHeaderConflict, ReferencesManagedHeadersCheck } from './sheets/schema';
export {
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
 * 最近使用したスプレッドシート一覧を取得
 */
export interface RecentSpreadsheet {
    id: string;
    name: string;
    modifiedTime: string;
}

export async function getRecentSpreadsheets(maxResults = 10): Promise<RecentSpreadsheet[]> {
    console.log('[getRecentSpreadsheets] Starting...');

    const token = await getAuthToken();
    console.log('[getRecentSpreadsheets] Got token:', token ? 'yes' : 'no');

    const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'");
    const fields = encodeURIComponent('files(id,name,modifiedTime)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=recency&pageSize=${maxResults}&fields=${fields}`;

    console.log('[getRecentSpreadsheets] Fetching:', url);

    const response = await driveFetch(url, {}, { token, kind: 'list' });

    console.log('[getRecentSpreadsheets] Response status:', response.status);

    if (!response.ok) {
        const error = await response.json();
        console.error('[getRecentSpreadsheets] Error:', error);
        throw new Error(`Failed to get recent spreadsheets: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('[getRecentSpreadsheets] Got files:', data.files?.length || 0);

    return (data.files || []).map((file: { id: string; name: string; modifiedTime: string }) => ({
        id: file.id,
        name: file.name,
        modifiedTime: file.modifiedTime,
    }));
}

/**
 * ローカルに記録する「拡張機能で開いたシート」エントリ。
 *
 * OAuth スコープが drive.file のため、URL を貼り付けて開いたシートは Drive API の
 * files.list には現れない。拡張機能内で接続/作成したシートはここに保存しておき、
 * 初期画面のドロップダウンに合流させることで「最近開いた」一覧として再選択できる
 * ようにする。
 */
export interface LocalRecentSheet {
    id: string;
    name: string;
    lastUsedAt: string; // ISO 8601
}

const LOCAL_RECENT_SHEETS_KEY = 'localRecentSheets';
const LOCAL_RECENT_SHEETS_MAX = 30;

export async function getLocalRecentSheets(): Promise<LocalRecentSheet[]> {
    try {
        const result = await platform().storageGet([LOCAL_RECENT_SHEETS_KEY]);
        const raw = result[LOCAL_RECENT_SHEETS_KEY];
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((entry): entry is LocalRecentSheet =>
                entry &&
                typeof entry.id === 'string' &&
                typeof entry.name === 'string' &&
                typeof entry.lastUsedAt === 'string'
            )
            .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    } catch (error) {
        console.error('[getLocalRecentSheets] Failed:', error);
        return [];
    }
}

export async function rememberLocalRecentSheet(id: string, name: string): Promise<void> {
    if (!id || !name) return;
    try {
        const existing = await getLocalRecentSheets();
        const next: LocalRecentSheet[] = [
            { id, name, lastUsedAt: new Date().toISOString() },
            ...existing.filter((entry) => entry.id !== id),
        ].slice(0, LOCAL_RECENT_SHEETS_MAX);
        await platform().storageSet({ [LOCAL_RECENT_SHEETS_KEY]: next });
    } catch (error) {
        console.error('[rememberLocalRecentSheet] Failed:', error);
    }
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
 * 【渡した配列の要素は in-place で書き換えられる】（PR #161 レビュー指摘対応）。
 * getReferencesWithStatus() / getReferencesWithAllDecisions() は allReferences の各要素の
 * ref_id、decisionsData の各要素の decision.reviewer_id（空欄→reviewerEmail の補完）・
 * decision.ref_id を trim して直接書き換える（正規化ロジック自体はこの対応で変更していない）。
 * 呼び出し側がこの配列を同じ呼び出しの中で他の関数（team-progress・duplicate-review等）へも
 * 配る場合は、getReferencesWith* を呼ぶ前にシャローコピーを渡すこと。同じ参照を渡すと、
 * 正規化前を期待する側が正規化後（reviewer_id 補完済み）のデータを受け取ってしまう。
 */
export interface ReferencesAndDecisionsLoaded {
    /** 論理削除済み行を含む全件（getReferences() と同じ契約）。未指定ならここで取得する。 */
    allReferences?: Reference[];
    /** getDecisions() と同じ契約（畳み込み済み・全レビュアー分）。未指定ならここで取得する。 */
    decisionsData?: { decision: Decision; rowIndex: number }[];
}

/**
 * 文献一覧に判定状態をマージ（キーオープン前）
 *
 * 【論理削除された行（重複）をここで除外する】isLogicallyDeleted() が true の行
 * （duplicate_of 非空）を戻り値から取り除く（Issue #145 チャンク2）。この関数の呼び出し元は
 * TiAb スクリーニング・エクスポート・ML/LLM判定対象取得など複数箇所にまたがるが、判断ロジックを
 * 各呼び出し元へ分散させず、共通のこの一箇所で外すことで全呼び出し元に一度に効かせる
 * （同じ判断のコピーが呼び出し元ごとに散ると、片方だけ直して漏れる事故につながるため）。
 * 除外なしで全件（論理削除済みの行も含む）が必要な場合は getReferences() を使うこと
 * （重複レビューUIの resolveSurvivor() / isPairAlreadySettled() が判定に論理削除済みの
 * 行を必要とするため。Issue #147 外部レビュー指摘。個別の統合判断を取り消す一般的なUIは
 * 実装されていない）。
 */
export async function getReferencesWithStatus(
    spreadsheetId: string,
    reviewerEmail: string,
    loaded?: ReferencesAndDecisionsLoaded
): Promise<ReferenceWithStatus[]> {
    console.log('[getReferencesWithStatus] Loading with reviewerEmail:', reviewerEmail);

    const [allReferences, decisionsData] = await Promise.all([
        loaded?.allReferences ?? getReferences(spreadsheetId),
        loaded?.decisionsData ?? getDecisions(spreadsheetId),
    ]);
    const references = allReferences.filter((ref) => !isLogicallyDeleted(ref));

    console.log('[getReferencesWithStatus] References:', references.length, 'Decisions:', decisionsData.length);

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // 自分の判定をマップ化
    const myDecisions = new Map<string, Decision>();
    // Blind ONでもAI Evidenceハイライトに必要なLLM判定だけ保持する
    const llmDecisionsMap = new Map<string, Decision[]>();
    tiabDecisionsData.forEach(({ decision }) => {
        // console.log('[getReferencesWithStatus] Decision reviewer_id:', decision.reviewer_id);
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        if (reviewerId && reviewerId !== decision.reviewer_id) {
            decision.reviewer_id = reviewerId;
        } else if (!reviewerId && normalizedReviewerEmail) {
            decision.reviewer_id = normalizedReviewerEmail;
        }
        if (refId !== decision.ref_id) {
            decision.ref_id = refId;
        }
        if (decision.reviewer_id === normalizedReviewerEmail) {
            myDecisions.set(decision.ref_id, decision);
        }
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!llmDecisionsMap.has(decision.ref_id)) {
                llmDecisionsMap.set(decision.ref_id, []);
            }
            llmDecisionsMap.get(decision.ref_id)!.push(decision);
        }
    });

    console.log('[getReferencesWithStatus] My decisions count:', myDecisions.size);

    return references.map(ref => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
        const myDecision = myDecisions.get(ref.ref_id);
        // decision='pending' の場合も未判定として扱う
        const status: DecisionStatus = (myDecision && myDecision.decision !== 'pending') ? myDecision.decision : 'pending';
        const llmDecisions = llmDecisionsMap.get(ref.ref_id) || [];
        return {
            ...ref,
            myDecision,
            status,
            allDecisions: llmDecisions,
            llmBatchIds: llmDecisions.map(d => d.reviewer_id),
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
        };
    });
}

/**
 * 文献一覧に全判定状態をマージ（キーオープン後）
 *
 * 論理削除された行（重複）をここでも除外する。理由は getReferencesWithStatus() の JSDoc を参照
 * （Issue #145 チャンク2）。除外しないと、盲検中は消えていた重複がキー開封の瞬間に復活して見える。
 */
export async function getReferencesWithAllDecisions(
    spreadsheetId: string,
    reviewerEmail: string,
    loaded?: ReferencesAndDecisionsLoaded & {
        llmExecutions?: LlmExecution[]; llmRuns?: LlmRun[]; fulltextAiActiveRound?: string | null;
    }
): Promise<ReferenceWithStatus[]> {
    console.log('[getReferencesWithAllDecisions] Loading with reviewerEmail:', reviewerEmail);

    const [allReferences, decisionsData, llmExecutions, activeFulltextAiRound] = await Promise.all([
        loaded?.allReferences ?? getReferences(spreadsheetId),
        loaded?.decisionsData ?? getDecisions(spreadsheetId),
        loaded?.llmExecutions ?? getLlmExecutions(spreadsheetId),
        loaded?.fulltextAiActiveRound !== undefined
            ? loaded.fulltextAiActiveRound : getFulltextAiActiveRound(spreadsheetId),
    ]);
    const references = allReferences.filter((ref) => !isLogicallyDeleted(ref));

    console.log('[getReferencesWithAllDecisions] References:', references.length, 'Decisions:', decisionsData.length);

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // デバッグ: ref_idのサンプルを表示
    if (decisionsData.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample decision ref_ids:', decisionsData.slice(0, 3).map(d => d.decision.ref_id));
    }
    if (references.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample reference ref_ids:', references.slice(0, 3).map(r => r.ref_id));
    }

    // 有効な LLM 判定 = active Run 配下の Batch IDs に含まれる reviewer_id のもの
    // Run/Batch 分離後、active 状態は LLM_Runs.is_active が正となる
    const activeBatchIds = await getActiveBatchIdsForActiveRun(spreadsheetId, llmExecutions, loaded?.llmRuns);
    const validLlmExecutionIds = activeBatchIds;

    // 全レビュアー（+採用ラウンドのAI）のフルテキスト判定マップ（結果集計用）
    const allFulltextDecisionsMap = buildAllFulltextDecisionsMap(decisionsData, activeFulltextAiRound);

    console.log('[getReferencesWithAllDecisions] llmExecutions:', llmExecutions.map(e => ({
        id: e.execution_id,
        status: e.status,
        is_active: e.is_active,
        run_id: e.run_id,
    })));
    console.log('[getReferencesWithAllDecisions] activeBatchIds:', Array.from(validLlmExecutionIds));

    // 全判定をref_id別にグループ化（有効なLLM判定のみを含める）
    const allDecisionsMap = new Map<string, Decision[]>();
    // バッチ対象を Run 単位で決めるため、status/active を問わず
    // 「どの LLM バッチがこの文献を判定したか」を別途記録する
    const llmBatchIdsByRefId = new Map<string, string[]>();
    let skippedLlm = 0;
    let addedDecisions = 0;
    let addedHuman = 0;
    let addedLlm = 0;
    tiabDecisionsData.forEach(({ decision }) => {
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        const reviewerIdRaw = (decision.reviewer_id || '').trim();
        const reviewerId = reviewerIdRaw || normalizedReviewerEmail;
        if (reviewerId && reviewerId !== decision.reviewer_id) {
            decision.reviewer_id = reviewerId;
        }
        if (refId !== decision.ref_id) {
            decision.ref_id = refId;
        }

        if (decision.reviewer_id.startsWith('llm:')) {
            const ids = llmBatchIdsByRefId.get(decision.ref_id) ?? [];
            ids.push(decision.reviewer_id);
            llmBatchIdsByRefId.set(decision.ref_id, ids);
        }

        // LLMの判定かつ、有効な実行IDに含まれていない場合はスキップ
        if (decision.reviewer_id.startsWith('llm:') && !validLlmExecutionIds.has(decision.reviewer_id)) {
            skippedLlm++;
            return;
        }

        if (!allDecisionsMap.has(decision.ref_id)) {
            allDecisionsMap.set(decision.ref_id, []);
        }
        allDecisionsMap.get(decision.ref_id)!.push(decision);
        addedDecisions++;

        // デバッグ: reviewer_idの種類ごとにカウント
        if (decision.reviewer_id.startsWith('llm:')) {
            addedLlm++;
        } else {
            addedHuman++;
        }
    });

    console.log('[getReferencesWithAllDecisions] allDecisionsMap size:', allDecisionsMap.size, 'addedDecisions:', addedDecisions, 'skippedLlm:', skippedLlm);
    console.log('[getReferencesWithAllDecisions] addedHuman:', addedHuman, 'addedLlm:', addedLlm);

    // デバッグ: ref_idのマッチング状況
    const refIdsInDecisions = new Set(Array.from(allDecisionsMap.keys()));
    const refIdsInReferences = new Set(references.map(r => r.ref_id));
    const matchedRefIds = [...refIdsInDecisions].filter(id => refIdsInReferences.has(id));
    const unmatchedDecisionRefIds = [...refIdsInDecisions].filter(id => !refIdsInReferences.has(id));
    console.log('[getReferencesWithAllDecisions] ref_id matching: matched=', matchedRefIds.length, 'unmatched decisions=', unmatchedDecisionRefIds.length);
    if (unmatchedDecisionRefIds.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample unmatched decision ref_ids:', unmatchedDecisionRefIds.slice(0, 3));
    }

    return references.map(ref => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
        const allDecisions = allDecisionsMap.get(ref.ref_id) || [];
        const myDecision = normalizedReviewerEmail
            ? allDecisions.find(d => d.reviewer_id === normalizedReviewerEmail)
            : undefined;

        // 不一致検出
        const hasConflict = detectConflict(allDecisions);

        // ステータス決定
        let status: DecisionStatus;
        if (hasConflict) {
            status = 'conflict';
        } else if (myDecision && myDecision.decision !== 'pending') {
            // decision='pending' の場合も未判定として扱う
            status = myDecision.decision;
        } else {
            status = 'pending';
        }

        return {
            ...ref,
            myDecision,
            status,
            allDecisions,
            hasConflict,
            llmBatchIds: llmBatchIdsByRefId.get(ref.ref_id) ?? [],
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
            allFulltextDecisions: allFulltextDecisionsMap.get(ref.ref_id) || [],
        };
    });
}


/**
 * フルテキストページの初期データをまとめて取得（1リクエスト）
 * References / Decisions / Config を values:batchGet で取得する。
 * 追記専用化により Decisions には同一キーの履歴行が複数残りうるため、返す前に
 * 各キーの最新1行へ畳み込む（下流のUI・集計を getDecisions() と同じ挙動に保つため）。
 *
 * keyOpened=false（Blind中）のときは、返す decisions を filterDecisionsForBlind() で
 * 自分の判定＋LLM判定に絞り込む（サイドパネルの Blind ロードと同じポリシー）。
 * primeDecisionRowCache() は絞り込み前の全件で温める（行番号キャッシュの整合性のため）。
 *
 * 論理削除された行（重複）は references から除外する。理由は getReferencesWithStatus() の
 * JSDoc を参照（Issue #145 チャンク2 / PR #146 レビュー指摘）。Config タブが無い旧シート向けの
 * フォールバック経路（catch 節側）でも同様に除外する。
 */
export async function getFulltextPageData(spreadsheetId: string, userEmail: string): Promise<{
    references: Reference[];
    decisions: { decision: Decision; rowIndex: number }[];
    config: ProjectConfigBundle;
}> {
    try {
        const [refValues, decValues, configValues] = await getSheetValuesBatch(spreadsheetId, [
            `${REFERENCES_SHEET}!A:${REFERENCES_LAST_COLUMN}`,
            `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`,
            `${CONFIG_SHEET}!A:B`,
        ]);
        const decisions = collapseToLatestDecisions(parseDecisionValues(decValues));
        // ここでも Decisions を rowIndex 付きで全件取得しているため、行番号キャッシュを温める
        primeDecisionRowCache(spreadsheetId, decisions);
        const config = parseConfigBundle(configValues);
        return {
            references: parseReferenceValues(refValues).filter((ref) => !isLogicallyDeleted(ref)),
            decisions: filterDecisionsForBlind(decisions, config.keyOpened, userEmail),
            config,
        };
    } catch (error) {
        // Config タブがない旧シートでは batchGet 全体が失敗するため、Config 抜きで再試行
        if ((error as Error).message.includes('Unable to parse range')) {
            console.log('[getFulltextPageData] Config sheet missing, falling back:', error);
            const [refValues, decValues] = await getSheetValuesBatch(spreadsheetId, [
                `${REFERENCES_SHEET}!A:${REFERENCES_LAST_COLUMN}`,
                `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`,
            ]);
            const decisions = collapseToLatestDecisions(parseDecisionValues(decValues));
            primeDecisionRowCache(spreadsheetId, decisions);
            const config = { ...DEFAULT_CONFIG_BUNDLE };
            return {
                references: parseReferenceValues(refValues).filter((ref) => !isLogicallyDeleted(ref)),
                decisions: filterDecisionsForBlind(decisions, config.keyOpened, userEmail),
                config,
            };
        }
        throw error;
    }
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
 * スプレッドシートの権限情報を取得
 */
export interface SpreadsheetPermission {
    role: 'owner' | 'writer' | 'reader';
    emailAddress: string;
    /** 権限ID（permissions.delete に必要。取得できない場合がある） */
    id?: string;
    /** 'user' / 'group' / 'domain' / 'anyone' 等（リンク共有等の判別に使う） */
    type?: string;
    displayName?: string;
}

/**
 * 指定ファイル（スプレッドシート/フォルダ問わず）の権限一覧を取得する。
 * 解除処理で権限IDが必要なため、role/emailAddress に加えて id/type/displayName も取得する。
 */
export async function getFilePermissions(fileId: string): Promise<SpreadsheetPermission[]> {
    const token = await getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`,
        {},
        { token }
    );

    if (!response.ok) {
        throw new Error(`Failed to get permissions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.permissions || [];
}

/**
 * スプレッドシートの権限情報を取得（getFilePermissions への委譲）
 * 呼び出し元（isUserAdmin / project.ts / fulltext.ts 等）への影響を避けるため、
 * シグネチャ・外部挙動は変更しない。
 */
export async function getSpreadsheetPermissions(spreadsheetId: string): Promise<SpreadsheetPermission[]> {
    return getFilePermissions(spreadsheetId);
}

/**
 * Drive Permissions API のエラーレスポンス（ステータスコード・エラーメッセージ）を保持する例外。
 * 呼び出し元で classifyPermissionRemovalError に渡し、権限不足/継承権限などを判別する。
 */
export class DrivePermissionError extends Error {
    status: number;
    apiMessage: string;

    constructor(status: number, apiMessage: string) {
        super(apiMessage);
        this.name = 'DrivePermissionError';
        this.status = status;
        this.apiMessage = apiMessage;
    }
}

/**
 * 指定ファイル（スプレッドシート/フォルダ）から権限を1件削除する。
 *
 * **注意**: フォルダ共有プロジェクトでは、フォルダ側の権限を削除しないと
 * 配下のスプレッドシート/フルテキストPDFへのアクセスが（フォルダからの継承として）
 * 残り続けてしまう。呼び出し側は「共有先（フォルダがあればフォルダ優先）」の各対象に
 * 対して本関数を呼ぶこと。
 */
export async function deletePermission(fileId: string, permissionId: string): Promise<void> {
    const token = await getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
        { method: 'DELETE' },
        { token }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        const apiMessage = error?.error?.message || response.statusText;
        throw new DrivePermissionError(response.status, apiMessage);
    }
}

/**
 * emailMessage クエリパラメータの、encodeURIComponent 後の長さの上限バジェット。
 * Drive REST API の URL 全体には概ね8KB程度の実用上の制限があるため、その半分程度を
 * emailMessage 用に確保する。日本語1文字は encodeURIComponent で最大9文字
 * （UTF-8 3バイト → "%XX%XX%XX"）に膨らむため、元の文字数ではなくエンコード後の
 * 長さを基準に切り詰める。招待文テンプレート（日本語で約300文字）はエンコード後でも
 * 十分このバジェット内に収まるため、実運用で切り詰めが発生することはまず無い。
 */
const EMAIL_MESSAGE_ENCODED_BUDGET = 4000;

/** truncateEmailMessageForQuery が1回のループで末尾から削るコードポイント数 */
const TRUNCATE_CHUNK_SIZE = 50;

/**
 * emailMessage を、encodeURIComponent 後の長さが budget 以内に収まるまで末尾から削る。
 * サロゲートペア（絵文字等）を途中で分断しないよう Array.from でコードポイント単位に
 * 分割してから操作する。ループのたびに配列が必ず短くなるため無限ループにはならない。
 */
function truncateEmailMessageForQuery(message: string, budget: number): string {
    if (encodeURIComponent(message).length <= budget) return message;
    const chars = Array.from(message);
    while (chars.length > 0 && encodeURIComponent(chars.join('')).length > budget) {
        chars.splice(-TRUNCATE_CHUNK_SIZE);
    }
    return chars.join('');
}

/**
 * addPermission のオプション引数（後方互換のため第5引数のオプションオブジェクトとして追加）。
 */
export interface AddPermissionOptions {
    /**
     * Driveの共有通知メールを送るかどうか。省略時はDriveの既定挙動
     * （emailMessage指定時は通知あり、未指定時はDriveの既定＝type=userなら通知あり）に従う。
     * false を明示すると、emailMessage の有無にかかわらず sendNotificationEmail=false を
     * クエリへ付ける（emailMessageを載せていても通知自体を送らないなら本文は届かないため、
     * 明示指定を優先する）。共有先を複数回に分けて呼ぶフロー（例: スプレッドシートに
     * 招待文つきで共有した後、同じ相手へフォルダもベストエフォートで共有する）で、
     * 通知メールが2通届くのを防ぐ用途。
     */
    sendNotificationEmail?: boolean;
}

/**
 * 共有設定を追加（Google Drive API）
 *
 * @param fileId 共有対象のファイル/フォルダID
 * @param emailAddress 共有相手のメールアドレス
 * @param role 付与する権限（既定: writer）
 * @param emailMessage Driveの共有通知メールに載せる本文（省略時はDrive既定の通知文のみ）。
 *   **注意**: Drive API v3 permissions.create の仕様上、emailMessage は
 *   リクエストボディではなく **URLのクエリパラメータ** で渡す
 *   （https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create）。
 *   Permission リソース（ボディ）のスキーマに emailMessage フィールドは存在せず、
 *   ボディに入れても Drive 側は無視する（＝通知メール本文が変わらない）ので注意すること。
 *   emailMessage 指定時は sendNotificationEmail=true も明示的にクエリへ付ける
 *   （type=user 時は本来既定で true だが、本文を載せる以上メール送信自体を必須要件として
 *   明示する）。emailMessage 未指定時はクエリを一切付けず、従来と同一のリクエストにする。
 *   URL長制限に配慮し、エンコード後の長さが EMAIL_MESSAGE_ENCODED_BUDGET を超える場合は
 *   末尾を切り詰める。
 * @param options 通知抑制など追加オプション（省略時は既存呼び出しと同一挙動。後方互換）。
 *   詳細は {@link AddPermissionOptions} を参照。
 */
export async function addPermission(
    fileId: string,
    emailAddress: string,
    role: 'writer' | 'reader' = 'writer',
    emailMessage?: string,
    options?: AddPermissionOptions
): Promise<void> {
    const token = await getAuthToken();

    const body = {
        role: role,
        type: 'user',
        emailAddress: emailAddress,
    };

    // クエリ文字列は URLSearchParams ではなく encodeURIComponent を自前で使って組み立てる。
    // URLSearchParams.toString() は application/x-www-form-urlencoded 形式のため、
    // 空白を %20 ではなく + にエンコードしてしまう。招待文には「TiAb Review Plugin」
    // 「Google Chrome」など空白を含む文字列が多数あり、Google側が + をリテラルの
    // プラス記号として解釈した場合、共有相手に届くメール本文が「TiAb+Review+Plugin」の
    // ように壊れて見えるリスクがある。%20（RFC 3986）はどちらの解釈でも確実に空白になる
    // ため、こちらに寄せている。「URLSearchParamsの方が綺麗」という理由で戻さないこと。
    let queryString = '';
    if (emailMessage) {
        const truncated = truncateEmailMessageForQuery(emailMessage, EMAIL_MESSAGE_ENCODED_BUDGET);
        const sendNotificationEmail = options?.sendNotificationEmail === false ? 'false' : 'true';
        queryString = `?emailMessage=${encodeURIComponent(truncated)}&sendNotificationEmail=${sendNotificationEmail}`;
    } else if (options?.sendNotificationEmail === false) {
        // emailMessage が無い場合のみ、明示的な通知抑制指定を反映する。
        // 未指定（options自体が無い、または sendNotificationEmail が無い）ときは
        // 従来どおりクエリを一切付けない（Drive既定の通知ありの挙動を変えない）。
        queryString = '?sendNotificationEmail=false';
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions${queryString}`;

    const response = await driveFetch(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        { token }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || response.statusText);
    }
}

/**
 * ユーザーが管理者権限（編集権限）を持っているかチェック
 * - Permissions APIがつかえない場合（drive.fileスコープの制限など）は
 *   ファイルのcapabilitiesをチェックする
 */
export async function isUserAdmin(spreadsheetId: string, userEmail: string): Promise<boolean> {
    console.log('[isUserAdmin] Starting check for:', userEmail);
    try {
        // 方法1: Permissions API (既存)
        try {
            console.log('[isUserAdmin] Trying permissions API...');
            const permissions = await getSpreadsheetPermissions(spreadsheetId);
            console.log('[isUserAdmin] Got permissions:', permissions.length);

            const userPermission = permissions.find(p => p.emailAddress === userEmail);
            console.log('[isUserAdmin] User permission:', userPermission);

            if (userPermission) {
                const isAdmin = userPermission.role === 'owner' || userPermission.role === 'writer';
                console.log('[isUserAdmin] Result from permissions:', isAdmin);
                return isAdmin;
            }
        } catch (permError) {
            console.warn('[isUserAdmin] Permissions check failed:', permError);
        }

        // 方法2: Capabilities API (Fallback)
        console.log('[isUserAdmin] Trying capabilities fallback...');
        const token = await getAuthToken();
        const response = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=capabilities(canEdit,canShare)`,
            {},
            { token }
        );

        console.log('[isUserAdmin] Capabilities response status:', response.status);
        if (response.ok) {
            const data = await response.json();
            console.log('[isUserAdmin] Capabilities data:', data);
            const canEdit = data.capabilities?.canEdit === true;
            console.log('[isUserAdmin] Result from capabilities:', canEdit);
            return canEdit;
        }

        console.log('[isUserAdmin] All checks failed, returning false');
        return false;
    } catch (error) {
        console.error('[isUserAdmin] Error:', error);
        return false;
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


// ========== LLM関連の関数 ==========


// 内容は保持せず、直近のプロジェクトのタブ・ヘッダー確認成功だけを短時間記録する。
const LLM_SHEET_ENSURE_TTL_MS = 60_000;
type LlmSheetEnsureMemo = { spreadsheetId: string; ensure: () => Promise<void> };
let llmExecutionsEnsureMemo: LlmSheetEnsureMemo | null = null;
let llmRunsEnsureMemo: LlmSheetEnsureMemo | null = null;

/** タブ確認を失効させる。進行中の旧処理が完了しても新しい memo は温まらない。 */
export function clearLlmSheetEnsureMemo(): void {
    llmExecutionsEnsureMemo = null;
    llmRunsEnsureMemo = null;
}

function createLlmSheetEnsureMemo(
    spreadsheetId: string,
    check: (spreadsheetId: string) => Promise<void>
): LlmSheetEnsureMemo {
    let checkedAt: number | null = null;
    return {
        spreadsheetId,
        ensure: createAsyncCoalescer(async () => {
            if (checkedAt !== null && Date.now() - checkedAt < LLM_SHEET_ENSURE_TTL_MS) return;
            await check(spreadsheetId);
            checkedAt = Date.now();
        }),
    };
}

/**
 * LLM_Executionsシートを初期化（存在しない場合）
 *
 * 既存シートに新規列（run_id 等）が無い場合は、ヘッダー行を拡張する。
 * 既存データ行は影響を受けない（run_id は空文字として読まれる）。
 */
export async function ensureLlmExecutionsSheet(spreadsheetId: string): Promise<void> {
    if (llmExecutionsEnsureMemo?.spreadsheetId !== spreadsheetId) {
        llmExecutionsEnsureMemo = createLlmSheetEnsureMemo(spreadsheetId, checkLlmExecutionsSheet);
    }
    await llmExecutionsEnsureMemo.ensure();
}

async function checkLlmExecutionsSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        // ヘッダー行が空（シートはあるが初期化されていない）
        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [LLM_EXECUTIONS_HEADERS]);
            return;
        }

        // 不足している列を末尾に追加（後方互換マイグレーション）
        const missingHeaders = LLM_EXECUTIONS_HEADERS.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
            const newHeaders = [...existingHeaders, ...missingHeaders];
            const startCol = columnNumberToLetter(existingHeaders.length);
            const endCol = columnNumberToLetter(newHeaders.length - 1);
            await updateRange(
                spreadsheetId,
                `${LLM_EXECUTIONS_SHEET}!${startCol}1:${endCol}1`,
                [missingHeaders]
            );
            console.log(`[ensureLlmExecutionsSheet] Added missing columns: ${missingHeaders.join(', ')}`);
        }
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[ensureLlmExecutionsSheet] Creating LLM_Executions sheet...');
            await addSheet(spreadsheetId, LLM_EXECUTIONS_SHEET);
            await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [LLM_EXECUTIONS_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * LLM_Runs シートを初期化（存在しない場合）
 */
export async function ensureLlmRunsSheet(spreadsheetId: string): Promise<void> {
    if (llmRunsEnsureMemo?.spreadsheetId !== spreadsheetId) {
        llmRunsEnsureMemo = createLlmSheetEnsureMemo(spreadsheetId, checkLlmRunsSheet);
    }
    await llmRunsEnsureMemo.ensure();
}

async function checkLlmRunsSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, LLM_RUNS_SHEET, [LLM_RUNS_HEADERS]);
            return;
        }

        const missingHeaders = LLM_RUNS_HEADERS.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
            const newHeaders = [...existingHeaders, ...missingHeaders];
            const startCol = columnNumberToLetter(existingHeaders.length);
            const endCol = columnNumberToLetter(newHeaders.length - 1);
            await updateRange(
                spreadsheetId,
                `${LLM_RUNS_SHEET}!${startCol}1:${endCol}1`,
                [missingHeaders]
            );
            console.log(`[ensureLlmRunsSheet] Added missing columns: ${missingHeaders.join(', ')}`);
        }
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[ensureLlmRunsSheet] Creating LLM_Runs sheet...');
            await addSheet(spreadsheetId, LLM_RUNS_SHEET);
            await appendRows(spreadsheetId, LLM_RUNS_SHEET, [LLM_RUNS_HEADERS]);
        } else {
            throw error;
        }
    }
}

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

/**
 * Duplicate_Candidates の既存ヘッダーに不足列があれば末尾へ追加する（書き込みのみ。GETは行わない）。
 * ensureDuplicateCandidatesSheet()（タブ欠落時のensure経路）と readDuplicateCandidatesRows()
 * （通常の読み取り経路。既に読んだヘッダー行をそのまま渡す）の両方から呼ぶ共有ロジックにして、
 * 列追加の判定・書き込みを二重実装しない（Issue #153 工程2 チャンク2 レビュー指摘対応）。
 *
 * existingHeaders が空（ヘッダー行そのものが無い）場合は何もしない。その状態は
 * ensureDuplicateCandidatesSheet() 側の「ヘッダーを丸ごと書く」分岐が別に持っている。
 */
async function migrateDuplicateCandidatesHeaderColumns(spreadsheetId: string, existingHeaders: string[]): Promise<void> {
    if (existingHeaders.length === 0) return;

    const missingHeaders = DUPLICATE_CANDIDATES_HEADERS.filter(h => !existingHeaders.includes(h));
    if (missingHeaders.length === 0) return;

    const newHeaders = [...existingHeaders, ...missingHeaders];
    const startCol = columnNumberToLetter(existingHeaders.length);
    const endCol = columnNumberToLetter(newHeaders.length - 1);
    await updateRange(
        spreadsheetId,
        `${DUPLICATE_CANDIDATES_SHEET}!${startCol}1:${endCol}1`,
        [missingHeaders]
    );
    console.log(`[migrateDuplicateCandidatesHeaderColumns] Added missing columns: ${missingHeaders.join(', ')}`);
}

/**
 * Duplicate_Candidates シートを初期化（存在しない場合）
 * ensurePublicationCandidatesSheet() と完全に同じ ensure パターン（ヘッダー欠落は末尾へ追記、
 * タブ欠落は addSheet → ヘッダー append、それ以外の例外は再送出）。Issue #145 チャンク2。
 */
export async function ensureDuplicateCandidatesSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${DUPLICATE_CANDIDATES_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, [DUPLICATE_CANDIDATES_HEADERS]);
            return;
        }

        await migrateDuplicateCandidatesHeaderColumns(spreadsheetId, existingHeaders);
    } catch (error) {
        if (isSheetMissingError(error)) {
            console.log('[ensureDuplicateCandidatesSheet] Creating Duplicate_Candidates sheet...');
            await addSheet(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);
            await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, [DUPLICATE_CANDIDATES_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * Duplicate_Candidates シートの全行を読む（ensure は呼ばない内部専用ヘルパー）。
 * readPublicationCandidatesRows() と同じ理由で分離している（保存のたびに ensure→全行読み取り→
 * ensure(二重)→appendRows という無駄なリクエストが積み重なるのを避けるため）。
 * 失敗時は例外をそのまま投げる（読み取り失敗を握りつぶすと、既存候補が読めないまま同じ組を
 * 二重に書きかねない。savePublicationCandidates() と同じ判断）。
 *
 * 【ヘッダー不足列の移行をここでも行う】（Issue #153 工程2 チャンク2 レビュー指摘対応）。
 * getDuplicateCandidates() を「まず読む→失敗時だけ ensure」に変えたことで、タブが既に存在する
 * 通常の読み取りでは ensureDuplicateCandidatesSheet() の「不足列を末尾へ追加する」分岐を
 * 経由しなくなった。ヘッダーが古い（新しい列が無い）タブは読み取り自体は成功してしまうため
 * catch にも入らず、移行が永久に走らなくなる（readDuplicateCandidatesRows() はヘッダー駆動の
 * ため、欠けた列は全行で undefined になり、特に status 列が欠けると
 * `(value || 'suggested')` で全件 suggested と誤認識される）。
 * この読み取りで既に得ているヘッダー行（values[0]）を migrateDuplicateCandidatesHeaderColumns()
 * にそのまま渡すことで、追加のGETなしで移行機構を維持する。ヘッダーが既に揃っている通常時は
 * missingHeaders が空になり、書き込みも発生しない。
 *
 * 【読み取り範囲はシート名のみ（全列）】（PR #161 レビュー指摘対応）。以前は
 * `A:${DUPLICATE_CANDIDATES_LAST_COLUMN}`（標準列数ぶんの終端列）で切り詰めて読んでいたが、
 * 「標準列が1本欠けている＋ユーザーが独自列を足している」シートではこの終端列がユーザー列の
 * 途中で切れてしまい、そのヘッダーを渡された migrateDuplicateCandidatesHeaderColumns() の
 * startCol がずれて、追加PUTがユーザー列のヘッダーを上書きしかねない。シート名のみの range は
 * 全列・全行を返すため、行のパースはヘッダー駆動のこのロジックを変更せずに済む。
 */
async function readDuplicateCandidatesRows(spreadsheetId: string): Promise<DuplicateCandidate[]> {
    const values = await getSheetValues(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);

    if (values.length === 0) return [];

    const headers = values[0];
    await migrateDuplicateCandidatesHeaderColumns(spreadsheetId, headers);

    if (values.length <= 1) return [];

    const rows = values.slice(1);

    return rows.map(row => {
        const candidate: Record<string, unknown> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            switch (header) {
                case 'decided_by':
                case 'decided_at':
                case 'kept_ref_id':
                    candidate[header] = value || undefined;
                    break;
                case 'status':
                    candidate[header] = (value || 'suggested') as DuplicateCandidateStatus;
                    break;
                default:
                    candidate[header] = value;
            }
        });
        return candidate as unknown as DuplicateCandidate;
    });
}

/**
 * 重複候補ペアを Duplicate_Candidates シートへ保存する。
 *
 * ensure → 既存行を読んで（readDuplicateCandidatesRows、ensureは呼ばない） filterNewDuplicatePairs()
 * で既出の組を除去 → 残りを appendRows。「取り込みを繰り返しても同じ組が再度積まれない」ことが
 * この重複除去の目的（既に決着済み・提示済みの組は再スキャンでも書き込まない）。
 *
 * 行の組み立ては savePublicationCandidates() と同じ位置ベース（ヘッダ名は見ない。
 * DUPLICATE_CANDIDATES_HEADERS の並びと1対1で対応させる）。candidate_id は crypto.randomUUID()、
 * status は常に 'suggested'、suggested_at は呼び出し時点の ISO 8601。decided_by/decided_at/
 * kept_ref_id はレビューUI（チャンク3）で使う列のため、このチャンクでは常に空文字で書く。
 */
export async function saveDuplicateCandidates(
    spreadsheetId: string,
    candidates: DuplicateCandidateDraft[]
): Promise<void> {
    if (candidates.length === 0) return;

    await ensureDuplicateCandidatesSheet(spreadsheetId);

    const existing = await readDuplicateCandidatesRows(spreadsheetId);
    const newCandidates = filterNewDuplicatePairs(existing, candidates);
    if (newCandidates.length === 0) return;

    const suggestedAt = new Date().toISOString();
    const rows = newCandidates.map(candidate => [
        crypto.randomUUID(),
        candidate.refIdA,
        candidate.refIdB,
        candidate.matchType,
        candidate.matchKey,
        'suggested',
        suggestedAt,
        '', // decided_by（チャンク3で使用）
        '', // decided_at（チャンク3で使用）
        '', // kept_ref_id（チャンク3で使用）
    ]);

    await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, rows);
}

/**
 * Duplicate_Candidates シートの全行を取得する（ヘッダ駆動。getPublicationCandidates() と同じ流儀）。
 * レビューUI（チャンク3）向けの公開API。
 *
 * 【まず読む→失敗した場合だけ ensure してから読み直す】（Issue #153 工程2 チャンク2）。
 * 以前は毎回 ensureDuplicateCandidatesSheet()（ヘッダー行のGET）→ 本体読み取り（GET）の
 * 2回GETを払っていたが、タブが既に存在し正しく移行済みという圧倒的多数のケースでも
 * 同じ2回を払い続けていた。シート・ヘッダーが既に存在する通常時は読み取り1回で成功するため、
 * その場合はensureを呼ばず1回のGETで済ませる。シート未作成（初回）の場合のみ
 * 「Unable to parse range」等で読み取りが失敗するので、その時だけ ensure → 再読み取りを行う
 * （ensureDuplicateCandidatesSheet() 自身のシート作成ロジックは変更していない）。
 *
 * 【ヘッダー不足列の移行は読み取り経路からも消していない】（レビュー指摘対応）。
 * タブは既に存在するがヘッダーに新しい列が無い（列追加前の旧シート）場合、読み取り自体は
 * 成功するため上の「まず読む」だけでは ensureDuplicateCandidatesSheet() の列追加分岐を
 * 永久に経由しなくなる。readDuplicateCandidatesRows() が自分の読み取りで得たヘッダー行を
 * migrateDuplicateCandidatesHeaderColumns() にそのまま渡して不足列を追加するため、
 * 追加のGETなしで移行機構を維持している。
 *
 * 【例外はそのまま呼び出し元へ投げる】（Issue #147。以前は
 * getPublicationCandidates() と同じ「読み取り単体は失敗を握りつぶす」流儀で失敗時に空配列を
 * 返していたが、それをやめた）。理由: この関数の失敗を候補0件に握りつぶすと、レビューUI
 * （src/sidepanel/features/duplicate-review.ts）が「未確認候補0件」「候補なし」という
 * 事実と異なる表示を出す。件数はキャッシュされるため、一時的な通信障害でも0件表示が
 * 固定化してしまう。さらに applyPairDecision() の適用直前の再読み込みも同じ関数を使っており、
 * 失敗して `[]` が返ると該当候補が見つからず「他のレビュアーが処理済み」という事実と異なる
 * 表示のまま書き込みを黙ってスキップしてしまう。0件と取得失敗を呼び出し元が区別できることが
 * 必須なため、この関数では例外を握りつぶさない（ensure後の再読み取りが失敗した場合も同様）。
 * 呼び出し元（duplicate-review.ts の全6箇所）はそれぞれ try/catch で取得失敗を検知し、
 * ユーザーへ明示的に伝える。7箇所目の呼び出し元 project.ts の loadDataAndShowScreening は
 * プロジェクト読み込み処理全体を止めないよう、失敗を console.warn で null 化して飲み込み、
 * 独立セクション（duplicate-review.ts）側の renderDuplicateReviewSection() による
 * 再取得・エラー表示に任せる（PR #161 レビュー指摘対応で追記）。
 * getPublicationCandidates() は別機能・別の呼び出し元セットのため、こちらに合わせて変更しない。
 */
export async function getDuplicateCandidates(spreadsheetId: string): Promise<DuplicateCandidate[]> {
    try {
        return await readDuplicateCandidatesRows(spreadsheetId);
    } catch (error) {
        if (isSheetMissingError(error)) {
            await ensureDuplicateCandidatesSheet(spreadsheetId);
            return await readDuplicateCandidatesRows(spreadsheetId);
        }
        throw error;
    }
}

/**
 * Duplicate_Candidates シートの候補ステータス（統合/別文献）を一括更新する（Issue #145 チャンク3向け）。
 *
 * candidate_id 列で行を特定し、status / decided_by / decided_at（この呼び出し時点の
 * ISO 8601、全件同一時刻） / kept_ref_id を更新する。列位置は updatePublicationCandidateStatus()
 * と同じ「ヘッダー行から都度引く」流儀（ハードコード禁止）。1件の候補につき4列を更新するため、
 * 全 update × 4列ぶんの range をまとめて1回の values:batchUpdate（batchUpdateRanges()）で送る。
 * ensureDuplicateCandidatesSheet() を先に呼ぶ。該当 candidate_id が見つからない更新は黙って
 * スキップする（updatePublicationCandidateStatus() と同じ振る舞い）。
 *
 * 読み取り範囲はシート名のみ（全列）。readDuplicateCandidatesRows() と同じ理由
 * （PR #161 レビュー指摘対応）で、終端列を標準列数に切り詰めるとユーザー独自列がある
 * シートで列インデックスがずれ、`Duplicate_Candidates column not found` になりうる。
 */
export async function updateDuplicateCandidateStatus(
    spreadsheetId: string,
    updates: DuplicateCandidateStatusUpdate[]
): Promise<void> {
    if (updates.length === 0) return;

    await ensureDuplicateCandidatesSheet(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);
    if (values.length <= 1) return;

    const headers = values[0];
    const candidateIdIndex = headers.indexOf('candidate_id');
    const statusIndex = headers.indexOf('status');
    const decidedByIndex = headers.indexOf('decided_by');
    const decidedAtIndex = headers.indexOf('decided_at');
    const keptRefIdIndex = headers.indexOf('kept_ref_id');

    if (candidateIdIndex === -1 || statusIndex === -1 || decidedByIndex === -1 ||
        decidedAtIndex === -1 || keptRefIdIndex === -1) {
        throw new Error('Duplicate_Candidates column not found');
    }

    const rowIndexByCandidateId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const candidateId = (row[candidateIdIndex] || '').trim();
        if (candidateId) {
            rowIndexByCandidateId.set(candidateId, index + 2);
        }
    });

    const decidedAt = new Date().toISOString();
    const columnUpdaters: Array<{ index: number; value: (u: DuplicateCandidateStatusUpdate) => string }> = [
        { index: statusIndex, value: (u) => u.status },
        { index: decidedByIndex, value: (u) => u.decidedBy },
        { index: decidedAtIndex, value: () => decidedAt },
        { index: keptRefIdIndex, value: (u) => u.keptRefId || '' },
    ];

    const batchUpdates: Array<{ range: string; values: string[][] }> = [];
    for (const update of updates) {
        const rowIndex = rowIndexByCandidateId.get(update.candidateId);
        if (!rowIndex) continue;
        for (const col of columnUpdaters) {
            batchUpdates.push({
                range: `${DUPLICATE_CANDIDATES_SHEET}!${columnNumberToLetter(col.index)}${rowIndex}`,
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

/**
 * LLM実行履歴を保存
 *
 * run_id は呼び出し側で設定済みであることを期待する。
 * 未設定の場合は空欄で保存され、次回 getLlmRuns 時の Lazy 移行で自動的に埋まる。
 */
export async function saveLlmExecution(spreadsheetId: string, execution: LlmExecution): Promise<void> {
    await ensureLlmExecutionsSheet(spreadsheetId);

    const row = [
        execution.execution_id,
        execution.execution_type,
        execution.timestamp,
        execution.model,
        execution.temperature?.toString() ?? '',
        execution.topP?.toString() ?? '',
        execution.thinkingLevel ?? '',
        execution.criteria_snapshot ? JSON.stringify(execution.criteria_snapshot) : '',
        execution.screening_prompt,
        execution.include_threshold.toString(),
        execution.target_count.toString(),
        execution.include_count.toString(),
        execution.exclude_count.toString(),
        execution.status,
        execution.is_active ? 'true' : 'false',
        execution.run_id ?? '',
        execution.requested_model ?? execution.model,
        execution.model_version ?? '',
        execution.response_id ?? '',
        execution.target_mode ?? '',
        execution.target_sets ?? '',
        execution.target_selected_count?.toString() ?? '',
        execution.executed_by ?? '',
        execution.maybe_count?.toString() ?? '',
        execution.failed_count?.toString() ?? '',
        execution.failure_breakdown ?? '',
        execution.exclude_reasons_snapshot ?? '',
    ];

    await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [row]);
}

/**
 * LLM実行履歴を取得
 *
 * 動的にヘッダーから列範囲を決めるため、シートに後から追加された列にも追従する。
 */
export async function getLlmExecutions(spreadsheetId: string): Promise<LlmExecution[]> {
    try {
        await ensureLlmExecutionsSheet(spreadsheetId);
        const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
        const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);

        if (values.length <= 1) {
            return [];
        }

        const headers = values[0];
        const rows = values.slice(1);

        return rows.map(row => {
            const execution: Record<string, unknown> = {};
            headers.forEach((header, i) => {
                const value = row[i] || '';
                switch (header) {
                    case 'include_threshold':
                        execution[header] = parseFloat(value) || 0;
                        break;
                    case 'target_count':
                    case 'include_count':
                    case 'exclude_count':
                        execution[header] = parseInt(value, 10) || 0;
                        break;
                    case 'criteria_snapshot':
                        try {
                            execution[header] = value ? JSON.parse(value) : null;
                        } catch {
                            execution[header] = null;
                        }
                        break;
                    case 'is_active':
                        execution[header] = value.toLowerCase() === 'true';
                        break;
                    case 'status':
                        execution[header] = value === 'pending' ? 'pending' : 'confirmed';
                        break;
                    case 'run_id':
                        execution[header] = value || undefined;
                        break;
                    case 'target_selected_count':
                    case 'maybe_count':
                    case 'failed_count':
                        // 0 と未設定を区別したいので `|| 0` にはしない
                        execution[header] = value ? parseInt(value, 10) : undefined;
                        break;
                    case 'target_mode':
                        execution[header] = value ? parseLlmTargetMode(value) : undefined;
                        break;
                    case 'exclude_reasons_snapshot':
                        // フルテキスト以外の実行では null（JSON文字列そのままで保持し、
                        // 中身の配列としての解釈は呼び出し側に委ねる。criteria_snapshot と違い
                        // ここではパースしない＝型は string | null のまま）
                        execution[header] = value || null;
                        break;
                    default:
                        execution[header] = value || '';
                }
            });
            return execution as unknown as LlmExecution;
        });
    } catch (error) {
        console.error('[getLlmExecutions] Error:', error);
        return [];
    }
}

/**
 * LLM実行履歴を更新
 *
 * newRow の組み立ては下の headers.map(...) がヘッダ駆動で行っており、
 * criteria_snapshot / is_active 以外の値は「数値なら toString()、それ以外は String()」
 * という一般則で素通しする。failure_breakdown を LlmExecution 側で string 型
 * （JSON文字列）にしているのはこの一般則にそのまま乗せるためで、オブジェクト型にすると
 * criteria_snapshot のような特別扱いの分岐をここに追加する必要が出てしまう。
 */
export async function updateLlmExecution(
    spreadsheetId: string,
    executionId: string,
    updates: Partial<LlmExecution>
): Promise<void> {
    console.log('[updateLlmExecution] Starting with executionId:', executionId);
    console.log('[updateLlmExecution] Updates:', updates);

    await ensureLlmExecutionsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);

    console.log('[updateLlmExecution] Sheet rows count:', values.length);

    if (values.length <= 1) {
        throw new Error('Execution not found');
    }

    // execution_idで行を検索
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
        if (values[i][0] === executionId) {
            rowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Execution not found: ${executionId}`);
    }

    const currentRow = values[rowIndex - 1];
    const headers = values[0];

    // 更新行を構築
    const newRow = headers.map((header, i) => {
        if (updates[header as keyof LlmExecution] !== undefined) {
            const value = updates[header as keyof LlmExecution];
            if (header === 'criteria_snapshot') {
                return value ? JSON.stringify(value) : '';
            } else if (header === 'is_active') {
                return value ? 'true' : 'false';
            } else if (typeof value === 'number') {
                return value.toString();
            } else {
                return String(value);
            }
        }
        return currentRow[i] || '';
    });

    await updateRange(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A${rowIndex}:${endCol}${rowIndex}`, [newRow]);
}

// ============================================================
// LLM_Runs シート I/O (Run = config_hash 単位の論理実行)
// ============================================================

/**
 * 行配列を LlmRun に変換
 */
function parseLlmRunRow(row: string[], headers: string[]): LlmRun {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
        const value = row[i] || '';
        switch (header) {
            case 'include_threshold':
                obj[header] = parseFloat(value) || 0;
                break;
            case 'temperature':
            case 'topP':
                obj[header] = value ? parseFloat(value) : undefined;
                break;
            case 'criteria_snapshot':
                try {
                    obj[header] = value ? JSON.parse(value) : null;
                } catch {
                    obj[header] = null;
                }
                break;
            case 'is_active':
                obj[header] = value.toLowerCase() === 'true';
                break;
            case 'status':
                obj[header] = value === 'pending' ? 'pending' : 'confirmed';
                break;
            case 'thinkingLevel':
                obj[header] = value || undefined;
                break;
            default:
                obj[header] = value || '';
        }
    });
    return obj as unknown as LlmRun;
}

/**
 * LlmRun を行配列にシリアライズ（LLM_RUNS_HEADERS の順序に従う）
 */
function serializeLlmRunRow(run: LlmRun): string[] {
    return LLM_RUNS_HEADERS.map(header => {
        const value = (run as unknown as Record<string, unknown>)[header];
        if (value === undefined || value === null) return '';
        if (header === 'criteria_snapshot') {
            return value ? JSON.stringify(value) : '';
        }
        if (header === 'is_active') {
            return value ? 'true' : 'false';
        }
        if (typeof value === 'number') {
            return value.toString();
        }
        return String(value);
    });
}

/**
 * LLM_Runs シートの全 Run 行を生データのまま取得（移行を起こさない内部関数）
 */
async function getLlmRunsRaw(spreadsheetId: string): Promise<LlmRun[]> {
    await ensureLlmRunsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_RUNS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!A:${endCol}`);
    if (values.length <= 1) return [];
    const headers = values[0];
    return values.slice(1).map(row => parseLlmRunRow(row, headers));
}

/**
 * LLM_Runs に新規 Run を追加
 */
export async function saveLlmRun(spreadsheetId: string, run: LlmRun): Promise<void> {
    await ensureLlmRunsSheet(spreadsheetId);
    await appendRows(spreadsheetId, LLM_RUNS_SHEET, [serializeLlmRunRow(run)]);
}

/**
 * LLM_Runs の Run を更新
 */
export async function updateLlmRun(
    spreadsheetId: string,
    runId: string,
    updates: Partial<LlmRun>
): Promise<void> {
    await ensureLlmRunsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_RUNS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!A:${endCol}`);

    if (values.length <= 1) {
        throw new Error('Run not found');
    }

    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
        if (values[i][0] === runId) {
            rowIndex = i + 1;
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Run not found: ${runId}`);
    }

    const headers = values[0];
    const currentRow = values[rowIndex - 1];

    const newRow = headers.map((header, i) => {
        if (updates[header as keyof LlmRun] !== undefined) {
            const value = updates[header as keyof LlmRun];
            if (header === 'criteria_snapshot') {
                return value ? JSON.stringify(value) : '';
            }
            if (header === 'is_active') {
                return value ? 'true' : 'false';
            }
            if (typeof value === 'number') {
                return value.toString();
            }
            return String(value);
        }
        return currentRow[i] || '';
    });

    await updateRange(spreadsheetId, `${LLM_RUNS_SHEET}!A${rowIndex}:${endCol}${rowIndex}`, [newRow]);
}

/**
 * 複数 Batch row の run_id を一括更新（移行用）
 */
async function updateExecutionRunIds(
    spreadsheetId: string,
    assignments: Array<{ executionId: string; runId: string }>
): Promise<void> {
    if (assignments.length === 0) return;

    await ensureLlmExecutionsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);
    if (values.length <= 1) return;

    const headers = values[0];
    const runIdColIndex = headers.indexOf('run_id');
    if (runIdColIndex === -1) {
        throw new Error('run_id column not found in LLM_Executions');
    }

    const rowIndexByExecutionId = new Map<string, number>();
    values.slice(1).forEach((row, idx) => {
        const id = (row[0] || '').trim();
        if (id) rowIndexByExecutionId.set(id, idx + 2);
    });

    const runIdCol = columnNumberToLetter(runIdColIndex);
    const updates = assignments
        .map(({ executionId, runId }) => {
            const rowIndex = rowIndexByExecutionId.get(executionId);
            if (!rowIndex) return null;
            return {
                range: `${LLM_EXECUTIONS_SHEET}!${runIdCol}${rowIndex}`,
                values: [[runId]],
            };
        })
        .filter((u): u is { range: string; values: string[][] } => u !== null);

    const batchSize = 500;
    for (let i = 0; i < updates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, updates.slice(i, i + batchSize));
    }
}

/**
 * 既存 LLM_Executions の Batch row のうち run_id が空のものを Run に集約する。
 *
 * 集約方針:
 * - execution_type='batch_screening' のみを対象
 * - config_hash でグループ化（criteria/prompt 欠損 row は legacy:<execution_id> で孤立）
 * - 既存 LLM_Runs に同 config_hash がある → run_id 再利用
 * - 無い → 新規 Run 作成。属性は配下バッチから優先順位で決定:
 *     1. is_active=true かつ confirmed
 *     2. 最新 confirmed
 *     3. 最新 row（pending 扱い）
 *
 * 冪等性: run_id 空の row のみを処理するため、複数回呼んでも安全。
 */
async function migrateLegacyExecutionsToRuns(
    spreadsheetId: string,
    existingRuns: LlmRun[],
    allBatches: LlmExecution[]
): Promise<{ runs: LlmRun[]; newRuns: LlmRun[]; assignments: Array<{ executionId: string; runId: string }> }> {
    const targets = allBatches.filter(
        b => b.execution_type === 'batch_screening' && !b.run_id
    );

    if (targets.length === 0) {
        return { runs: existingRuns, newRuns: [], assignments: [] };
    }

    // 各 Batch のハッシュを計算
    const targetHashes = await Promise.all(
        targets.map(async batch => {
            if (!isHashable(batch)) {
                return { batch, hash: legacyHash(batch.execution_id) };
            }
            const hash = await computeConfigHash({
                model: batch.model,
                temperature: batch.temperature,
                topP: batch.topP,
                thinkingLevel: batch.thinkingLevel,
                criteria_snapshot: batch.criteria_snapshot,
                screening_prompt: batch.screening_prompt,
            });
            return { batch, hash };
        })
    );

    // config_hash ごとにグループ化
    const groups = new Map<string, LlmExecution[]>();
    for (const { batch, hash } of targetHashes) {
        const list = groups.get(hash) ?? [];
        list.push(batch);
        groups.set(hash, list);
    }

    // 同一 config_hash の Run が複数ある（＝「新規にやり直す」を使った）場合、
    // legacy バッチはやり直しより前の実行なので最も古い Run に属させる
    const runByHash = new Map<string, LlmRun>();
    for (const run of existingRuns) {
        if (runByHash.has(run.config_hash)) continue;
        const picked = pickLegacyRunByConfigHash(existingRuns, run.config_hash);
        if (picked) runByHash.set(run.config_hash, picked);
    }

    const newRuns: LlmRun[] = [];
    const assignments: Array<{ executionId: string; runId: string }> = [];

    for (const [hash, batches] of groups.entries()) {
        let run = runByHash.get(hash);

        if (!run) {
            // 新規 Run を作成
            const sorted = [...batches].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            const oldest = sorted[0];

            // 属性決定: active confirmed > 最新 confirmed > 最新 row
            const activeConfirmed = batches.find(b => b.is_active && b.status === 'confirmed');
            const confirmedSorted = batches
                .filter(b => b.status === 'confirmed')
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const latestSorted = [...batches].sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            const sourceForAttrs = activeConfirmed ?? confirmedSorted[0] ?? latestSorted[0];

            run = {
                run_id: crypto.randomUUID(),
                config_hash: hash,
                created_at: oldest.timestamp,
                model: sourceForAttrs.model,
                requested_model: sourceForAttrs.requested_model ?? sourceForAttrs.model,
                model_version: sourceForAttrs.model_version,
                response_id: sourceForAttrs.response_id,
                temperature: sourceForAttrs.temperature,
                topP: sourceForAttrs.topP,
                thinkingLevel: sourceForAttrs.thinkingLevel,
                criteria_snapshot: sourceForAttrs.criteria_snapshot,
                screening_prompt: sourceForAttrs.screening_prompt,
                include_threshold: sourceForAttrs.include_threshold,
                status: sourceForAttrs.status,
                is_active: Boolean(activeConfirmed),
            };
            newRuns.push(run);
            runByHash.set(hash, run);
        }

        for (const batch of batches) {
            assignments.push({ executionId: batch.execution_id, runId: run.run_id });
        }
    }

    // 永続化
    if (newRuns.length > 0) {
        const rows = newRuns.map(serializeLlmRunRow);
        await appendRows(spreadsheetId, LLM_RUNS_SHEET, rows);
    }
    if (assignments.length > 0) {
        await updateExecutionRunIds(spreadsheetId, assignments);
    }

    return {
        runs: [...existingRuns, ...newRuns],
        newRuns,
        assignments,
    };
}

/**
 * LLM_Runs シートの全 Run を取得する。
 *
 * 呼び出し時に Lazy 移行を実行:
 * - LLM_Executions に run_id 列が無ければ追加
 * - run_id 空の Batch row を config_hash で集約して Run を生成
 */
export async function getLlmRuns(spreadsheetId: string): Promise<LlmRun[]> {
    return (await getLlmHistory(spreadsheetId)).llmRuns;
}

/**
 * 履歴を一度ずつ読み、移行後の所属情報も同じロード内のスナップショットへ反映する。
 * 初回は各タブのヘッダー確認＋本体取得の2回。内容はモジュールに保持しない。
 * 旧形式移行が必要な場合は、所属を書き込む直前の行位置確認の取得も従来どおり行う。
 */
export async function getLlmHistory(spreadsheetId: string): Promise<{
    llmRuns: LlmRun[]; llmExecutions: LlmExecution[];
}> {
    const executionsPromise = getLlmExecutions(spreadsheetId);
    try {
        const [existingRuns, allBatches] = await Promise.all([
            getLlmRunsRaw(spreadsheetId),
            executionsPromise,
        ]);

        const { runs, assignments } = await migrateLegacyExecutionsToRuns(
            spreadsheetId,
            existingRuns,
            allBatches
        );

        const runIds = new Map(assignments.map(a => [a.executionId, a.runId]));
        return {
            llmRuns: runs,
            llmExecutions: allBatches.map(batch => {
                const runId = runIds.get(batch.execution_id);
                return runId ? { ...batch, run_id: runId } : batch;
            }),
        };
    } catch (error) {
        console.error('[getLlmRuns] Error:', error);
        return { llmRuns: [], llmExecutions: await executionsPromise };
    }
}

// ============================================================
// Run/Batch 結合・active 解決ヘルパー
// ============================================================

/**
 * config_hash で Run を検索する。
 * 「新規にやり直す」により同一 config_hash の Run が複数存在しうるため、
 * 優先順位は最新 created_at（同時刻なら active confirmed > confirmed > pending）。
 */
export async function findRunByConfigHash(
    spreadsheetId: string,
    configHash: string
): Promise<LlmRun | null> {
    const runs = await getLlmRuns(spreadsheetId);
    return pickRunByConfigHash(runs, configHash);
}

/**
 * 現在の active Run（is_active=true かつ confirmed）を1件返す。
 * 複数候補があれば created_at が新しい方を採用。
 */
export async function getActiveLlmRun(spreadsheetId: string, loadedRuns?: LlmRun[]): Promise<LlmRun | null> {
    const runs = loadedRuns ?? await getLlmRuns(spreadsheetId);
    const candidates = runs
        .filter(r => r.is_active && r.status === 'confirmed')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return candidates[0] ?? null;
}

/**
 * Batch ID から所属する Run を逆引きする。
 */
export async function getRunForBatchId(
    spreadsheetId: string,
    batchId: string
): Promise<LlmRun | null> {
    const [runs, batches] = await Promise.all([
        getLlmRuns(spreadsheetId),
        getLlmExecutions(spreadsheetId),
    ]);
    const batch = batches.find(b => b.execution_id === batchId);
    if (!batch || !batch.run_id) return null;
    return runs.find(r => r.run_id === batch.run_id) ?? null;
}

/**
 * 指定 Run に属する全 Batch ID（execution_id）を返す。
 */
export async function getBatchIdsForRun(
    spreadsheetId: string,
    runId: string,
    batches?: LlmExecution[]
): Promise<Set<string>> {
    const all = batches ?? await getLlmExecutions(spreadsheetId);
    return new Set(
        all
            .filter(b => b.execution_type === 'batch_screening' && b.run_id === runId)
            .map(b => b.execution_id)
    );
}

/**
 * 指定した Batch ID 群が既に判定した ref_id の集合を Sheets から取得する。
 *
 * バッチ実行直前の対象確定に使う。state.references[].llmBatchIds は画面ロード時の
 * スナップショットなので、他レビュアーが直前に判定した分を取りこぼす。同一 Run に
 * 同じ文献の LLM 票が二重に入るのを防ぐため、実行時だけはサーバーの真値を読み直す。
 *
 * getSheetValues はキャッシュしないので、この呼び出しは必ず最新を返す（読み取り1リクエスト）。
 */
export async function getJudgedRefIdsForBatches(
    spreadsheetId: string,
    batchIds: ReadonlySet<string>
): Promise<Set<string>> {
    if (batchIds.size === 0) return new Set();

    // 抽出ロジック（Run 単位の絞り込み・trim 正規化）は collectJudgedRefIds に集約しテスト対象にしている。
    // ここは Sheets から読み取って渡すだけの薄いラッパー。
    const decisionsData = await getDecisions(spreadsheetId);
    return collectJudgedRefIds(decisionsData.map(({ decision }) => decision), batchIds);
}

/**
 * active Run 配下の全 Batch IDs を返す。Decisions の絞り込みに使う。
 * batches を渡せば再フェッチを省略する。
 */
export async function getActiveBatchIdsForActiveRun(
    spreadsheetId: string,
    batches?: LlmExecution[],
    runs?: LlmRun[]
): Promise<Set<string>> {
    const activeRun = await getActiveLlmRun(spreadsheetId, runs);
    if (!activeRun) return new Set();
    return getBatchIdsForRun(spreadsheetId, activeRun.run_id, batches);
}

/**
 * 指定 Run のみを active=true にし、他の Run は false に切り替える。
 * 同一 spreadsheet 内で active な Run は常に高々1つの不変条件を保つ。
 */
export async function setSingleActiveRun(spreadsheetId: string, runId: string): Promise<void> {
    const runs = await getLlmRuns(spreadsheetId);
    for (const run of runs) {
        const shouldBeActive = run.run_id === runId;
        if (run.is_active !== shouldBeActive) {
            await updateLlmRun(spreadsheetId, run.run_id, { is_active: shouldBeActive });
        }
    }
}


