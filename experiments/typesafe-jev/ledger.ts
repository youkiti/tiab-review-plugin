import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export interface BenchConfig {
    description: string;
    model: string;
    questionDesign: string;
    ledgerVersion: string;
    datasets: Record<string, {
        path: string; labelField: string;
        expected: { n: number; positives: number; emptyAbstracts: number };
        criteria: string;
    }>;
    defaultScreeningPrompt: string;
    outputLanguage: string;
    concurrency: number;
    retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
    smokeSampleSize: number;
    sampleSeed: number;
    thresholds: { primary: number; reference: number };
    pricing: null | { inputPerMillion: number; outputPerMillion: number };
    comparison: Record<string, Comparison[]>;
    pooledComparison: Comparison[];
    pooledGroup: string[];
}

export interface Comparison {
    model: string; condition: string; threshold: number; recall: number; specificity: number | null;
    precision: number | null; fBeta7: number | null; source: string;
}

export interface DatasetRecord {
    id: string;
    title: string;
    abstract: string;
    label_included: number;
}

export interface ScoredRecord {
    label_included: number;
    include_probability: number;
}

export interface LedgerRow extends ScoredRecord {
    key: string;
    dataset: string;
    model_requested: string;
    model_version: string | null;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    attempts: number;
    config_hash: string;
    ledger_version: string;
    completed_at: string;
}

// 外部応答や本文を含まない、自前の安全な診断だけを最上位で表示する。
export class BenchError extends Error {}

export const projectRoot = path.resolve(__dirname, '../..');
export const sweepThresholds = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export function loadConfig(): BenchConfig {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

export function screeningPrompt(config: BenchConfig, dataset: string): string {
    const criteria = config.datasets[dataset].criteria;
    return config.defaultScreeningPrompt.includes('{{CRITERIA}}')
        ? config.defaultScreeningPrompt.replace('{{CRITERIA}}', criteria)
        : criteria ? `## Inclusion Criteria\n${criteria}\n\n${config.defaultScreeningPrompt}` : config.defaultScreeningPrompt;
}

export function configHash(config: BenchConfig, dataset: string): string {
    return createHash('sha256').update(JSON.stringify({
        model: config.model, questionDesign: config.questionDesign, screeningPrompt: screeningPrompt(config, dataset),
        outputLanguage: config.outputLanguage,
    })).digest('hex');
}

export function outputPaths(config: BenchConfig, fake: boolean, dataset: string) {
    const directory = fake ? path.join(projectRoot, '.tmp/typesafe-jev-fake') : path.join(__dirname, 'results');
    return {
        directory,
        ledger: path.join(directory, `${dataset}_${config.model}_overall_${config.ledgerVersion}.jsonl`),
        sample: path.join(directory, `smoke_sample_${dataset}_${config.smokeSampleSize}.json`),
        report: fake ? path.join(directory, 'report.md') : path.join(__dirname, 'report.md'),
    };
}

export function loadDataset(config: BenchConfig, dataset: string): DatasetRecord[] {
    const { path: file, labelField, expected } = config.datasets[dataset];
    const data = JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
    const rows = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.id !== 'string' || typeof r.title !== 'string'
        || (typeof r.abstract !== 'string' && r.abstract != null) || ![0, 1].includes(r[labelField]))) {
        throw new BenchError('データセットの形式が不正です。');
    }
    const positives = rows.filter(r => r[labelField] === 1).length;
    const empty = rows.filter(r => !r.abstract).length;
    if (rows.length !== expected.n || new Set(rows.map(r => r.id)).size !== rows.length
        || positives !== expected.positives || empty !== expected.emptyAbstracts) {
        throw new BenchError(`データセットが想定と異なります: N=${rows.length}、陽性=${positives}、抄録なし=${empty}。`);
    }
    return rows.map(r => ({ id: r.id, title: r.title, abstract: r.abstract ?? '', label_included: r[labelField] }));
}

