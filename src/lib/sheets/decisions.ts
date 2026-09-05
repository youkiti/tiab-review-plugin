// decisions.ts - Decisions タブの読み書き・行番号キャッシュ・最新判定への畳み込み
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema、行変換は ./codecs を参照。
// References タブ側は ./references を参照（本ファイルからは import しない）。

import type { Decision } from '../types';
import { isHumanDecision, isConfirmedMlDecision } from '../client-version';
import { isDecisionVisibleDuringBlind } from '../blind-visibility';
import {
    SHEETS_API_BASE,
    getAuthToken,
    getSheetValues,
    appendRows,
    updateRange,
} from './transport';
import { DECISIONS_SHEET, DECISIONS_LAST_COLUMN } from './schema';
import { parseDecisionValues } from './codecs';

/**
 * Decisions タブから生の全行を取得する（畳み込みなし）。
 * 追記専用化（human / ML手動確認の判定は append のみ）により同一キーの行が複数残るため、
 * 判定イベントの履歴そのものが必要な箇所（deleteFulltextAiRound など）だけがこれを使うこと。
 * 通常の読み取りは getDecisions() の畳み込み結果を使う。外部へは export しない。
 */
export async function getDecisionsRaw(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`);
    return parseDecisionValues(values);
}

/**
 * Decisions タブから判定一覧を取得。
 * 追記専用化により同一 (ref_id, reviewer_id, screening_phase) の行が複数存在しうるため、
 * ここで各キーの最新1行へ畳み込んでから返す（下流のUI・集計は従来どおり最新判定のみを見る）。
 */
export async function getDecisions(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const rawData = await getDecisionsRaw(spreadsheetId);
    const decisionsData = collapseToLatestDecisions(rawData);
    // 全件読み取ったタイミングで行番号キャッシュ・保存内容スナップショットを温める（saveDecision の読み取り/重複防止用）
    primeDecisionRowCache(spreadsheetId, decisionsData);
    return decisionsData;
}

/**
 * 自分のフルテキストフェーズ判定を ref_id 別にマップ化（最新優先）
 * TiAb 画面の集計からは除外されるが、フルテキストタブの状態表示に使う
 */
export function buildMyFulltextDecisionMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    normalizedReviewerEmail: string
): Map<string, Decision> {
    const map = new Map<string, Decision>();
    if (!normalizedReviewerEmail) return map;
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId || reviewerId !== normalizedReviewerEmail) return;
        const existing = map.get(refId);
        if (!existing || (decision.decided_at || '') > (existing.decided_at || '')) {
            map.set(refId, decision);
        }
    });
    return map;
}

/**
 * 全レビュアー（および有効な LLM）のフルテキストフェーズ判定を ref_id 別にマップ化する。
 * TiAb の allDecisions と同じ構造で、結果集計（判定者選択・OR合議・不一致検出）に使う。
 * 無効な LLM 判定（active Run 配下でない reviewer_id）は除外する。
 */
export function buildAllFulltextDecisionsMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    activeFulltextAiRound: string | null
): Map<string, Decision[]> {
    const map = new Map<string, Decision[]>();
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        if (refId !== decision.ref_id) decision.ref_id = refId;
        const reviewerId = (decision.reviewer_id || '').trim();
        if (reviewerId && reviewerId !== decision.reviewer_id) decision.reviewer_id = reviewerId;
        // フルテキストAI判定(llm:)は「採用ラウンド」のものだけを有効にする。
        // 採用ラウンド未設定、または別ラウンドの判定は集計から除外する。
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!activeFulltextAiRound || decision.reviewer_id !== activeFulltextAiRound) {
                return;
            }
        }
        const list = map.get(refId);
        if (list) list.push(decision);
        else map.set(refId, [decision]);
    });
    return map;
}

/**
 * 不一致を検出
 * - 2人以上の判定がある場合、判定内容が異なれば不一致
 * - どちらか一方が未判定（pendingまたは判定なし）の場合も不一致
 *
 * PR #138 レビュー指摘（未送信キューのマージ後に hasConflict/status が再計算されない問題）:
 * `src/lib/queued-decisions-merge.ts` の `mergeQueuedDecisions` からも同じ規則で
 * hasConflict を再計算できるよう export する（実装はここまで変更していない）。
 */
export function detectConflict(decisions: Decision[]): boolean {
    // 判定がない、または1人のみの場合は不一致なし
    if (decisions.length === 0) {
        return false;
    }

    if (decisions.length === 1) {
        // 1人だけ判定済み = もう1人が未判定 = 不一致
        return true;
    }

    // 2人以上の判定がある場合、判定内容をチェック
    const uniqueDecisions = new Set(decisions.map(d => d.decision));
    return uniqueDecisions.size > 1;
}

// ---------------------------------------------------------------------------
// Decisions 行番号キャッシュ（判定保存のクォータ削減用）
//
// saveDecision() が判定1件ごとに Decisions!A:K を全件読み取ると、読み取りクォータ
// （60回/分/ユーザー）を連打時に即座に超過してしまう。getDecisions() 等で読んだ内容から
// 「key(ref_id+reviewer_id+phase) -> シート行番号」のキャッシュを作っておき、
// saveDecision() では原則キャッシュだけで既存行の有無を判定する（読み取り0回で保存する）。
// ---------------------------------------------------------------------------

/**
 * キャッシュの有効期限。他ユーザーがDecisionsの行を削除した場合、行番号がずれて
 * 古いキャッシュのまま上書きすると他人の判定を破壊しかねない。その巻き添えの窓を
 * このTTLの範囲に限定するための安全弁であり、省略してはならない。
 */
const DECISION_ROW_CACHE_TTL_MS = 60_000;

let decisionRowCache: {
    spreadsheetId: string;
    builtAt: number;
    rows: Map<string, number>; // key -> シート行番号（1始まり）
} | null = null;

/**
 * 追記対象（human / ML手動確認）の判定保存内容。同一内容の連続保存をスキップする判定に使う。
 * context_json は意図的に含めない: AIハイライト表示やキー開閉状態などUI状態が変わっただけで
 * decision/reason/note が同一の再保存まで「別内容」と判定してしまうと、UI操作のたびに
 * 同一判定が別行として積まれてしまう（追記専用化の重複防止という目的に反する）。
 */
interface DecisionContentSnapshot {
    decision: string;
    reason: string;
    note: string;
}

/**
 * decisionRowCache と同じライフサイクル（同一 spreadsheetId スコープ + TTL +
 * invalidateDecisionRowCache() での破棄）で保持する、直近保存内容のスナップショットキャッシュ。
 * decisionRowCache.rows は「absent = 全件読み取り済みでキーが存在しないことが確定」という
 * 意味を持つため、ここへ部分的な書き込みを混ぜると ML/LLM側の hit/absent/cold 判定を
 * 汚染しかねない。意味が異なるため別オブジェクトとして分離する。
 */
let decisionContentCache: {
    spreadsheetId: string;
    builtAt: number;
    latest: Map<string, DecisionContentSnapshot>; // key -> 直近保存内容
} | null = null;

/** Decision から比較用のスナップショットを作る（undefined と '' を同一視するため ?? '' で正規化） */
function contentSnapshotOf(decision: Decision): DecisionContentSnapshot {
    return {
        decision: decision.decision ?? '',
        reason: decision.reason ?? '',
        note: decision.note ?? '',
    };
}

function isSameDecisionContent(a: DecisionContentSnapshot, b: DecisionContentSnapshot): boolean {
    return a.decision === b.decision && a.reason === b.reason && a.note === b.note;
}

/** Decisions 行番号キャッシュのキーを組み立てる（ref_id/reviewer_id は trim、phase 省略時は 'tiab'） */
function decisionRowKey(refId: string, reviewerId: string, phase: string | undefined): string {
    return `${(refId || '').trim()}\u0000${(reviewerId || '').trim()}\u0000${phase ?? 'tiab'}`;
}

/**
 * a が b より新しい判定行かどうかを判定する。
 * decided_at はISO 8601文字列のため辞書順比較で時系列順になる。同値の場合はシート上で
 * 後にある行（rowIndex が大きい行）を新しいとみなす（同一 decided_at での追記順を優先）。
 */
function isNewerDecisionRow(
    a: { decision: Decision; rowIndex: number },
    b: { decision: Decision; rowIndex: number }
): boolean {
    const aTime = a.decision.decided_at || '';
    const bTime = b.decision.decided_at || '';
    if (aTime !== bTime) return aTime > bTime;
    return a.rowIndex > b.rowIndex;
}

/**
 * Decisions の生行を (ref_id, reviewer_id, screening_phase) ごとに最新1行へ畳み込む。
 * 追記専用化により同一キーの行が複数残るようになったため、UI・集計を含む下流の挙動を
 * 従来（最新判定のみが有効）どおりに保つには、読み取りの入口でここを通す必要がある。
 * 出力の並び順は入力の行順（rowIndex 昇順）を維持する。
 */
export function collapseToLatestDecisions(
    rows: { decision: Decision; rowIndex: number }[]
): { decision: Decision; rowIndex: number }[] {
    const latestByKey = new Map<string, { decision: Decision; rowIndex: number }>();
    for (const row of rows) {
        const key = decisionRowKey(row.decision.ref_id, row.decision.reviewer_id, row.decision.screening_phase);
        const current = latestByKey.get(key);
        if (!current || isNewerDecisionRow(row, current)) {
            latestByKey.set(key, row);
        }
    }
    const winners = new Set(latestByKey.values());
    return rows.filter(row => winners.has(row));
}

/**
 * decisionRowCache の参照結果。
 * ヒット/ミスの2値にすると「キャッシュはあるが未知のキー＝新規行」と
 * 「キャッシュ自体が無効」を区別できず、初回判定のたびに読み取りが発生して
 * 効果が半減してしまう。必ず3値で返すこと。
 */
type DecisionRowLookup =
    | { state: 'cold' }                   // キャッシュ無効/期限切れ/別シート → 従来どおり読む
    | { state: 'hit'; rowIndex: number }  // 既存行あり → updateRange
    | { state: 'absent' };                // キャッシュは有効だがキー無し = 新規行 → 読まずに append

function getCachedDecisionRow(spreadsheetId: string, key: string): DecisionRowLookup {
    if (!decisionRowCache) return { state: 'cold' };
    if (decisionRowCache.spreadsheetId !== spreadsheetId) return { state: 'cold' };
    if (Date.now() - decisionRowCache.builtAt > DECISION_ROW_CACHE_TTL_MS) return { state: 'cold' };
    const rowIndex = decisionRowCache.rows.get(key);
    return rowIndex !== undefined ? { state: 'hit', rowIndex } : { state: 'absent' };
}

/**
 * getDecisions() / getFulltextPageData() など、Decisions を rowIndex 付きで全件取得した
 * 直後に必ず呼び、キャッシュを温める。呼び出し側は畳み込み後（各キーの最新1行）のデータを
 * 渡すこと。生データを渡すと古い rowIndex や内容がキャッシュに乗る危険がある。
 * 併せて、同キーの直近保存内容スナップショット（decisionContentCache）も同時に構築する。
 */
export function primeDecisionRowCache(
    spreadsheetId: string,
    decisionsData: { decision: Decision; rowIndex: number }[]
): void {
    const rows = new Map<string, number>();
    const latestContent = new Map<string, DecisionContentSnapshot>();
    for (const { decision, rowIndex } of decisionsData) {
        const key = decisionRowKey(decision.ref_id, decision.reviewer_id, decision.screening_phase);
        if (!rows.has(key)) {
            rows.set(key, rowIndex);
        }
        latestContent.set(key, contentSnapshotOf(decision));
    }
    decisionRowCache = { spreadsheetId, builtAt: Date.now(), rows };
    decisionContentCache = { spreadsheetId, builtAt: Date.now(), latest: latestContent };
}

/**
 * 直近に把握している保存内容のスナップショットを返す。
 * キャッシュ無効/期限切れ/別シートの場合は null（＝把握していない）を返し、
 * 呼び出し側はスキップ判定をせず通常どおり保存する。
 */
function getCachedDecisionContent(spreadsheetId: string, key: string): DecisionContentSnapshot | null {
    if (!decisionContentCache) return null;
    if (decisionContentCache.spreadsheetId !== spreadsheetId) return null;
    if (Date.now() - decisionContentCache.builtAt > DECISION_ROW_CACHE_TTL_MS) return null;
    return decisionContentCache.latest.get(key) ?? null;
}

/**
 * 追記（append）に成功した判定の内容をスナップショットへ記録する。
 * キャッシュが未構築/別シートの場合はここで新規に作る（次回以降のスキップ判定に使うため）。
 */
function rememberDecisionContent(spreadsheetId: string, key: string, decision: Decision): void {
    if (!decisionContentCache || decisionContentCache.spreadsheetId !== spreadsheetId) {
        decisionContentCache = { spreadsheetId, builtAt: Date.now(), latest: new Map() };
    }
    decisionContentCache.latest.set(key, contentSnapshotOf(decision));
}

/**
 * 新規追加した判定の行番号をキャッシュへ登録する。
 * 行番号が特定できなかった場合（appendRows のレスポンス解析失敗）は、誤ったキャッシュで
 * 他人の判定を上書きするリスクを避けるため、登録せずキャッシュ自体を無効化する。
 */
function registerDecisionRowInCache(spreadsheetId: string, key: string, rowIndex: number | null): void {
    if (rowIndex === null) {
        invalidateDecisionRowCache();
        return;
    }
    if (!decisionRowCache || decisionRowCache.spreadsheetId !== spreadsheetId) return;
    decisionRowCache.rows.set(key, rowIndex);
}

/**
 * Decisions 行番号キャッシュ（保存内容スナップショット含む）を無効化する。
 * 行削除など行番号がずれる操作の後や、新規キーの把握ができない一括追加の後に呼ぶこと。
 */
export function invalidateDecisionRowCache(): void {
    decisionRowCache = null;
    decisionContentCache = null;
}

/**
 * saveDecision の直列化用 Promise チェーン。
 * 同一文献への保存が並行すると、両方が「既存行なし」と誤判定して重複行が2行できてしまう
 * （連打時に実際に発生していたバグ）。モジュールスコープの Promise チェーンで直列化して防ぐ。
 * 前段が失敗しても後続の保存を止めないよう、チェーン自体は常に resolve させておく。
 */
let saveDecisionChain: Promise<void> = Promise.resolve();

/**
 * 判定を保存する。
 * - human判定 / ML手動確認判定: 常に追記（append-only）。判定変更の履歴を行として残し、
 *   後日 Cohen's kappa を合議前後で算出できるようにするため、既存行の検索・更新は行わない。
 * - それ以外（ML自動判定・LLM判定）: 従来どおりの upsert（行番号キャッシュがヒットする限り
 *   読み取りリクエストを発行しない。キャッシュが無効な場合のみ全件読み取ってから判定する）。
 */
export async function saveDecision(spreadsheetId: string, decision: Decision): Promise<void> {
    const run = saveDecisionChain.then(() => saveDecisionInner(spreadsheetId, decision));
    saveDecisionChain = run.catch(() => { /* 前段の失敗で後続を止めない */ });
    return run;
}

async function saveDecisionInner(spreadsheetId: string, decision: Decision): Promise<void> {
    const targetPhase = decision.screening_phase ?? 'tiab';
    const key = decisionRowKey(decision.ref_id, decision.reviewer_id, decision.screening_phase);

    const row = [
        decision.decision_id,
        decision.ref_id,
        decision.reviewer_id,
        decision.decision,
        decision.reason || '',
        '', // labels: 機能廃止のため常に空文字を保存
        decision.note || '',
        decision.decided_at,
        decision.client_version || '',
        decision.source_url || '',
        decision.screening_phase || '',
        decision.context_json || '',
    ];

    if (isHumanDecision(decision.client_version) || isConfirmedMlDecision(decision.client_version)) {
        // 追記専用（append-only）: 既存行の検索・読み取りは一切行わず、常に新しい行として積む。
        // ただし直前に把握している内容と完全一致する場合は、誤タップ・連打・再描画による
        // 無意味な重複行を防ぐため保存自体をスキップする。
        const cachedContent = getCachedDecisionContent(spreadsheetId, key);
        if (cachedContent && isSameDecisionContent(cachedContent, contentSnapshotOf(decision))) {
            return;
        }
        await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    // それ以外（ML自動判定・LLM判定）は従来どおりの upsert ロジックを維持する
    // （LLMのpending→confirm行更新や deleteFulltextAiRound を壊さないため）
    const lookup = getCachedDecisionRow(spreadsheetId, key);

    if (lookup.state === 'hit') {
        // 既存行を更新（読み取り0回）
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${lookup.rowIndex}:${DECISIONS_LAST_COLUMN}${lookup.rowIndex}`, [row]);
        // decisionContentCache は「このキーへ最後に自分が書き込んだ内容」を指し続ける不変条件を保つ
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    if (lookup.state === 'absent') {
        // キャッシュ済みで未知のキー = 新規行（読み取り0回）
        const { firstRowIndex } = await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        registerDecisionRowInCache(spreadsheetId, key, firstRowIndex);
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    // cold: キャッシュ無効時のみ従来どおり全件読み取る（getDecisions が内部でキャッシュを温める）
    const decisionsData = await getDecisions(spreadsheetId);
    const existing = decisionsData.find(
        ({ decision: d }) =>
            d.ref_id === decision.ref_id &&
            d.reviewer_id === decision.reviewer_id &&
            (d.screening_phase ?? 'tiab') === targetPhase
    );

    if (existing) {
        // 既存行を更新
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${existing.rowIndex}:${DECISIONS_LAST_COLUMN}${existing.rowIndex}`, [row]);
    } else {
        // 新規追加
        const { firstRowIndex } = await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        registerDecisionRowInCache(spreadsheetId, key, firstRowIndex);
    }
    // decisionContentCache は「このキーへ最後に自分が書き込んだ内容」を指し続ける不変条件を保つ
    rememberDecisionContent(spreadsheetId, key, decision);
}

/**
 * Blind中（keyOpened=false）の全文閲覧ウィンドウ向けに Decisions を絞り込む。
 * サイドパネルの Blind ロード（getReferencesWithStatus）と同じポリシー:
 * 自分の判定（reviewer_id が userEmail と一致）＋ LLM判定（reviewer_id が 'llm:' で始まる）のみ返す。
 * 他レビュアーの人間票・ML票はBlind中は一切クライアントへ渡さない。
 */
export function filterDecisionsForBlind(
    decisions: { decision: Decision; rowIndex: number }[],
    keyOpened: boolean,
    userEmail: string
): { decision: Decision; rowIndex: number }[] {
    if (keyOpened) return decisions;
    // ポリシー本体は src/lib/blind-visibility.ts に一元化（fulltext.ts の即時反映でも同じ関数を使う）
    return decisions.filter(({ decision }) => isDecisionVisibleDuringBlind(decision, userEmail));
}

/**
 * 複数のDecisionを一括追加（LLMバッチ用）
 */
export async function appendDecisions(spreadsheetId: string, decisions: Decision[]): Promise<void> {
    if (decisions.length === 0) return;

    const rows = decisions.map(decision => [
        decision.decision_id,
        decision.ref_id,
        decision.reviewer_id,
        decision.decision,
        decision.reason || '',
        '', // labels: 機能廃止のため空
        decision.note || '',
        decision.decided_at,
        decision.client_version || '',
        decision.source_url || '',
        decision.screening_phase || '',
    ]);

    await appendRows(spreadsheetId, DECISIONS_SHEET, rows);
    // 行番号はずれないが、新規に追加したキーを行番号キャッシュが把握できておらず
    // absent 判定を誤る（＝存在するのに新規行として追記してしまう）ため無効化する
    invalidateDecisionRowCache();
}

/**
 * 特定のreviewer_idの既存Decisionsを取得
 */
export async function getDecisionsByReviewerId(
    spreadsheetId: string,
    reviewerId: string
): Promise<{ decision: Decision; rowIndex: number }[]> {
    const allDecisions = await getDecisions(spreadsheetId);
    return allDecisions.filter(({ decision }) => decision.reviewer_id === reviewerId);
}

/**
 * 複数のDecisionを一括更新（閾値確定用）
 */
export async function updateDecisionsBatch(
    spreadsheetId: string,
    updates: { rowIndex: number; decision: Decision }[]
): Promise<void> {
    // 効率的なバッチ更新のためにbatchUpdateを使用
    const token = await getAuthToken();

    const requests = updates.map(({ rowIndex, decision }) => ({
        range: `${DECISIONS_SHEET}!A${rowIndex}:${DECISIONS_LAST_COLUMN}${rowIndex}`,
        values: [[
            decision.decision_id,
            decision.ref_id,
            decision.reviewer_id,
            decision.decision,
            decision.reason || '',
            '', // labels
            decision.note || '',
            decision.decided_at,
            decision.client_version || '',
            decision.source_url || '',
            decision.screening_phase || '',
            // range が A:L（context_json列まで）に追従済みなのに values が11要素のままだと、
            // Sheets はレンジより短い values をそのまま受け付けてしまい L列（context_json）が
            // 上書きされず古い値が残る（AGENTS.md「context_json は human 判定の保存時のみ設定する」
            // という不変条件が崩れる）。saveDecisionInner の row 配列と同じ列順で揃えること。
            decision.context_json || '',
        ]],
    }));

    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                valueInputOption: 'USER_ENTERED',
                data: requests,
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to batch update decisions: ${error.error?.message || response.statusText}`);
    }
}

/**
 * LLM判定（pending状態）の文献を取得
 */
export async function getLlmPendingDecisions(
    spreadsheetId: string,
    executionId: string
): Promise<{ decision: Decision; rowIndex: number }[]> {
    const allDecisions = await getDecisions(spreadsheetId);
    return allDecisions.filter(({ decision }) =>
        decision.reviewer_id === executionId && decision.decision === 'pending'
    );
}
