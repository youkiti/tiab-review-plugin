// プロジェクトの取得窓口。取得結果の共有は1回の読み込み処理内に限定し、
// モジュールスコープには保持しない（Issue #153）。

import type { Reference, Decision, ReferenceWithStatus, LlmExecution, LlmRun, AssignmentConfig, DuplicateCandidate } from '../types';
import type { ProjectConfigBundle } from './config-schema';
import { DEFAULT_CONFIG_BUNDLE, parseConfigBundle, parseAssignmentConfig, parseFulltextAiActiveRound } from './config-schema';
import { REFERENCES_SHEET, REFERENCES_LAST_COLUMN, DECISIONS_SHEET, DECISIONS_LAST_COLUMN, CONFIG_SHEET } from './schema';
import { getSheetValuesBatch } from './transport';
import { parseReferenceValues, parseDecisionValues } from './codecs';
import { getReferences } from './references';
import { getDecisions, collapseToLatestDecisions, primeDecisionRowCache, filterDecisionsForBlind } from './decisions';
import { getFulltextAiActiveRound } from './config';
import { getLlmHistory, getLlmExecutions, getActiveBatchIdsForActiveRun, selectActiveBatchIds } from './llm-history';
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
 */
export function selectReferencesWithStatus(snapshot: ProjectSnapshot, userEmail: string): ReferenceWithStatus[] {
    if (!snapshot.configBundle.keyOpened) {
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
 * 入力は書き換えない。正規化はコピーへ行う（Issue #153。以前は in-place だったため PR #161 で呼び出し側にシャローコピーを入れていた）。
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
    const [allReferences, decisionsData] = await Promise.all([
        loaded?.allReferences ?? getReferences(spreadsheetId),
        loaded?.decisionsData ?? getDecisions(spreadsheetId),
    ]);
    return mergeReferencesWithStatus(allReferences, decisionsData, reviewerEmail);
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
    const [allReferences, decisionsData, llmExecutions, activeFulltextAiRound] = await Promise.all([
        loaded?.allReferences ?? getReferences(spreadsheetId),
        loaded?.decisionsData ?? getDecisions(spreadsheetId),
        loaded?.llmExecutions ?? getLlmExecutions(spreadsheetId),
        loaded?.fulltextAiActiveRound !== undefined
            ? loaded.fulltextAiActiveRound : getFulltextAiActiveRound(spreadsheetId),
    ]);
    const activeBatchIds = await getActiveBatchIdsForActiveRun(spreadsheetId, llmExecutions, loaded?.llmRuns);
    return mergeReferencesWithAllDecisions(allReferences, decisionsData, reviewerEmail, activeBatchIds, activeFulltextAiRound);
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
    const snapshot = await loadProjectSnapshot(spreadsheetId, userEmail, { history: false, duplicateCandidates: false });
    return { references: snapshot.references, decisions: snapshot.visibleDecisions, config: snapshot.configBundle };
}

