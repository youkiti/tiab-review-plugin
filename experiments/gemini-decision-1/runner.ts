// Decisions API の確率を並列取得し、文献ごとに成功と最終失敗を追記して再開可能にする。
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

import { createHash } from 'crypto';
import {
    appendLedger, BenchConfig, BenchError, configHash, DatasetRecord, frozenSample,
    FailureRow, LedgerRow, loadConfig, loadDataset, outputPaths, readLedger, screeningPrompt,
} from './ledger';

interface ScreeningResult {
    output: { include_probability: number };
    usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    responseMetadata: { modelVersion?: string };
}

export type Screen = (record: DatasetRecord, attempt: number) => Promise<ScreeningResult>;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function fakeHash(id: string): number {
    return createHash('sha256').update(id).digest().readUInt32BE(0);
}

export const fakeScreen: Screen = async (record, attempt) => {
    const hash = fakeHash(record.id);
    if (hash % 97 === 0 || (hash % 10 === 0 && attempt === 1)) {
        throw new Error('偽応答の再試行可能エラー');
    }
    return {
        output: { include_probability: hash / 0xffffffff },
        usageMetadata: { promptTokenCount: 100 + hash % 50, candidatesTokenCount: 0 },
        responseMetadata: { modelVersion: 'fake-gemini-decision-1' },
    };
};

// 応答本文には入力や秘密情報が含まれ得るため、分類した理由だけを表示する。
function fatalReason(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/API error 401\b/.test(message)) return '認証エラー（401）';
    if (/API error 403\b/.test(message)) return 'アクセス権限エラー（403）';
    if (/API error 404\b/.test(message)) return 'モデル指定エラー（404）';
    return '再試行不可のエラー';
}

// 例外本文を保存せず、許可した分類と HTTP の情報だけを失敗レジャへ渡す。
function failureRow(error: unknown, key: string, dataset: string, attempts: number, hash: string): FailureRow {
    const details = error as { httpStatus?: unknown; errorStatus?: unknown; kind?: unknown } | null;
    const match = error instanceof Error ? /^API error (\d{3})$/.exec(error.message) : null;
    const status = typeof details?.httpStatus === 'number' ? details.httpStatus : match ? Number(match[1]) : null;
    let kind: FailureRow['kind'] = 'network';
    if (status !== null) {
        kind = 'http';
    } else if (details?.kind === 'timeout' || details?.kind === 'invalid_response') {
        kind = details.kind;
    }
    const errorStatus = status === 400 && typeof details?.errorStatus === 'string'
        && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.errorStatus) ? details.errorStatus : null;
    return {
        key, dataset, http_status: status, error_status: errorStatus, kind, attempts,
        config_hash: hash, completed_at: new Date().toISOString(),
    };
}

export interface RunOptions {
    dataset: string;
    records: DatasetRecord[];
    existing: Map<string, LedgerRow>;
    config: BenchConfig;
    hash: string;
    concurrency: number;
    fake: boolean;
    screen: Screen;
    append: (row: LedgerRow) => void;
    appendFailure: (row: FailureRow) => void;
    log?: (message: string) => void;
}

