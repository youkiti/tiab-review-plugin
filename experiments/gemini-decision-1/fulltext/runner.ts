// 全文の確率と参考理由を並列取得し、成功・最終失敗を追記して未成功分だけ再開する。
import path from 'path';
import dotenv from 'dotenv';
import { createHash } from 'crypto';
import {
    Config, ExperimentError, FailureRow, Input, LedgerRow, RecordRow, Result, Tier, appendLedger, configHash,
    directory, fail, loadConfig, outputPaths, pdfState, readFailures, readRecords, readSuccess, root,
} from './common';
import type { Screen } from './decisions-fulltext';

export interface Options {
    tier: Tier;
    input: Input;
    reviews: string[];
    limit?: number;
    concurrency: number;
    fake: boolean;
    recordsFile: string;
    outputDir?: string;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function parseArgs(args: string[], config: Config): Options {
    let tier: Tier | undefined, input: Input | undefined, recordsFile: string | undefined;
    let fake = false, concurrency = config.concurrency, limit: number | undefined;
    const reviews: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--fake') {
            fake = true;
        } else if (arg === '--tier') {
            tier = args[++i] as Tier;
        } else if (arg === '--input') {
            input = args[++i] as Input;
        } else if (arg === '--review') {
            const review = args[++i];
            if (!review || !/^PMC[0-9]+$/.test(review)) {
                throw new ExperimentError('レビューは PMCID で指定してください。');
            }
            reviews.push(review);
        } else if (arg === '--limit') {
            limit = Number(args[++i]);
        } else if (arg === '--concurrency') {
            concurrency = Number(args[++i]);
        } else if (arg === '--records') {
            recordsFile = args[++i];
            if (!recordsFile) {
                throw new ExperimentError('入力パスがありません。');
            }
        } else {
            throw new ExperimentError('不明な引数です。');
        }
    }
    if (!tier || !['cc-by', 'cc-by-nc'].includes(tier) || !input || !['pdf', 'text'].includes(input)
        || !Number.isInteger(concurrency) || concurrency < 1 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) {
        throw new ExperimentError('層・入力・並列数・上限の指定が不正です。');
    }
    return { tier, input, reviews, limit, concurrency, fake,
        recordsFile: path.resolve(recordsFile ?? path.join(directory, 'data', tier, 'records.jsonl')) };
}
export function fakeScreen(config: Config): Screen {
    return async (record, attempt) => {
        const hash = createHash('sha256').update(record.key).digest().readUInt32BE(0);
        if (hash % 10 === 0 && attempt === 1) {
            throw Object.assign(new Error('偽応答の再試行可能エラー'), { kind: 'network' });
        }
        const keys = Object.keys(config.reasonCriteria), choice = keys[hash % keys.length];
        return { include_probability: hash / 0xffffffff, reason_choice: choice,
            reason_probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])),
            input_tokens: 100 + hash % 50, tokens_by_modality: [{ modality: 'TEXT', tokens: 100 + hash % 50 }],
            model_version: 'fake-gemini-decision-1' };
    };
}
function failure(error: unknown, key: string, attempts: number, hash: string): FailureRow {
    const details = error as { httpStatus?: unknown; errorStatus?: unknown; kind?: unknown } | null;
    const http = typeof details?.httpStatus === 'number' ? details.httpStatus : null;
    const errorStatus = http === 400 && typeof details?.errorStatus === 'string'
        && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.errorStatus) ? details.errorStatus : null;
    const kind = http !== null ? 'http' : details?.kind === 'timeout' || details?.kind === 'invalid_response' ? details.kind : 'network';
    return { key, http_status: http, error_status: errorStatus, kind, attempts, config_hash: hash, completed_at: new Date().toISOString() };
}
export async function run(options: Options, config = loadConfig(), injectedScreen?: Screen, log = console.log) {
    const { records, digest } = readRecords(options.recordsFile);
    const hash = configHash(config, options.input, digest);
    const paths = outputPaths(options.tier, options.input, config, options.fake, options.outputDir);
    const existing = readSuccess(paths.ledger, hash, options.input, config).rows;
    readFailures(paths.failures, hash);
    const ids = new Set(records.map(r => r.key));
    if ([...existing.keys()].some(key => !ids.has(key))) {
        throw new ExperimentError('成功台帳に入力外のキーがあります。');
    }
    for (const review of options.reviews) {
        if (!records.some(r => r.pmcid === review)) {
            throw new ExperimentError('指定したレビューが入力にありません。');
        }
    }
    let targets = records.filter(r => !options.reviews.length || options.reviews.includes(r.pmcid));
    if (options.limit !== undefined) {
        targets = targets.slice(0, options.limit);
    }
    const skipped = { no_pdf: 0, too_large: 0, pdf_missing: 0 };
    const missing: string[] = [];
    const pending: { record: RecordRow; file: string }[] = [];
    for (const record of targets) {
        if (existing.has(record.key)) {
            continue;
        }
        const state = options.input === 'pdf' ? pdfState(record, options.recordsFile, config, options.fake) : { kind: 'ready', file: '' };
        if (state.kind !== 'ready') {
            skipped[state.kind as keyof typeof skipped]++;
            if (state.kind === 'pdf_missing') {
                missing.push(record.key);
            }
            continue;
        }
        pending.push({ record, file: state.file });
    }
    log(`既存 ${targets.filter(r => existing.has(r.key)).length} 件をスキップ、未処理 ${pending.length} 件`);
    let screen = injectedScreen ?? fakeScreen(config);
    if (!options.fake && !injectedScreen && pending.length) {
        dotenv.config({ path: path.join(root, '.env'), quiet: true });
        const apiKey = process.env.GEMINI_API_KEY?.trim();
        if (!apiKey) {
            throw new ExperimentError('GEMINI_API_KEY がありません。');
        }
        const { createScreen } = await import('./decisions-fulltext');
        screen = createScreen(config, options.input, apiKey);
    }
    let cursor = 0, success = 0, failed = 0, http400 = 0, tokens = 0, stopCode = 0, cooldown = 0;
    async function wait(until: number): Promise<void> {
        while (!stopCode && performance.now() < until) {
            await sleep(Math.min(100, until - performance.now()));
        }
    }
    async function processRecord(record: RecordRow, file: string): Promise<void> {
        for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
            while (!stopCode && performance.now() < cooldown) {
                await wait(cooldown);
            }
            if (stopCode) {
                return;
            }
            const started = performance.now();
            let result: Result;
            try {
                result = await screen(record, attempt, file);
            } catch (error) {
                const row = failure(error, record.key, attempt, hash);
                const fatal = row.http_status !== null && [401, 403, 404].includes(row.http_status);
                const delay = options.fake ? 1 : Math.min(60000, 2000 * 2 ** (attempt - 1) * (1 + Math.random()));
                if (row.http_status === 429 || row.http_status === 529) {
                    cooldown = Math.max(cooldown, performance.now() + delay);
                }
                if (fatal || attempt === config.maxAttempts) {
                    try {
                        appendLedger(paths.failures, row);
                    } catch {
                        stopCode = 1;
                        return;
                    }
                    failed++;
                    if (row.http_status === 400) {
                        http400++;
                    }
                    if (fatal) {
                        stopCode = stopCode === 1 ? 1 : 3;
                        log(`新規要求を停止: HTTP ${row.http_status}`);
                    }
                    return;
                }
                await wait(performance.now() + delay);
                continue;
            }
            const row: LedgerRow = { key: record.key, pmcid: record.pmcid, pmid: record.pmid, input: options.input,
                ...result, attempts: attempt, latency_ms: performance.now() - started, config_hash: hash,
                completed_at: new Date().toISOString() };
            try {
                appendLedger(paths.ledger, row);
            } catch {
                stopCode = 1;
                return;
            }
            tokens += result.input_tokens;
            success++;
            if ((success + failed) % 50 === 0) {
                log(`処理済み ${success + failed} / ${pending.length} 件`);
            }
            return;
        }
    }
    async function worker(): Promise<void> {
        while (!stopCode && cursor < pending.length) {
            while (!stopCode && performance.now() < cooldown) {
                await wait(cooldown);
            }
            if (stopCode || cursor >= pending.length) {
                return;
            }
            const { record, file } = pending[cursor++];
            await processRecord(record, file);
        }
    }
    await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
    log(`成功 ${success} 件、失敗 ${failed} 件（HTTP 400: ${http400} 件）、送らなかった記録`
        + `（no_pdf ${skipped.no_pdf} / too_large ${skipped.too_large} / pdf_missing ${skipped.pdf_missing}）、`
        + `入力トークン合計 ${tokens}、推定費用 $${(tokens * config.pricing.inputPerMillion / 1e6).toFixed(6)}`);
    if (missing.length) {
        log(`取得し直す PDF の一覧: ${missing.join(', ')}（${missing.length} 件）`);
    }
    const code = stopCode || (missing.length ? 1 : failed ? 2 : 0);
    return { code, success, failed, skipped, tokens };
}
export async function main(args = process.argv.slice(2)): Promise<number> {
    const config = loadConfig();
    return (await run(parseArgs(args, config), config)).code;
}
if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(fail);
}
