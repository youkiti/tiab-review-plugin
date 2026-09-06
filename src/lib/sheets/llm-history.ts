// llm-history.ts - LLM_Executions / LLM_Runs タブの読み書き・ensure memo・旧形式移行・Run/Batch 解決
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema を参照。
// 判定の読み取り（getJudgedRefIdsForBatches）だけ ./decisions を参照する。

import type { LlmExecution, LlmRun } from '../types';
import { createAsyncCoalescer } from '../async-coalesce';
import { computeConfigHash, isHashable, legacyHash } from '../llm-config-hash';
import { pickRunByConfigHash, pickLegacyRunByConfigHash, collectJudgedRefIds } from '../llm-batch-target';
import { parseLlmTargetMode } from '../llm-target-selection';
import { getSheetValues, appendRows, updateRange, addSheet, batchUpdateRanges, isSheetMissingError } from './transport';
import { LLM_EXECUTIONS_SHEET, LLM_RUNS_SHEET, LLM_EXECUTIONS_HEADERS, LLM_RUNS_HEADERS, columnNumberToLetter } from './schema';
import { getDecisions } from './decisions';

// ========== LLM関連の関数 ==========


// 内容は保持せず、直近のプロジェクトのタブ・ヘッダー確認成功だけを短時間記録する。
const LLM_SHEET_ENSURE_TTL_MS = 60_000;
type LlmSheetEnsureMemo = { spreadsheetId: string; ensure: () => Promise<void>; markChecked: () => void };
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
        markChecked: () => { checkedAt = Date.now(); },
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
    await getLlmExecutionsEnsureMemo(spreadsheetId).ensure();
}

function getLlmExecutionsEnsureMemo(spreadsheetId: string): LlmSheetEnsureMemo {
    if (llmExecutionsEnsureMemo?.spreadsheetId !== spreadsheetId) {
        llmExecutionsEnsureMemo = createLlmSheetEnsureMemo(spreadsheetId, checkLlmExecutionsSheet);
    }
    return llmExecutionsEnsureMemo;
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

        await migrateLlmExecutionsHeaderColumns(spreadsheetId, existingHeaders);
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
    await getLlmRunsEnsureMemo(spreadsheetId).ensure();
}

function getLlmRunsEnsureMemo(spreadsheetId: string): LlmSheetEnsureMemo {
    if (llmRunsEnsureMemo?.spreadsheetId !== spreadsheetId) {
        llmRunsEnsureMemo = createLlmSheetEnsureMemo(spreadsheetId, checkLlmRunsSheet);
    }
    return llmRunsEnsureMemo;
}

async function checkLlmRunsSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, LLM_RUNS_SHEET, [LLM_RUNS_HEADERS]);
            return;
        }

        await migrateLlmRunsHeaderColumns(spreadsheetId, existingHeaders);
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

