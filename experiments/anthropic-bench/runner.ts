/**
 * Anthropic 同梱モデル（claude-haiku-5-5 / claude-sonnet-5-5）のベンチマーク用ランナー
 *
 * src/lib/providers/anthropic.ts の screenViaAnthropic を直接呼ぶ。Node では
 * getEffectiveAnthropicApiKey が process.env.ANTHROPIC_API_KEY を読むため、リポジトリ直下の .env に
 * ANTHROPIC_API_KEY があればそのまま動く（chrome.storage 非依存）。
 *
 * 生成の設定はアプリと同じ（effort のみ。temperature などは送らない）。max_tokens は
 * アプリが渡す値と同じ anthropicMaxOutputTokens(undefined) になる。起動時に、条件の effort が
 * アプリの MODEL_GENERATION_SETTINGS と食い違っていたら止める（条件の調整をしない約束のため）。
 *
 * 指標は experiments/gpt-5.6/runner.ts と揃える（threshold 既定 0.5、Fβ=7）。
 * 文献ごとの生トークン（prompt・cached・completion・reasoning）を items_*.json に、集計と推定費用を
 * experiment_*.log.json に、checkpointEvery 件ごとに途中保存する。
 *
 * 使い方:
 *   npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/runner.ts --condition A-H1 --sample 5
 *   ... --dataset depression --condition A-S1                 （全件）
 *   ... --condition A-H1 --resume A-H1_2026-11-12T01-02-03    （失敗した件だけ取り直して続きを実行。並列を下げたいときは config.json の rateLimits を直す）
 *   ... --condition A-H1 --sample 30 --dry-run                （API を呼ばず、送る内容と保存の形を確かめる）
 *
 * --dry-run は global fetch を模型に差し替え、結果を OS の一時ディレクトリに書く（results/ には書かない）。
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { screenViaAnthropic } from '../../src/lib/providers/anthropic';
import { anthropicMaxOutputTokens, getModelGenerationSettings } from '../../src/lib/model-generation-settings';
import type { Reference, RateLimitConfig } from '../../src/lib/types';
import { calculateMetrics } from './common';
import type { ExperimentLog, ItemUsage, PerItemResult, TokenTotals } from './common';

interface Condition {
    id: string;
    provider: 'anthropic';
    model: string;
    reasoningEffort: 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
    rateLimit: string;
    smokeRateLimit?: string;
    note?: string;
}

interface Pricing {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    outputPerMillion: number;
}

interface BenchConfig {
    description: string;
    version: string;
    datasets: Record<string, string>;
    datasetConfigs: Record<string, { criteria: string }>;
    defaultScreeningPrompt: string;
    checkpointEvery?: number;
    retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
    invalidFailureRate?: number;
    rateLimits: Record<string, RateLimitConfig>;
    conditions: Condition[];
    pricing: Record<string, Pricing>;
}

interface Args {
    dataset: string;
    condition: string;
    sample?: number;
    threshold: number;
    resume?: string;
    dryRun: boolean;
}

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const k = args[i].slice(2);
            const v = args[i + 1];
            if (v && !v.startsWith('--')) { out[k] = v; i++; }
        }
    }
    return {
        dataset: out.dataset || 'depression',
        condition: out.condition || 'A-H1',
        sample: out.sample ? parseInt(out.sample, 10) : undefined,
        threshold: out.threshold ? parseFloat(out.threshold) : 0.5,
        resume: out.resume,
        dryRun: args.includes('--dry-run'),
    };
}

function ensureDir(p: string): void {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function generateExperimentId(condId: string): string {
    return `${condId}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

class Semaphore {
    private active = 0;
    private waiters: Array<() => void> = [];
    constructor(private limit: number) {}
    async acquire(): Promise<void> {
        if (this.active < this.limit) { this.active++; return; }
        return new Promise(resolve => this.waiters.push(() => { this.active++; resolve(); }));
    }
    release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

function classifyError(msg: string): NonNullable<PerItemResult['errorKind']> {
    if (msg.includes('max_tokens')) return 'max_tokens';
    if (msg.includes('refusal')) return 'refusal';
    return 'other';
}

async function runOne(
    ref: Reference & { label_included: number },
    condition: Condition,
    screeningPrompt: string,
    retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
): Promise<PerItemResult> {
    const start = Date.now();
    let lastMsg = '';
    let attempts = 0;
    // screenViaAnthropic は1回しか通信しないため、一過性の失敗（429・5xx・通信断・JSON 崩れ）はここで取り直す。
    // retryable: false（401/403/404・打ち切り・拒否）は取り直さない。
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        attempts = attempt;
        try {
            const { output, usageMetadata } = await screenViaAnthropic({
                title: ref.title,
                abstract: ref.abstract || '',
                screeningPrompt,
                model: condition.model,
                reasoningEffort: condition.reasoningEffort,
                maxOutputTokens: condition.maxOutputTokens,
                outputLanguage: 'ja',
            });
            const usage: ItemUsage = {
                prompt: usageMetadata.promptTokenCount,
                cached: usageMetadata.cachedInputTokens ?? 0,
                completion: usageMetadata.candidatesTokenCount,
                reasoning: usageMetadata.thoughtsTokenCount,
                total: usageMetadata.totalTokenCount,
            };
            return {
                ref_id: ref.ref_id,
                label_included: ref.label_included,
                include_probability: output.include_probability,
                reasons: output.reasons || [],
                attempts,
                durationMs: Date.now() - start,
                usage,
            };
        } catch (err) {
            lastMsg = err instanceof Error ? err.message : String(err);
            const e = err as { retryable?: boolean; retryAfterMs?: number };
            if (e.retryable === false || attempt >= retry.maxAttempts) break;
            const backoff = Math.min(retry.baseDelayMs * Math.pow(2, attempt - 1), retry.maxDelayMs);
            await sleep(Math.max(backoff, e.retryAfterMs ?? 0));
        }
    }
    // 失敗は include_probability=null で残す。1.0（偽の陽性）にはしない。
    return {
        ref_id: ref.ref_id,
        label_included: ref.label_included,
        include_probability: null,
        reasons: [],
        error: lastMsg,
        errorKind: classifyError(lastMsg),
        attempts,
        durationMs: Date.now() - start,
    };
}

function computeCost(tokens: TokenTotals, pricing: Pricing | undefined): number | undefined {
    if (!pricing) return undefined;
    const uncachedInput = Math.max(0, tokens.prompt - tokens.cached);
    const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
    // output_tokens は thinking を含むため、出力の課金は completion だけで計算する。
    return (
        (uncachedInput / 1_000_000) * pricing.inputPerMillion +
        (tokens.cached / 1_000_000) * cachedRate +
        (tokens.completion / 1_000_000) * pricing.outputPerMillion
    );
}

/**
 * ANTHROPIC_API_KEY が無いとき、`ant auth login` で得た OAuth トークンを使う。
 * screenViaAnthropic（src/ は変えない）は x-api-key を送るので、api.anthropic.com 宛ての fetch だけ
 * x-api-key を外して Authorization: Bearer に差し替える。トークンは ant が期限前に更新するので、
 * 5分ごとに取り直す。値は表示もログもしない。ant の場所は ANT_BIN で変えられる。
 */
