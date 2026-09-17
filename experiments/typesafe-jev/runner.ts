import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

import { createHash } from 'crypto';
import {
    appendLedger, BenchConfig, BenchError, configHash, DatasetRecord, frozenSample,
    LedgerRow, loadConfig, loadDataset, outputPaths, readLedger, screeningPrompt,
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
        usageMetadata: { promptTokenCount: 100 + hash % 50, candidatesTokenCount: 5 },
        responseMetadata: { modelVersion: 'fake-jev-1.13.0' },
    };
};

// 応答本文には入力や秘密情報が含まれ得るため、分類した理由だけを表示する。
function fatalReason(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/API error 401\b/.test(message)) return '認証エラー（401）';
    if (/API error 403\b/.test(message)) return 'アクセス権限エラー（403）';
    if (/API error 400\b/.test(message)) return 'モデル指定エラー（400）';
    return '再試行不可のエラー';
}

export interface RunOptions {
    records: DatasetRecord[];
    existing: Map<string, LedgerRow>;
    config: BenchConfig;
    hash: string;
    concurrency: number;
    fake: boolean;
    screen: Screen;
    append: (row: LedgerRow) => void;
    log?: (message: string) => void;
}

export async function runRecords(options: RunOptions): Promise<number> {
    const { records, existing, config, hash, concurrency, fake, screen, append } = options;
    const log = options.log ?? console.log;
    const pending = records.filter(r => !existing.has(r.id));
    let completed = records.length - pending.length;
    let failed = 0, cursor = 0, finished = 0;
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
                    throw new Error('応答確率が不正です。');
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
                if (attempt === config.retry.maxAttempts) { failed++; return; }
                const retryAt = Date.now() + delay;
                while (!stopReason && Date.now() < retryAt) await sleep(Math.min(100, retryAt - Date.now()));
                continue;
            }
            const row: LedgerRow = {
                key: record.id, dataset: 'depression', label_included: record.label_included,
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
    if (stopReason) { log(`実行停止: ${stopReason}`); return stopCode; }
    return failed ? 2 : 0;
}

async function main(): Promise<number> {
    const config = loadConfig();
    let fake = false, smoke = false, concurrency = config.concurrency;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') fake = true;
        else if (args[i] === '--smoke') smoke = true;
        else if (args[i] === '--concurrency') concurrency = Number(args[++i]);
        else throw new BenchError('不明な引数です。--fake / --smoke / --concurrency N を指定してください。');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1
        || !Number.isInteger(config.retry.maxAttempts) || config.retry.maxAttempts < 1
        || ![config.retry.baseDelayMs, config.retry.maxDelayMs].every(n => Number.isFinite(n) && n > 0)) {
        throw new BenchError('並列数またはリトライ設定が不正です。');
    }
    if (!fake && !process.env.TYPE_SAFE_API_KEY?.trim()) {
        throw new BenchError('TYPE_SAFE_API_KEY がありません。環境変数またはリポジトリ直下の .env に設定してください。');
    }
    const all = loadDataset(config);
    const paths = outputPaths(config, fake);
    const hash = configHash(config);
    const { rows, brokenLines } = readLedger(paths.ledger, hash);
    if (brokenLines) console.warn(`警告: 読めないレジャ行 ${brokenLines} 件を読み飛ばしました。`);
    const records = smoke ? frozenSample(paths.sample, all, config.smokeSampleSize, config.sampleSeed) : all;
    let screen: Screen = fakeScreen;
    if (!fake) {
        // fake ではプロバイダを読み込まず、実 API への経路を作らない。
        const { screenViaTypeSafe } = await import('../../src/lib/providers/typesafe');
        const prompt = screeningPrompt(config);
        screen = record => screenViaTypeSafe({
            title: record.title, abstract: record.abstract || '', screeningPrompt: prompt,
            model: config.model, outputLanguage: config.outputLanguage,
        });
    }
    return runRecords({ records, existing: rows, config, hash, concurrency, fake, screen,
        append: row => appendLedger(paths.ledger, row) });
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error instanceof BenchError ? error.message : '実行準備に失敗しました。設定・入力ファイル・保存先を確認してください。');
        process.exitCode = 1;
    });
}
