// プロジェクトの取得窓口。取得結果の共有は1回の読み込み処理内に限定し、
// モジュールスコープには保持しない（Issue #153）。

import type { Reference, Decision, ReferenceWithStatus, LlmExecution, LlmRun, AssignmentConfig, DuplicateCandidate } from '../types';
import type { ProjectConfigBundle } from './config-schema';
import { DEFAULT_CONFIG_BUNDLE, parseConfigBundle, parseAssignmentConfig, parseFulltextAiActiveRound } from './config-schema';
import { REFERENCES_SHEET, REFERENCES_LAST_COLUMN, DECISIONS_SHEET, DECISIONS_LAST_COLUMN, CONFIG_SHEET } from './schema';
import { getSheetValuesBatch } from './transport';
import { parseReferenceValues, parseDecisionValues } from './codecs';
import { collapseToLatestDecisions, primeDecisionRowCache, filterDecisionsForBlind } from './decisions';
import { getLlmHistory, selectActiveBatchIds } from './llm-history';
import { getDuplicateCandidates } from './duplicate-candidates';
import { isLogicallyDeleted } from '../duplicate-detect';
import { mergeReferencesWithStatus, mergeReferencesWithAllDecisions } from '../reference-status';

export interface ProjectSnapshotParts {
    /** LLM_Runs / LLM_Executions を読むか（既定 true） */
    history?: boolean;
    /** Duplicate_Candidates を読むか（既定 true） */
    duplicateCandidates?: boolean;
}

export interface ProjectSnapshot {
    spreadsheetId: string;
    /** 論理削除済み行を含む全件（getReferences() と同じ契約） */
    allReferences: Reference[];
    /** 論理削除済み行を除いた一覧 */
    references: Reference[];
    /** 畳み込み済み・全レビュアー分（getDecisions() と同じ契約。行番号キャッシュも温める） */
    decisionsData: { decision: Decision; rowIndex: number }[];
    /** filterDecisionsForBlind(decisionsData, configBundle.keyOpened, userEmail) の結果 */
    visibleDecisions: { decision: Decision; rowIndex: number }[];
    configBundle: ProjectConfigBundle;
    assignmentConfig: AssignmentConfig;
    fulltextAiActiveRound: string | null;
    /** parts.history === false なら null */
    llmRuns: LlmRun[] | null;
    llmExecutions: LlmExecution[] | null;
    /** selectActiveBatchIds(llmRuns, llmExecutions)。履歴を読んでいなければ空 */
    activeBatchIds: Set<string>;
    /** parts.duplicateCandidates === false、または取得失敗（console.warn）なら null */
    duplicateCandidates: DuplicateCandidate[] | null;
}

export async function loadProjectSnapshot(
    spreadsheetId: string,
    userEmail: string,
    parts: ProjectSnapshotParts = {}
): Promise<ProjectSnapshot> {
    const ranges = [
        `${REFERENCES_SHEET}!A:${REFERENCES_LAST_COLUMN}`,
        `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`,
        `${CONFIG_SHEET}!A:B`,
    ];
    const [values, history, duplicateCandidates] = await Promise.all([
        getSheetValuesBatch(spreadsheetId, ranges).catch(async (error) => {
            // Config タブがない旧シートでは batchGet 全体が失敗するため、Config 抜きで再試行。
            if (!(error as Error).message.includes('Unable to parse range')) throw error;
            console.log('[loadProjectSnapshot] Config sheet missing, falling back:', error);
            return getSheetValuesBatch(spreadsheetId, ranges.slice(0, 2));
        }),
        parts.history !== false ? getLlmHistory(spreadsheetId) : null,
        parts.duplicateCandidates !== false ? getDuplicateCandidates(spreadsheetId).catch((error) => {
            console.warn('[loadProjectSnapshot] Duplicate_Candidates の取得に失敗:', error);
            return null;
        }) : null,
    ]);
    const [refValues, decValues, configValues] = values;
    const configBundle = configValues === undefined ? { ...DEFAULT_CONFIG_BUNDLE } : parseConfigBundle(configValues);
    const assignmentConfig = parseAssignmentConfig(configValues ?? []);
    const fulltextAiActiveRound = configValues === undefined ? null : parseFulltextAiActiveRound(configValues);
    const allReferences = parseReferenceValues(refValues);
    const decisionsData = collapseToLatestDecisions(parseDecisionValues(decValues));
    primeDecisionRowCache(spreadsheetId, decisionsData);
    const llmRuns = history?.llmRuns ?? null;
    const llmExecutions = history?.llmExecutions ?? null;
    return {
        spreadsheetId,
        allReferences,
        references: allReferences.filter(ref => !isLogicallyDeleted(ref)),
        decisionsData,
        visibleDecisions: filterDecisionsForBlind(decisionsData, configBundle.keyOpened, userEmail),
        configBundle,
        assignmentConfig,
        fulltextAiActiveRound,
        llmRuns,
        llmExecutions,
        activeBatchIds: llmRuns && llmExecutions ? selectActiveBatchIds(llmRuns, llmExecutions) : new Set(),
        duplicateCandidates,
    };
}

/**
 * keyOpened に応じて合成関数を選ぶ。
 * キー開封後は履歴が必須。未取得のまま合成すると LLM 票が全て落ちるため例外にする（Issue #153）。
 * キー切替は取得後に Config を書き換えるため、取得時の key_opened は切替前の値になる。
 * 切替後の keyOpened を呼び出し側から上書きできるようにする（Issue #153）。
 */
export function selectReferencesWithStatus(
    snapshot: ProjectSnapshot,
    userEmail: string,
    keyOpened: boolean = snapshot.configBundle.keyOpened
): ReferenceWithStatus[] {
    if (!keyOpened) {
        return mergeReferencesWithStatus(snapshot.allReferences, snapshot.decisionsData, userEmail);
    }
    if (snapshot.llmRuns === null || snapshot.llmExecutions === null) {
        throw new Error('キー開封後の判定合成にはLLM履歴の取得が必要です');
    }
    return mergeReferencesWithAllDecisions(
        snapshot.allReferences, snapshot.decisionsData, userEmail,
        snapshot.activeBatchIds, snapshot.fulltextAiActiveRound
    );
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
 * 論理削除された行（重複）は references から除外する。理由は mergeReferencesWithStatus()
 * の JSDoc を参照（Issue #145 チャンク2 / PR #146 レビュー指摘）。Config タブが無い旧シート向けの
 * フォールバック経路（catch 節側）でも同様に除外する。
 */
export async function getFulltextPageData(spreadsheetId: string, userEmail: string): Promise<{
    references: Reference[];
    decisions: { decision: Decision; rowIndex: number }[];
    config: ProjectConfigBundle;
}> {
    const snapshot = await loadProjectSnapshot(spreadsheetId, userEmail, { history: false, duplicateCandidates: false });
    return { references: snapshot.references, decisions: snapshot.visibleDecisions, config: snapshot.configBundle };
}