function installAntBearerAuth(): void {
    const antBin = process.env.ANT_BIN || 'ant';
    let cached = '';
    let fetchedAt = 0;
    const getToken = (): string => {
        if (!cached || Date.now() - fetchedAt > 5 * 60_000) {
            try {
                cached = execFileSync(antBin, ['auth', 'print-credentials', '--access-token'], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
                }).trim();
            } catch {
                throw new Error('ANTHROPIC_API_KEY が未設定で、`ant auth print-credentials` も失敗しました。`ant auth login` でサインインするか、.env に ANTHROPIC_API_KEY を書いてください。');
            }
            if (!cached) throw new Error('`ant auth print-credentials --access-token` が空を返しました。`ant auth login` をやり直してください。');
            fetchedAt = Date.now();
        }
        return cached;
    };
    getToken(); // 起動時に失敗を出す
    // getEffectiveAnthropicApiKey が空でないことを確かめるための置き値。実際には送らない。
    process.env.ANTHROPIC_API_KEY = 'ant-cli-oauth-placeholder';
    const g = globalThis as unknown as { fetch: (url: unknown, init?: { headers?: Record<string, string> } & Record<string, unknown>) => Promise<unknown> };
    const original = g.fetch.bind(globalThis);
    g.fetch = async (url, init = {}) => {
        if (String(url).startsWith('https://api.anthropic.com/')) {
            const headers: Record<string, string> = { ...(init.headers ?? {}) };
            delete headers['x-api-key'];
            headers['authorization'] = `Bearer ${getToken()}`;
            return original(url, { ...init, headers });
        }
        return original(url, init);
    };
}

