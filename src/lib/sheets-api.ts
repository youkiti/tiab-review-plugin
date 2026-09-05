// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, LlmExecution, LlmRun } from './types';
import { platform } from '../platform';
import { AUDIT_LOG_HEADERS, buildAuditEventRow } from './audit-log';
import { isLogicallyDeleted } from './duplicate-detect';
import type { AuditLogEvent } from './audit-log';

import {
    SHEETS_API_BASE,
    SheetsAccessDeniedError,
    isSheetsAccessDeniedStatus,
    readSheetsErrorMessage,
    getAuthToken,
    getSheetValues,
    getSheetValuesBatch,
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
import { getLlmExecutions, getActiveBatchIdsForActiveRun } from './sheets/llm-history';
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
    getLlmExecutions,
    getActiveBatchIdsForActiveRun,
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
export {
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
