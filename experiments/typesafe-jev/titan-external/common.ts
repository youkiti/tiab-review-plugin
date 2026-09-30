import fs from 'fs';
import path from 'path';
import { BenchConfig, BenchError, DatasetRecord, configHash, projectRoot } from '../ledger';

export interface Config {
    model: string; questionDesign: string; ledgerVersion: string; outputLanguage: string;
    concurrency: number; retry: BenchConfig['retry']; thresholds: BenchConfig['thresholds'];
    inputSha256: string;
    reviews: Record<string, { n: number; positives: number; emptyAbstracts: number; criteria: string }>;
    comparison: { source: string; reviews: Record<string, { titan: number | null; asreview: number | null }> };
    paperSummary: Record<string, { auc: number | null; s99: number; s95: number }>;
}
export const directory = path.join(projectRoot, 'experiments/typesafe-jev/titan-external');
export const fakeDirectory = path.join(projectRoot, '.tmp/typesafe-jev-titan-fake');
export const loadConfig = (): Config => JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
export function benchConfig(config: Config): BenchConfig {
    const parent: BenchConfig = JSON.parse(fs.readFileSync(path.join(directory, '../config.json'), 'utf8'));
    if (!parent.defaultScreeningPrompt.includes('{{CRITERIA}}')) throw new BenchError('親プロンプトに基準の置換箇所がありません。');
    return { ...parent, ...config, comparison: parent.comparison,
        datasets: Object.fromEntries(Object.entries(config.reviews).map(([id, review]) => [id, {
            path: '', labelField: 'label_included', expected: review, criteria: review.criteria,
        }])) };
}
export function ledgerPath(config: Config, fake: boolean, review: string): string {
    return path.join(fake ? fakeDirectory : path.join(directory, 'results'), `${review}_${config.model}_overall_${config.ledgerVersion}.jsonl`);
}
export function scoresPath(config: Config, fake: boolean, partial = false): string {
    return path.join(fake ? fakeDirectory : path.join(directory, 'scores'), `${config.model}_${config.ledgerVersion}${partial ? '.partial' : ''}.jsonl.gz`);
}
export function validateData(config: Config, review: string, data: { criteria: string; records: DatasetRecord[] }): void {
    const expected = config.reviews[review];
    const rows = data.records;
    if (!expected || data.criteria !== expected.criteria || !Array.isArray(rows)
        || rows.length !== expected.n || rows.some((r, i) => !r || r.id !== `${review}:${i}`
            || typeof r.title !== 'string' || typeof r.abstract !== 'string' || ![0, 1].includes(r.label_included))
        || rows.filter(r => r.label_included === 1).length !== expected.positives
        || rows.filter(r => !r.abstract).length !== expected.emptyAbstracts) {
        throw new BenchError(`データの件数・採用数・抄録なし・基準・形式が設定と一致しません: ${review}`);
    }
}
export function loadData(config: Config, review: string): DatasetRecord[] {
    const file = path.join(directory, 'data', `${review}.json`);
    if (!fs.existsSync(file)) throw new BenchError(`データがありません。prepare.ts --input <JSONLのパス> を実行してください: ${review}`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateData(config, review, data);
    return data.records;
}
export function atomicWrite(file: string, contents: string | Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file + '.tmp', contents); fs.renameSync(file + '.tmp', file); }
    finally { if (fs.existsSync(file + '.tmp')) fs.unlinkSync(file + '.tmp'); }
}
export function fail(error: unknown): void {
    console.error(error instanceof BenchError ? error.message : '処理に失敗しました。設定・入力・保存先を確認してください。');
    process.exitCode = 1;
}
export { configHash };