/** --dry-run 用の fetch の模型。実 API には通信しない。最初のリクエストだけ内容を表示する。 */
function installFakeFetch(retryBaseOverride: () => void): { sent: () => number } {
    let calls = 0;
    const g = globalThis as unknown as { fetch: unknown };
    g.fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls++;
        const body = JSON.parse(init.body);
        if (calls === 1) {
            const prompt: string = body.messages[0].content;
            console.log('--- dry-run: 1件目のリクエスト ---');
            console.log(`POST ${url}`);
            console.log(`headers: ${Object.keys(init.headers).join(', ')}（x-api-key の値は表示しない）`);
            console.log(`body keys: ${Object.keys(body).join(', ')}`);
            console.log(`model=${body.model} max_tokens=${body.max_tokens} output_config.effort=${body.output_config.effort} format=${body.output_config.format?.type}`);
            console.log(`temperature/top_p/top_k/thinking を送っているか: ${['temperature', 'top_p', 'top_k', 'thinking'].some(k => k in body)}`);
            console.log(`prompt(${prompt.length}文字) 先頭: ${JSON.stringify(prompt.slice(0, 160))}`);
            console.log('----------------------------------');
        }
        const text: string = body.messages[0].content;
        const hash = Array.from(text).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
        const mkRes = (status: number, json: unknown) => ({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: () => null },
            text: async () => JSON.stringify(json),
            json: async () => json,
        });
        // 模型の挙動: 7件に1件は初回に 429、29件に1件は max_tokens で打ち切り（件数の集計の確認用）。
        if (hash % 7 === 0 && !(g as { __seen?: Set<number> }).__seen?.has(hash)) {
            const seen: Set<number> = (g as { __seen?: Set<number> }).__seen ?? new Set<number>();
            seen.add(hash);
            (g as { __seen?: Set<number> }).__seen = seen;
            return mkRes(429, { error: { type: 'rate_limit_error' } });
        }
        const truncated = hash % 29 === 0;
        const prob = (hash % 100) / 100;
        return mkRes(200, {
            id: `msg_dry_${hash}`,
            model: body.model,
            stop_reason: truncated ? 'max_tokens' : 'end_turn',
            content: truncated ? [] : [{ type: 'text', text: JSON.stringify({ include_probability: prob, reasons: ['dry-run'], evidence: [] }) }],
            usage: {
                input_tokens: 900 + (hash % 200),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 150 + (hash % 300),
                output_tokens_details: { thinking_tokens: 100 + (hash % 100) },
            },
        });
    };
    retryBaseOverride();
    return { sent: () => calls };
}