async function migrateLlmExecutionsHeaderColumns(spreadsheetId: string, existingHeaders: string[]): Promise<void> {
    if (existingHeaders.length === 0) return;

    // 不足している列を末尾に追加（後方互換マイグレーション）
    const missingHeaders = LLM_EXECUTIONS_HEADERS.filter(h => !existingHeaders.includes(h));
    if (missingHeaders.length === 0) return;

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

async function migrateLlmRunsHeaderColumns(spreadsheetId: string, existingHeaders: string[]): Promise<void> {
    if (existingHeaders.length === 0) return;

    const missingHeaders = LLM_RUNS_HEADERS.filter(h => !existingHeaders.includes(h));
    if (missingHeaders.length === 0) return;

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

/**
 * 本体を先に読み、履歴読み込み1回あたりのヘッダーGETを両タブ合計2本削減する（Issue #153）。
 * 通常読み取りがensureの移行分岐を通らなくなるため、本体の1行目で不足列を末尾へ追加する。
 * これを省くと古いヘッダーの移行が永久に走らず、ヘッダー駆動のパースで欠けた列がundefinedになる。
 * 独自列のヘッダーを上書きしないよう、標準列数で切らずシート名のみで全列を読む（PR #161）。
 */
async function readLlmExecutionsValues(spreadsheetId: string): Promise<string[][]> {
    const memo = getLlmExecutionsEnsureMemo(spreadsheetId);
    const values = await getSheetValues(spreadsheetId, LLM_EXECUTIONS_SHEET);
    if (values.length === 0) {
        await ensureLlmExecutionsSheet(spreadsheetId);
        return [];
    }
    await migrateLlmExecutionsHeaderColumns(spreadsheetId, values[0]);
    memo.markChecked();
    return values;
}

/**
 * 本体を先に読み、履歴読み込み1回あたりのヘッダーGETを両タブ合計2本削減する（Issue #153）。
 * 通常読み取りがensureの移行分岐を通らなくなるため、本体の1行目で不足列を末尾へ追加する。
 * これを省くと古いヘッダーの移行が永久に走らず、ヘッダー駆動のパースで欠けた列がundefinedになる。
 * 独自列のヘッダーを上書きしないよう、標準列数で切らずシート名のみで全列を読む（PR #161）。
 */
async function readLlmRunsValues(spreadsheetId: string): Promise<string[][]> {
    const memo = getLlmRunsEnsureMemo(spreadsheetId);
    const values = await getSheetValues(spreadsheetId, LLM_RUNS_SHEET);
    if (values.length === 0) {
        await ensureLlmRunsSheet(spreadsheetId);
        return [];
    }
    await migrateLlmRunsHeaderColumns(spreadsheetId, values[0]);
    memo.markChecked();
    return values;
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
        let values: string[][];
        try {
            values = await readLlmExecutionsValues(spreadsheetId);
        } catch (error) {
            if (!isSheetMissingError(error)) throw error;
            await ensureLlmExecutionsSheet(spreadsheetId);
            values = await readLlmExecutionsValues(spreadsheetId);
        }

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
    let values: string[][];
    try {
        values = await readLlmRunsValues(spreadsheetId);
    } catch (error) {
        if (!isSheetMissingError(error)) throw error;
        await ensureLlmRunsSheet(spreadsheetId);
        values = await readLlmRunsValues(spreadsheetId);
    }
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
 * 各タブの本体取得の1回（ヘッダー確認は本体の1行目で兼ねる。タブ欠落時だけensureして読み直す）。内容はモジュールに保持しない。
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

/** is_active かつ confirmed の Run のうち created_at が最新のもの */
export function selectActiveLlmRun(runs: LlmRun[]): LlmRun | null {
    const candidates = runs
        .filter(r => r.is_active && r.status === 'confirmed')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return candidates[0] ?? null;
}

/** 指定 Run 配下の batch_screening の execution_id 集合 */
function selectBatchIdsForRun(runId: string, executions: LlmExecution[]): Set<string> {
    return new Set(executions
        .filter(b => b.execution_type === 'batch_screening' && b.run_id === runId)
        .map(b => b.execution_id));
}

/** active Run 配下の batch_screening の execution_id 集合。active Run が無ければ空 */
export function selectActiveBatchIds(runs: LlmRun[], executions: LlmExecution[]): Set<string> {
    const activeRun = selectActiveLlmRun(runs);
    return activeRun ? selectBatchIdsForRun(activeRun.run_id, executions) : new Set();
}

/**
 * 現在の active Run（is_active=true かつ confirmed）を1件返す。
 * 複数候補があれば created_at が新しい方を採用。
 */
export async function getActiveLlmRun(spreadsheetId: string, loadedRuns?: LlmRun[]): Promise<LlmRun | null> {
    const runs = loadedRuns ?? await getLlmRuns(spreadsheetId);
    return selectActiveLlmRun(runs);
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
    return selectBatchIdsForRun(runId, all);
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
    const loadedRuns = runs ?? await getLlmRuns(spreadsheetId);
    if (!selectActiveLlmRun(loadedRuns)) return new Set();
    const loadedBatches = batches ?? await getLlmExecutions(spreadsheetId);
    return selectActiveBatchIds(loadedRuns, loadedBatches);
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