export async function runRecords(options: RunOptions): Promise<number> {
    const { records, existing, config, hash, concurrency, fake, screen, append, dataset } = options;
    const log = options.log ?? console.log;
    const pending = records.filter(r => !existing.has(r.id));
    let completed = records.length - pending.length;
    let failed = 0, http400 = 0, cursor = 0, finished = 0;
    let cooldownUntil = 0;
    let stopReason: string | null = null;
    let stopCode = 3;
    log(`既存 ${completed} 件をスキップ、未処理 ${pending.length} 件`);
    const progress = () => log(`完了 ${completed} / 対象 ${records.length}（失敗 ${failed}）`);

    async function waitForCooldown(): Promise<void> {
        while (!stopReason && Date.now() < cooldownUntil) {
            await sleep(Math.min(100, cooldownUntil - Date.now()));
        }
    }

    async function processRecord(record: DatasetRecord): Promise<void> {
        for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt++) {
            // 待機の継続中に別ワーカーが期限を延長しても、送信直前に再確認する。
            while (!stopReason && Date.now() < cooldownUntil) await waitForCooldown();
            if (stopReason) return;
            const start = Date.now();
            let result: ScreeningResult;
            try {
                result = await screen(record, attempt);
                const probability = result.output.include_probability;
                if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
                    throw Object.assign(new Error('応答確率が不正です。'), { kind: 'invalid_response' });
                }
            } catch (error) {
                if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false) {
                    stopReason ??= fatalReason(error);
                    return;
                }
                const delay = fake ? 1 : Math.min(config.retry.maxDelayMs,
                    config.retry.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random()));
                if (error instanceof Error && /API error (429|529)\b/.test(error.message)) {
                    // 最終試行で受けた制限も、他ワーカーの次リクエストへ反映する。
                    cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
                }
                if (attempt === config.retry.maxAttempts) {
                    const failure = failureRow(error, record.id, dataset, attempt, hash);
                    try {
                        options.appendFailure(failure);
                    } catch {
                        stopReason = '失敗レジャの保存に失敗しました';
                        stopCode = 1;
                        return;
                    }
                    failed++;
                    if (failure.http_status === 400) {
                        http400++;
                    }
                    return;
                }
                const retryAt = Date.now() + delay;
                while (!stopReason && Date.now() < retryAt) await sleep(Math.min(100, retryAt - Date.now()));
                continue;
            }
            const row: LedgerRow = {
                key: record.id, dataset, label_included: record.label_included,
                include_probability: result.output.include_probability,
                model_requested: config.model, model_version: result.responseMetadata.modelVersion ?? null,
                input_tokens: result.usageMetadata.promptTokenCount,
                output_tokens: result.usageMetadata.candidatesTokenCount,
                latency_ms: Date.now() - start, attempts: attempt,
                config_hash: hash, ledger_version: config.ledgerVersion, completed_at: new Date().toISOString(),
            };
            // 保存失敗を API の失敗として再送しない。起動中の応答は回収して停止する。
            try { append(row); }
            catch { stopReason = 'レジャの保存に失敗しました'; stopCode = 1; return; }
            completed++;
            return;
        }
    }

    async function worker(): Promise<void> {
        while (!stopReason) {
            await waitForCooldown();
            if (stopReason || cursor >= pending.length) return;
            const record = pending[cursor++];
            await processRecord(record);
            finished++;
            if (finished % 50 === 0) progress();
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
    progress();
    log(`失敗 ${failed} 件（HTTP 400: ${http400} 件）`);
    if (stopReason) { log(`実行停止: ${stopReason}`); return stopCode; }
    return failed ? 2 : 0;
}

async function main(): Promise<number> {
    const config = loadConfig();
    let fake = false, smoke = false, concurrency = config.concurrency;
    let dataset = 'depression';
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') fake = true;
        else if (args[i] === '--smoke') smoke = true;
        else if (args[i] === '--concurrency') concurrency = Number(args[++i]);
        else if (args[i] === '--dataset') dataset = args[++i];
        else throw new BenchError('不明な引数です。--fake / --smoke / --concurrency N / --dataset キー を指定してください。');
    }
    if (!Object.prototype.hasOwnProperty.call(config.datasets, dataset)) {
        throw new BenchError('指定されたデータセットキーが config にありません。');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1
        || !Number.isInteger(config.retry.maxAttempts) || config.retry.maxAttempts < 1
        || ![config.retry.baseDelayMs, config.retry.maxDelayMs].every(n => Number.isFinite(n) && n > 0)) {
        throw new BenchError('並列数またはリトライ設定が不正です。');
    }
    if (!fake && !process.env.GEMINI_API_KEY?.trim()) {
        throw new BenchError('GEMINI_API_KEY がありません。環境変数またはリポジトリ直下の .env に設定してください。');
    }
    const all = loadDataset(config, dataset);
    const paths = outputPaths(config, fake, dataset);
    const hash = configHash(config, dataset);
    const { rows, brokenLines } = readLedger(paths.ledger, hash, dataset);
    if (brokenLines) console.warn(`警告: 読めないレジャ行 ${brokenLines} 件を読み飛ばしました。`);
    const records = smoke ? frozenSample(paths.sample, all, config.smokeSampleSize, config.sampleSeed) : all;
    let screen: Screen = fakeScreen;
    if (!fake) {
        // fake では実 API のモジュールを読み込まない。
        const { createScreen } = await import('./decisions-api');
        screen = createScreen(config.model, screeningPrompt(config, dataset), process.env.GEMINI_API_KEY!.trim());
    }
    return runRecords({ records, existing: rows, config, hash, concurrency, fake, screen, dataset,
        append: row => appendLedger(paths.ledger, row),
        appendFailure: row => appendLedger(paths.failures, row) });
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error instanceof BenchError ? error.message : '実行準備に失敗しました。設定・入力ファイル・保存先を確認してください。');
        process.exitCode = 1;
    });
}
