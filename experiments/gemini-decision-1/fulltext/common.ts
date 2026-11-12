// 全文実験の設定・入力・追記台帳を検証し、実行と集計で共有する。
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export class ExperimentError extends Error {}
export type Tier = 'cc-by' | 'cc-by-nc';
export type Input = 'pdf' | 'text';
export const root = path.resolve(process.cwd());
export const directory = path.join(root, 'experiments/gemini-decision-1/fulltext');
export const fakeDirectory = path.join(root, '.tmp/gemini-decision-1-fulltext-fake');
export interface Config {
    model: string;
    ledgerVersion: string;
    includeQuestion: string;
    reasonQuestion: string;
    reasonCriteria: Record<string, string>;
    textInputTemplate: string;
    pricing: { inputPerMillion: number; outputPerMillion: number };
    pricingSource: string;
    concurrency: number;
    maxAttempts: number;
    requestTimeoutMs: number;
    maxPdfBytes: number;
    adoptionRule: string;
    thresholdsFile: string;
}
export interface RecordRow {
    key: string;
    pmcid: string;
    cochrane_id: string;
    pmid: string;
    label: 'included' | 'excluded';
    gold_exclusion_reason: string | null;
    study_keys: string[];
    title: string;
    screening_prompt: string;
    text: string;
    text_chars: number;
    text_truncated: boolean;
    report_pmcid: string;
    pdf_url: string | null;
    pdf_md5: string | null;
    jev_probability: number;
}
export interface Modality { modality: string; tokens: number }
export interface Result {
    include_probability: number;
    reason_choice: string;
    reason_probabilities: Record<string, number>;
    input_tokens: number;
    tokens_by_modality: Modality[] | null;
    model_version: string | null;
}
export interface LedgerRow extends Result {
    key: string;
    pmcid: string;
    pmid: string;
    input: Input;
    attempts: number;
    latency_ms: number;
    config_hash: string;
    completed_at: string;
}
export interface FailureRow {
    key: string;
    http_status: number | null;
    error_status: string | null;
    kind: 'http' | 'network' | 'timeout' | 'invalid_response';
    attempts: number;
    config_hash: string;
    completed_at: string;
}
export const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');
export const probability = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
export const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function loadConfig(): Config {
    const config: Config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    if (![config.concurrency, config.maxAttempts, config.requestTimeoutMs, config.maxPdfBytes].every(n => Number.isInteger(n) && n > 0)
        || config.textInputTemplate !== 'Title: <title>\n\nFull text:\n<text>' || !Object.keys(config.reasonCriteria).length) {
        throw new ExperimentError('実験設定が不正です。');
    }
    return config;
}
export function readRecords(file: string): { records: RecordRow[]; digest: string } {
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const records: RecordRow[] = content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const keys = new Set<string>();
    for (const row of records) {
        if (!row || row.key !== `${row.pmcid}:${row.pmid}` || keys.has(row.key)
            || !['included', 'excluded'].includes(row.label) || !probability(row.jev_probability)
            || !Array.isArray(row.study_keys) || !row.study_keys.length || row.study_keys.some(s => typeof s !== 'string')
            || ![row.title, row.text, row.screening_prompt].every(s => typeof s === 'string')
            || typeof row.report_pmcid !== 'string' || (row.pdf_url !== null && typeof row.pdf_url !== 'string')) {
            throw new ExperimentError('入力レコードの形式またはキーが不正です。');
        }
        keys.add(row.key);
    }
    const digest = sha256(content);
    const manifest = path.join(path.dirname(file), 'manifest.json');
    if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, 'utf8')).records_sha256 !== digest) {
        throw new ExperimentError('manifest.json と records.jsonl の SHA-256 が一致しません。');
    }
    return { records, digest };
}
export function configHash(config: Config, input: Input, digest: string): string {
    return sha256(JSON.stringify({ model: config.model, ledgerVersion: config.ledgerVersion, input,
        includeQuestion: config.includeQuestion, reasonQuestion: config.reasonQuestion, reasonCriteria: config.reasonCriteria,
        textInputTemplate: config.textInputTemplate, recordsSha256: digest }));
}
export function outputPaths(tier: Tier, input: Input, config: Config, fake: boolean, override?: string) {
    const base = override ?? (fake ? fakeDirectory : path.join(directory, 'results'));
    const stem = path.join(base, `${tier}_${input}_${config.ledgerVersion}`);
    return { ledger: `${stem}.jsonl`, failures: `${stem}.failures.jsonl`, base };
}
export function validResult(row: Result, criteria: Record<string, string>): boolean {
    return !!row && probability(row.include_probability) && Object.hasOwnProperty.call(criteria, row.reason_choice)
        && !!row.reason_probabilities && Object.keys(criteria).every(k => probability(row.reason_probabilities[k]))
        && nonnegative(row.input_tokens) && (row.model_version === null || typeof row.model_version === 'string')
        && (row.tokens_by_modality === null || (Array.isArray(row.tokens_by_modality)
            && row.tokens_by_modality.every(m => m && typeof m.modality === 'string' && nonnegative(m.tokens))));
}
export function readLedger<T extends { key: string; config_hash: string }>(
    file: string, hash: string, validate: (row: T) => boolean,
): { rows: Map<string, T>; brokenLines: number; lineCount: number } {
    const rows = new Map<string, T>();
    let brokenLines = 0, lineCount = 0;
    if (!fs.existsSync(file)) {
        return { rows, brokenLines, lineCount };
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        lineCount++;
        let row: T;
        try {
            row = JSON.parse(line);
        } catch {
            brokenLines++;
            continue;
        }
        if (row && row.config_hash !== undefined && row.config_hash !== hash) {
            throw new ExperimentError('台帳に異なる config_hash があります。設定と入力を確認してください。');
        }
        if (!row || typeof row.key !== 'string' || row.config_hash !== hash || !validate(row)) {
            brokenLines++;
            continue;
        }
        rows.set(row.key, row);
    }
    if (brokenLines) {
        console.warn(`警告: 読めない台帳行 ${brokenLines} 件を除外しました。`);
    }
    return { rows, brokenLines, lineCount };
}
export function readSuccess(file: string, hash: string, input: Input, config: Config) {
    return readLedger<LedgerRow>(file, hash, row => validResult(row, config.reasonCriteria) && row.input === input
        && row.key === `${row.pmcid}:${row.pmid}` && nonnegative(row.latency_ms)
        && Number.isInteger(row.attempts) && row.attempts > 0 && Number.isFinite(Date.parse(row.completed_at)));
}
export function readFailures(file: string, hash: string) {
    return readLedger<FailureRow>(file, hash, row => ['http', 'network', 'timeout', 'invalid_response'].includes(row.kind)
        && (row.http_status === null || (Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599))
        && (row.error_status === null || (row.http_status === 400 && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.error_status)))
        && Number.isInteger(row.attempts) && row.attempts > 0 && Number.isFinite(Date.parse(row.completed_at)));
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
export function pdfState(record: RecordRow, recordsFile: string, config: Config, fake: boolean) {
    const file = path.join(path.dirname(recordsFile), 'pdf', `${record.report_pmcid}.pdf`);
    if (!record.pdf_url) {
        return { kind: 'no_pdf' as const, file };
    }
    if (fake) {
        return { kind: 'ready' as const, file };
    }
    if (!/^PMC[0-9]+$/.test(record.report_pmcid)) {
        throw new ExperimentError('PDF の識別子が不正です。');
    }
    if (!fs.existsSync(file)) {
        return { kind: 'pdf_missing' as const, file };
    }
    if (fs.statSync(file).size > config.maxPdfBytes) {
        return { kind: 'too_large' as const, file };
    }
    // 取り直しに失敗した不正な PDF が残っている場合は、未取得として取得のやり直しに回す。
    if (record.pdf_md5 && createHash('md5').update(fs.readFileSync(file)).digest('hex') !== record.pdf_md5.toLowerCase()) {
        return { kind: 'pdf_missing' as const, file };
    }
    return { kind: 'ready' as const, file };
}
export function fail(error: unknown): void {
    console.error(error instanceof ExperimentError ? error.message : '処理に失敗しました。設定・入力・保存先を確認してください。');
    process.exitCode = 1;
}
