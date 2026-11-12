// PDF 本文を拡張と同じ経路で判定し、再開可能な台帳へ記録する。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_EXCLUDE_REASON_ITEMS } from '../../src/lib/exclude-reasons';
import { judgeFulltextViaTypeSafe, TypeSafeInputTooLongError } from '../../src/lib/typesafe-fulltext';
import { extractPdf } from './extract';
import {
    appendLedger, configHash, ExperimentError, fail, FailureRow, outputPaths, readConfig,
    readFailures, readRecords, readSuccess, recordsDirectory, RecordRow, sha256, Tier, tiers,
} from './common';

export function parseArgs(args: string[]) {
    let tier: Tier | undefined, records: string | undefined, pdfDir: string | undefined, limit: number | undefined;
    let fake = false;
    const reviews: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--fake') {
            fake = true;
            continue;
        }
        const value = args[++i];
        if (!value || value.startsWith('--')) {
            throw new ExperimentError('引数の値がありません。');
        }
        switch (arg) {
            case '--tier':
                if (!tiers.includes(value as Tier)) {
                    throw new ExperimentError('tier が不正です。');
                }
                tier = value as Tier;
                break;
            case '--records':
                records = path.resolve(value);
                break;
            case '--pdf-dir':
                pdfDir = path.resolve(value);
                break;
            case '--review':
                if (!/^PMC\d+$/.test(value)) {
                    throw new ExperimentError('review が不正です。');
                }
                reviews.push(value);
                break;
            case '--limit':
                limit = Number(value);
                if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) {
                    throw new ExperimentError('limit が不正です。');
                }
                break;
            default:
                throw new ExperimentError('未知の引数です。');
        }
    }
    if (!tier) {
        throw new ExperimentError('--tier が必要です。');
    }
    return { tier, records: records ?? path.join(recordsDirectory, tier, 'records.jsonl'),
        pdfDir: pdfDir ?? path.join(recordsDirectory, tier, 'pdf'), limit, reviews, fake };
}

function fakeJudge(record: RecordRow) {
    const digest = sha256(record.key);
    const p = parseInt(digest.slice(0, 8), 16) / 0xffffffff;
    const choice = DEFAULT_EXCLUDE_REASON_ITEMS[parseInt(digest.slice(8, 16), 16) % DEFAULT_EXCLUDE_REASON_ITEMS.length].key;
    return { output: { include_probability: p, decision: p >= 0.3 ? 'include' as const : 'exclude' as const,
        exclude_reason_category: choice },
    reasonProbabilities: Object.fromEntries(DEFAULT_EXCLUDE_REASON_ITEMS.map(item => [item.key, item.key === choice ? 1 : 0])),
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, costUsd: 0 },
    responseMetadata: { modelVersion: 'fake' } };
}