async function main(): Promise<void> {
    const args = parseArgs();
    const configPath = path.join(__dirname, 'config.json');
    const config: BenchConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const condition = config.conditions.find(c => c.id === args.condition);
    if (!condition) throw new Error(`不明な condition: ${args.condition}`);

    // 条件をアプリの設定に固定する。食い違っていたら調整済みの条件になってしまうので止める。
    const app = getModelGenerationSettings(condition.model);
    if (app.provider !== 'anthropic' || (app.reasoningEffort ?? 'low') !== condition.reasoningEffort || app.maxOutputTokens !== condition.maxOutputTokens) {
        throw new Error(
            `条件 ${condition.id} がアプリの設定と一致しません: app=${JSON.stringify(app)} / condition effort=${condition.reasoningEffort} maxOutputTokens=${condition.maxOutputTokens}`
        );
    }
    const sentMaxTokens = anthropicMaxOutputTokens(condition.maxOutputTokens);

    // smoke（--sample 指定）は並列を下げた設定で回す。
    const rateLimitName = args.sample && condition.smokeRateLimit ? condition.smokeRateLimit : condition.rateLimit;
    const rateLimit = config.rateLimits[rateLimitName];
    if (!rateLimit) throw new Error(`不明な rateLimit: ${rateLimitName}`);

    const datasetRel = config.datasets[args.dataset];
    if (!datasetRel) throw new Error(`不明な dataset: ${args.dataset}`);
    const projectRoot = path.resolve(__dirname, '..', '..');
    const datasetPath = path.join(projectRoot, datasetRel);

    const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const records: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.records;
    const allRefs: Array<Reference & { label_included: number }> = records.map((r, i) => ({
        ref_id: String(r.ref_id ?? r.id ?? `row-${i}`),
        title: (r.title || '') as string,
        abstract: (r.abstract || '') as string,
        label_included: ((r.label_included ?? r.label_tiab ?? r.label ?? 0) as number),
    }));
    const references = args.sample && args.sample < allRefs.length ? allRefs.slice(0, args.sample) : allRefs;

    let screeningPrompt = config.defaultScreeningPrompt;
    const criteria = config.datasetConfigs[args.dataset]?.criteria || '';
    if (screeningPrompt.includes('{{CRITERIA}}')) {
        screeningPrompt = screeningPrompt.replace('{{CRITERIA}}', criteria);
    } else if (criteria) {
        screeningPrompt = `## Inclusion Criteria\n${criteria}\n\n${screeningPrompt}`;
    }

    const retry = { ...(config.retry ?? { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 60000 }) };
    if (args.dryRun) {
        process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'dry-run-dummy-key';
        installFakeFetch(() => { retry.baseDelayMs = 5; retry.maxDelayMs = 20; });
    } else if (!process.env.ANTHROPIC_API_KEY) {
        installAntBearerAuth();
        console.log('認証: ant CLI の OAuth トークン（Authorization: Bearer）。ANTHROPIC_API_KEY は未設定');
    }

    const resultsDir = args.dryRun ? path.join(os.tmpdir(), 'anthropic-bench-dry-run') : path.join(__dirname, 'results');
    ensureDir(resultsDir);

    // 再開: 取得済み（error なし）の件は残し、失敗した件と未着手の件だけ回す。
    const experimentId = args.resume ?? generateExperimentId(condition.id);
    const logPath = path.join(resultsDir, `experiment_${experimentId}.log.json`);
    const itemsPath = path.join(resultsDir, `items_${experimentId}.json`);
    const items: PerItemResult[] = [];
    let priorDurationMs = 0;
    let startTime = new Date().toISOString();
    if (args.resume) {
        if (!fs.existsSync(itemsPath) || !fs.existsSync(logPath)) throw new Error(`再開元が見つかりません: ${itemsPath}`);
        const prior = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as ExperimentLog;
        if (prior.parameters.dataset !== args.dataset || prior.parameters.condition.id !== condition.id || prior.parameters.sampleSize !== args.sample) {
            throw new Error('再開元の dataset / condition / sample が今回の指定と違います');
        }
        startTime = prior.startTime;
        priorDurationMs = prior.results?.durationMs ?? 0;
        for (const it of JSON.parse(fs.readFileSync(itemsPath, 'utf-8')) as PerItemResult[]) {
            if (!it.error && it.include_probability !== null) items.push(it);
        }
        console.log(`再開: 取得済み ${items.length} 件を引き継ぐ`);
    }
    const doneIds = new Set(items.map(i => i.ref_id));
    const todo = references.filter(r => !doneIds.has(r.ref_id));
    const order = new Map(references.map((r, i) => [r.ref_id, i]));

    const log: ExperimentLog = {
        experimentId,
        startTime,
        dryRun: args.dryRun || undefined,
        parameters: {
            dataset: args.dataset,
            datasetPath,
            totalRecords: allRefs.length,
            sampleSize: args.sample,
            condition,
            sentMaxTokens,
            rateLimitName,
            rateLimitConfig: rateLimit,
            screeningPrompt,
        },
    };
    const save = () => fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    save();

    console.log(`=== ${experimentId}${args.dryRun ? ' (dry-run)' : ''} ===`);
    console.log(`provider=${condition.provider} model=${condition.model} effort=${condition.reasoningEffort} max_tokens=${sentMaxTokens}`);
    console.log(`dataset=${args.dataset} N=${references.length} (positives=${references.filter(r => r.label_included === 1).length}) 今回の実行=${todo.length}件`);
    console.log(`rateLimit=${rateLimitName} concurrency=${rateLimit.concurrency} delayMs=${rateLimit.delayBetweenRequests}`);

    const checkpointEvery = config.checkpointEvery ?? 50;
    const sem = new Semaphore(rateLimit.concurrency);
    let processed = 0;
    const start = Date.now();

    const sortItems = () => items.sort((a, b) => (order.get(a.ref_id) ?? 0) - (order.get(b.ref_id) ?? 0));
    const flushItems = () => fs.writeFileSync(itemsPath, JSON.stringify(sortItems(), null, 2));
    const summarizeProgress = () => ({
        processedCount: items.length,
        successCount: items.filter(i => !i.error).length,
        failCount: items.filter(i => i.error).length,
        durationMs: priorDurationMs + (Date.now() - start),
        avgTimePerItem: items.length > 0 ? (priorDurationMs + (Date.now() - start)) / items.length : 0,
    });

    const tasks = todo.map(async (ref) => {
        await sem.acquire();
        try {
            const r = await runOne(ref, condition, screeningPrompt, retry);
            items.push(r);
            processed++;
            const pct = ((processed / todo.length) * 100).toFixed(1);
            process.stdout.write(`\r進捗 ${processed}/${todo.length} (${pct}%) errors=${items.filter(i => i.error).length}`);
            if (processed % checkpointEvery === 0) {
                flushItems();
                log.results = summarizeProgress();
                save();
            }
            if (rateLimit.delayBetweenRequests > 0 && !args.dryRun) await sleep(rateLimit.delayBetweenRequests);
        } finally {
            sem.release();
        }
    });
    await Promise.all(tasks);
    console.log('');

    flushItems();

    const failCount = items.filter(i => i.error).length;
    const successCount = items.length - failCount;
    const truncatedCount = items.filter(i => i.errorKind === 'max_tokens').length;
    const refusalCount = items.filter(i => i.errorKind === 'refusal').length;
    const failureRate = items.length > 0 ? failCount / items.length : 0;
    const valid = failureRate <= (config.invalidFailureRate ?? 0.01);

    const tokensTotal = items.reduce<TokenTotals>((acc, it) => {
        if (it.usage) {
            acc.prompt += it.usage.prompt;
            acc.cached += it.usage.cached;
            acc.completion += it.usage.completion;
            acc.reasoning += it.usage.reasoning;
        }
        return acc;
    }, { prompt: 0, cached: 0, completion: 0, reasoning: 0 });

    const estimatedCostUsd = computeCost(tokensTotal, config.pricing[condition.model]);
    const perItem = estimatedCostUsd !== undefined && successCount > 0 ? estimatedCostUsd / successCount : undefined;

    log.results = {
        ...summarizeProgress(),
        failureRate,
        truncatedCount,
        refusalCount,
        valid,
        tokensTotal,
        estimatedCostUsd,
        cost: estimatedCostUsd !== undefined && perItem !== undefined
            ? { totalUSD: estimatedCostUsd, perItemUSD: perItem, extrapolatedFullUSD: perItem * allRefs.length }
            : undefined,
    };
    log.evaluation = calculateMetrics(items, args.threshold);
    log.endTime = new Date().toISOString();
    save();

    console.log(`\n=== 結果 (threshold=${args.threshold}) ===`);
    console.log(`TP=${log.evaluation.truePositives} FP=${log.evaluation.falsePositives} TN=${log.evaluation.trueNegatives} FN=${log.evaluation.falseNegatives}`);
    console.log(`Sensitivity: ${(log.evaluation.sensitivity * 100).toFixed(2)}%`);
    console.log(`Specificity: ${(log.evaluation.specificity * 100).toFixed(2)}%`);
    console.log(`Precision:   ${(log.evaluation.precision * 100).toFixed(2)}%`);
    console.log(`Fβ(β=7):     ${(log.evaluation.fBetaScore * 100).toFixed(2)}%`);
    console.log(`tokens: prompt=${tokensTotal.prompt} (cached=${tokensTotal.cached}) completion=${tokensTotal.completion} (うち thinking=${tokensTotal.reasoning})`);
    console.log(`失敗=${failCount}/${items.length} (${(failureRate * 100).toFixed(2)}%) 打ち切り(max_tokens)=${truncatedCount} 拒否=${refusalCount}`);
    if (!valid) {
        console.warn(`!! 失敗が ${(((config.invalidFailureRate ?? 0.01)) * 100).toFixed(0)}% を超えたため、この実行は無効です。原因を report.md に書いて取り直してください（--resume で失敗分だけ取り直せます）。`);
    }
    if (estimatedCostUsd !== undefined && perItem !== undefined) {
        console.log(`推定コスト: $${estimatedCostUsd.toFixed(4)}（1件あたり $${perItem.toFixed(6)}）`);
        console.log(`全${allRefs.length}件への外挿（cost.totalUSD / ${successCount} × ${allRefs.length}）: $${(perItem * allRefs.length).toFixed(2)}`);
    }
    console.log(`log:   ${logPath}`);
    console.log(`items: ${itemsPath}`);
}

main().catch(err => {
    console.error('実験失敗:', err);
    process.exit(1);
});
