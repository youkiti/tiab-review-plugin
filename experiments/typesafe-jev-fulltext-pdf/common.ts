// 入力の検証、設定の識別、追記台帳の復旧と保存を共通化する。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FULLTEXT_TEXT_MAX_CHARS } from '../../src/lib/pdf-text-extract';
import { TYPESAFE_FULLTEXT_PROMPT_VERSION } from '../../src/lib/typesafe-fulltext';
import { DEFAULT_EXCLUDE_REASON_ITEMS } from '../../src/lib/exclude-reasons';

export type Tier = 'cc-by' | 'cc-by-nc';
export const tiers: Tier[] = ['cc-by', 'cc-by-nc'];
// コンパイル先に依存せず、リポジトリ直下を作業ディレクトリとして使う。
export const directory = path.resolve('experiments/typesafe-jev-fulltext-pdf');
export const recordsDirectory = path.resolve('experiments/gemini-decision-1/fulltext/data');
export const fakeDirectory = path.resolve('.tmp/typesafe-jev-fulltext-pdf-fake');
export interface Config {
    model: string;
    threshold: number;
    referenceThreshold: number;
    concurrency: number;
    maxAttempts: number;
    requestTimeoutMs: number;
    ledgerVersion: string;
    outputLanguage: string;
}
export interface RecordRow {
    key: string;
    pmcid: string;
    pmid: string;
    label: 'included' | 'excluded';
    gold_exclusion_reason: string | null;
    study_keys: string[];
    title: string;
    screening_prompt: string;
    report_pmcid: string | null;
    pdf_url: string | null;
    pdf_md5: string | null;
    jev_probability: number;
}
export interface LedgerRow {
    key: string;
    pmcid: string;
    pmid: string;
    report_pmcid: string | null;
    include_probability: number;
    decision: 'include' | 'exclude';
    choice: string | null;
    reason_probabilities: Record<string, number>;
    chars_sent: number;
    raw_length: number;
    truncated: boolean;
    references_removed: boolean;
    total_text_length: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    model_version: string | null;
    latency_ms: number;
    config_hash: string;
}
export type Status = 'no_pdf' | 'pdf_error' | 'image_only' | 'too_long' | 'failed';
export interface FailureRow {
    key: string;
    status: Status;
    error_kind: string | null;
    http_status: number | null;
    total_text_length: number;
    chars_sent: number;
    config_hash: string;
}
export class ExperimentError extends Error {}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const probability = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function readConfig(): Config {
    const config: Config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    if (config.model !== 'jev-1.14.0' || config.ledgerVersion !== 'v1'
        || config.threshold !== 0.3 || config.referenceThreshold !== 0.5 || config.outputLanguage !== 'en'
        || ![config.concurrency, config.maxAttempts, config.requestTimeoutMs].every(n => Number.isInteger(n) && n > 0)) {
        throw new ExperimentError('設定の値が不正です。');
    }
    return config;
}
export function readRecords(file: string) {
    const content = fs.readFileSync(file);
    const digest = sha256(content);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'manifest.json'), 'utf8'));
    if (manifest.records_sha256 !== digest) {
        throw new ExperimentError('records の SHA-256 が manifest と一致しません。');
    }
    const records: RecordRow[] = content.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const keys = new Set<string>();
    for (const row of records) {
        if (!row || !/^PMC\d+$/.test(row.pmcid) || !/^\d+$/.test(row.pmid) || row.key !== `${row.pmcid}:${row.pmid}`
            || keys.has(row.key) || !['included', 'excluded'].includes(row.label) || !probability(row.jev_probability)
            || ![row.title, row.screening_prompt].every(s => typeof s === 'string')
            || (row.gold_exclusion_reason !== null && typeof row.gold_exclusion_reason !== 'string')
            || !Array.isArray(row.study_keys) || row.study_keys.some(s => typeof s !== 'string')
            || (row.pdf_url !== null && typeof row.pdf_url !== 'string')
            || (row.pdf_url !== null && (typeof row.report_pmcid !== 'string' || !/^PMC\d+$/.test(row.report_pmcid)))
            || (row.pdf_md5 !== null && !/^[a-f\d]{32}$/i.test(row.pdf_md5))) {
            throw new ExperimentError('入力記録の形式またはキーが不正です。');
        }
        keys.add(row.key);
    }
    if (manifest.records !== records.length) {
        throw new ExperimentError('manifest の記録数が一致しません。');
    }
    return { records, digest };
}
export function configHash(config: Config, digest: string): string {
    return sha256(JSON.stringify({ config, recordsSha256: digest,
        promptVersion: TYPESAFE_FULLTEXT_PROMPT_VERSION, maxChars: FULLTEXT_TEXT_MAX_CHARS,
        reasonItems: DEFAULT_EXCLUDE_REASON_ITEMS }));
}
export function outputPaths(tier: Tier, config: Config, fake: boolean) {
    const base = fake ? fakeDirectory : path.join(directory, 'results');
    const stem = path.join(base, `${tier}_${config.ledgerVersion}`);
    return { base, ledger: `${stem}.jsonl`, failures: `${stem}.failures.jsonl` };
}
export function readLedger<T extends { key: string; config_hash: string }>(
    file: string, hash: string, validate: (row: T) => boolean,
) {
    const rows = new Map<string, T>();
    let brokenLines = 0;
    if (!fs.existsSync(file)) {
        return { rows, brokenLines };
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let row: T;
        try {
            row = JSON.parse(line);
        } catch {
            brokenLines++;
            continue;
        }
        if (row && row.config_hash !== undefined && row.config_hash !== hash) {
            throw new ExperimentError('台帳に異なる config_hash が混在しています。');
        }
        if (!row || typeof row.key !== 'string' || row.config_hash !== hash || !validate(row)) {
            brokenLines++;
            continue;
        }
        rows.set(row.key, row);
    }
    if (brokenLines) {
        console.warn(`警告: 壊れた台帳行 ${brokenLines} 件を除外しました。`);
    }
    return { rows, brokenLines };
}
export function readSuccess(file: string, hash: string) {
    return readLedger<LedgerRow>(file, hash, row => probability(row.include_probability)
        && row.key === `${row.pmcid}:${row.pmid}`
        && row.decision === (row.include_probability >= 0.3 ? 'include' : 'exclude')
        && (row.choice === null || typeof row.choice === 'string')
        && !!row.reason_probabilities && Object.values(row.reason_probabilities).every(probability)
        && [row.chars_sent, row.raw_length, row.total_text_length, row.input_tokens, row.output_tokens, row.latency_ms].every(nonnegative)
        && typeof row.truncated === 'boolean' && typeof row.references_removed === 'boolean'
        && (row.cost_usd === null || nonnegative(row.cost_usd))
        && (row.model_version === null || typeof row.model_version === 'string'));
}
export function readFailures(file: string, hash: string) {
    return readLedger<FailureRow>(file, hash, row => ['no_pdf', 'pdf_error', 'image_only', 'too_long', 'failed'].includes(row.status)
        && (row.error_kind === null || ['http', 'network', 'timeout', 'invalid_response', 'pdf', 'input_too_long', 'nonretryable'].includes(row.error_kind))
        && (row.http_status === null || (Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599))
        && nonnegative(row.total_text_length) && nonnegative(row.chars_sent));
}
export function appendLedger(file: string, row: LedgerRow | FailureRow): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    if (fs.existsSync(file)) {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const last = Buffer.alloc(1);
            if (size) {
                fs.readSync(fd, last, 0, 1, size - 1);
                if (last[0] !== 10) {
                    prefix = '\n';
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }
    fs.appendFileSync(file, prefix + JSON.stringify(row) + '\n', 'utf8');
}
export function atomicWrite(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, content, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
}
export function fail(error: unknown): void {
    console.error(error instanceof ExperimentError ? error.message : '処理に失敗しました。設定・入力・保存先を確認してください。');
    process.exitCode = 1;
}