export async function run(args = process.argv.slice(2)): Promise<number> {
    const options = parseArgs(args);
    const config = readConfig();
    const input = readRecords(options.records);
    const hash = configHash(config, input.digest);
    const files = outputPaths(options.tier, config, options.fake);
    const successes = readSuccess(files.ledger, hash).rows;
    const failures = readFailures(files.failures, hash).rows;
    const keys = new Set(input.records.map(record => record.key));
    if ([...successes.keys(), ...failures.keys()].some(key => !keys.has(key))) {
        throw new ExperimentError('台帳に入力外のキーがあります。');
    }
    const selected = input.records.filter(row => !options.reviews.length || options.reviews.includes(row.pmcid));
    const records = options.limit === undefined ? selected : selected.slice(0, options.limit);
    let next = 0, done = 0, ok = 0, skip = 0, failed = 0, missing = 0;
    let stopped = false;
    const progress = () => console.log(`${done}/${records.length} ok=${ok} skip=${skip} fail=${failed} pdf_missing=${missing}`);
    function saveFailure(record: RecordRow, status: FailureRow['status'], errorKind: string | null,
        httpStatus: number | null, totalTextLength = 0, charsSent = 0) {
        appendLedger(files.failures, { key: record.key, status, error_kind: errorKind, http_status: httpStatus,
            total_text_length: totalTextLength, chars_sent: charsSent, config_hash: hash });
        if (status === 'failed' || status === 'pdf_error') {
            failed++;
        } else {
            skip++;
        }
    }
    async function processRecord(record: RecordRow) {
        if (successes.has(record.key) || ['no_pdf', 'image_only', 'too_long'].includes(failures.get(record.key)?.status ?? '')) {
            skip++;
            return;
        }
        if (record.pdf_url === null) {
            saveFailure(record, 'no_pdf', null, null);
            return;
        }
        const file = path.join(options.pdfDir, `${record.report_pmcid}.pdf`);
        if (!fs.existsSync(file)
            || (record.pdf_md5 && createHash('md5').update(fs.readFileSync(file)).digest('hex') !== record.pdf_md5.toLowerCase())) {
            missing++;
            return;
        }
        let extracted: Awaited<ReturnType<typeof extractPdf>>;
        try {
            extracted = await extractPdf(file);
        } catch {
            saveFailure(record, 'pdf_error', 'pdf', null);
            return;
        }
        const total = extracted.totalTextLength, chars = extracted.text.length;
        if (extracted.imageOnly) {
            saveFailure(record, 'image_only', null, null, total, 0);
            return;
        }
        // 抽出中に別の要求が再試行不可になった場合も、新しい送信はしない。
        if (stopped) {
            return;
        }
        const started = Date.now();
        let result: Awaited<ReturnType<typeof judgeFulltextViaTypeSafe>> | ReturnType<typeof fakeJudge>;
        try {
            result = options.fake ? fakeJudge(record) : await judgeFulltextViaTypeSafe({
                model: config.model, title: record.title, fullText: extracted.text,
                screeningPrompt: record.screening_prompt, reasonItems: DEFAULT_EXCLUDE_REASON_ITEMS,
                outputLanguage: config.outputLanguage,
            }, { maxAttempts: config.maxAttempts, timeoutMs: config.requestTimeoutMs });
        } catch (error) {
            const e = error as { status?: number; retryable?: boolean; name?: string };
            if (error instanceof TypeSafeInputTooLongError) {
                saveFailure(record, 'too_long', 'input_too_long', 400, total, chars);
            } else {
                if (e?.retryable === false) {
                    stopped = true;
                }
                const kind = e?.retryable === false ? 'nonretryable' : e?.status ? 'http'
                    : e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timeout'
                    : error instanceof TypeError ? 'network' : 'invalid_response';
                saveFailure(record, 'failed', kind, e?.status ?? null, total, chars);
            }
            return;
        }
        appendLedger(files.ledger, {
            key: record.key, pmcid: record.pmcid, pmid: record.pmid, report_pmcid: record.report_pmcid,
            include_probability: result.output.include_probability!,
            decision: result.output.include_probability! >= config.threshold ? 'include' : 'exclude',
            choice: result.output.exclude_reason_category ?? null, reason_probabilities: result.reasonProbabilities ?? {},
            chars_sent: chars, raw_length: extracted.rawLength, truncated: extracted.truncated,
            references_removed: extracted.referencesRemoved, total_text_length: total,
            input_tokens: result.usageMetadata.promptTokenCount, output_tokens: result.usageMetadata.candidatesTokenCount,
            cost_usd: result.usageMetadata.costUsd ?? null, model_version: result.responseMetadata.modelVersion ?? null,
            latency_ms: Date.now() - started, config_hash: hash,
        });
        ok++;
    }
    async function worker() {
        while (!stopped && next < records.length) {
            const record = records[next++];
            await processRecord(record);
            done++;
            if (done % 100 === 0) {
                progress();
            }
        }
    }
    // 保存エラーでも開始済みの処理が終わるまで待ち、追加の作業は止める。
    let ioError = false;
    await Promise.all(Array.from({ length: Math.min(config.concurrency, records.length) }, async () => {
        try {
            await worker();
        } catch {
            ioError = true;
            stopped = true;
        }
    }));
    progress();
    if (ioError) {
        console.error('入出力処理に失敗しました。');
        return 1;
    }
    return stopped ? 3 : missing ? 1 : failed ? 2 : 0;
}
if (require.main === module) {
    run().then(code => { process.exitCode = code; }).catch(fail);
}