export function readLedger(file: string, expectedHash: string, dataset: string): { rows: Map<string, LedgerRow>; brokenLines: number } {
    const rows = new Map<string, LedgerRow>();
    let brokenLines = 0;
    if (!fs.existsSync(file)) return { rows, brokenLines };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row: LedgerRow;
        try { row = JSON.parse(line); } catch { brokenLines++; continue; }
        // 古い重複行も検査し、最終行でハッシュ不一致を隠さない。
        if (row && row.config_hash !== undefined && row.config_hash !== expectedHash) {
            throw new BenchError('レジャに現在と異なる config_hash があります。設定を戻すか版タグを変更してください。');
        }
        if (!row || typeof row.key !== 'string' || row.config_hash !== expectedHash
            || row.dataset !== dataset || typeof row.model_requested !== 'string'
            || (row.model_version !== null && typeof row.model_version !== 'string')
            || typeof row.ledger_version !== 'string' || ![0, 1].includes(row.label_included)
            || !Number.isFinite(row.include_probability) || row.include_probability < 0 || row.include_probability > 1
            || ![row.input_tokens, row.output_tokens, row.latency_ms].every(n => Number.isFinite(n) && n >= 0)
            || !Number.isInteger(row.attempts) || row.attempts < 1 || !Number.isFinite(Date.parse(row.completed_at))) {
            brokenLines++; continue;
        }
        rows.set(row.key, row);
    }
    return { rows, brokenLines };
}

export function appendLedger(file: string, row: LedgerRow): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 中断で改行が消えていても、次の成功行を壊れた末尾へ連結しない。
    let prefix = '';
    if (fs.existsSync(file)) {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            if (size) {
                const byte = Buffer.alloc(1);
                fs.readSync(fd, byte, 0, 1, size - 1);
                if (byte[0] !== 10) prefix = '\n';
            }
        } finally { fs.closeSync(fd); }
    }
    fs.appendFileSync(file, prefix + JSON.stringify(row) + '\n', 'utf8');
}

export function frozenSample(file: string, rows: DatasetRecord[], count: number, seed: number): DatasetRecord[] {
    const byId = new Map(rows.map(r => [r.id, r]));
    let ids: string[];
    if (fs.existsSync(file)) {
        try { ids = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { throw new BenchError('凍結標本を読めません。標本ファイルを確認してください。'); }
    } else {
        if (!Number.isInteger(count) || count < 1 || count > rows.length || !Number.isInteger(seed)) {
            throw new BenchError('標本数または seed が不正です。');
        }
        ids = rows.map(r => r.id);
        let state = seed >>> 0;
        // 固定 seed の線形合同法で Fisher–Yates シャッフルを行う。
        for (let i = ids.length - 1; i > 0; i--) {
            state = (Math.imul(1664525, state) + 1013904223) >>> 0;
            const j = Math.floor((state / 4294967296) * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        ids = ids.slice(0, count);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 書き込み途中の中断では、完成済みの標本だけが正式名になる。
        fs.writeFileSync(file + '.tmp', JSON.stringify(ids, null, 2) + '\n', 'utf8');
        fs.renameSync(file + '.tmp', file);
    }
    if (!Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count || ids.some(id => !byId.has(id))) {
        throw new BenchError('凍結標本の件数・重複・ID がデータセットと一致しません。');
    }
    return ids.map(id => byId.get(id)!);
}

export function calculateMetrics(items: ScoredRecord[], threshold: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const item of items) {
        const predicted = item.include_probability >= threshold;
        if (item.label_included === 1) { if (predicted) tp++; else fn++; }
        else { if (predicted) fp++; else tn++; }
    }
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const fBeta7 = recall + precision > 0 ? 50 * precision * recall / (49 * precision + recall) : 0;
    return { threshold, recall, specificity, precision, fBeta7, tp, fp, tn, fn };
}

export function thresholdSweep(items: ScoredRecord[], thresholds = sweepThresholds) {
    return thresholds.map(t => calculateMetrics(items, t));
}

export function recall95(items: ScoredRecord[]) {
    if (!items.some(r => r.label_included === 1)) return null;
    // 判定が変化する実測確率を全て調べる。固定スイープの点に限定しない。
    const thresholds = [...new Set([0, 1, ...items.map(r => r.include_probability)])].sort((a, b) => b - a);
    for (const threshold of thresholds) {
        const metrics = calculateMetrics(items, threshold);
        if (metrics.recall >= 0.95) return { ...metrics, wss95: (metrics.tn + metrics.fn) / items.length - 0.05 };
    }
    return null;
}

export function rocAuc(items: ScoredRecord[]): number | null {
    const sorted = [...items].sort((a, b) => a.include_probability - b.include_probability);
    const positives = sorted.filter(r => r.label_included === 1).length;
    const negatives = sorted.length - positives;
    if (!positives || !negatives) return null;
    let rankSum = 0;
    for (let i = 0; i < sorted.length;) {
        let end = i + 1;
        while (end < sorted.length && sorted[end].include_probability === sorted[i].include_probability) end++;
        const averageRank = (i + 1 + end) / 2;
        for (let j = i; j < end; j++) if (sorted[j].label_included === 1) rankSum += averageRank;
        i = end;
    }
    return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}
