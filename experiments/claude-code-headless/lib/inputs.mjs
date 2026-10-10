// 実行と集計で共通の引数、設定、対象文献を検証する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const experimentRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const resultsRoot = path.join(experimentRoot, 'results');

export function parseArgs(argv, summarize = false) {
    const options = { conditions: [] };
    const flags = summarize ? ['--smoke', '--all', '--allow-partial'] : ['--smoke', '--all', '--dry-run'];
    const values = summarize
        ? ['--condition', '--sample-file', '--out']
        : ['--condition', '--sample-file', '--limit', '--concurrency', '--claude-bin'];
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (!flags.includes(key) && !values.includes(key)) {
            throw new Error(`不明な引数: ${key}`);
        }
        let value = true;
        if (values.includes(key)) {
            value = argv[++index];
            if (!value || value.startsWith('--')) {
                throw new Error(`${key} の値が必要です`);
            }
        }
        if (key === '--condition') {
            options.conditions.push(value);
        } else {
            if (Object.hasOwn(options, key)) {
                throw new Error(`引数が重複: ${key}`);
            }
            options[key] = value;
        }
    }
    if (!options.conditions.length || (!summarize && options.conditions.length !== 1)
        || new Set(options.conditions).size !== options.conditions.length) {
        throw new Error('条件を指定してください（実行時は一つ、集計時は重複なし）');
    }
    if (['--smoke', '--all', '--sample-file'].filter((key) => options[key]).length !== 1) {
        throw new Error('--smoke / --all / --sample-file のいずれか一つを指定してください');
    }
    for (const key of ['--limit', '--concurrency']) {
        if (options[key] !== undefined) {
            const value = Number(options[key]);
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error(`${key} は正の整数で指定してください`);
            }
            options[key] = value;
        }
    }
    return options;
}

export function loadInputs(options) {
    const configText = fs.readFileSync(path.join(experimentRoot, 'config.json'), 'utf8');
    const config = JSON.parse(configText);
    const conditions = options.conditions.map((id) => {
        const condition = config.conditions.find((entry) => entry.id === id);
        if (!condition) {
            throw new Error(`未知の条件: ${id}`);
        }
        return condition;
    });
    const dataset = JSON.parse(fs.readFileSync(path.resolve(repoRoot, config.dataset.path), 'utf8'));
    const observed = {
        n: dataset.length,
        positives: dataset.filter((record) => record[config.dataset.labelField] === 1).length,
        emptyAbstracts: dataset.filter((record) => !record.abstract).length,
    };
    for (const [key, expected] of Object.entries(config.dataset.expected)) {
        if (observed[key] !== expected) {
            throw new Error(`データ件数不一致 ${key}: 期待 ${expected} / 実際 ${observed[key]}`);
        }
    }
    const byId = new Map(dataset.map((record) => [record.id, record]));
    if (byId.size !== dataset.length || dataset.some((record) => ![0, 1].includes(record[config.dataset.labelField]))) {
        throw new Error('データの ID 重複またはラベル不正');
    }
    const sampleFile = options['--smoke'] ? config.smokeSampleFile : options['--sample-file'];
    let ids = options['--all'] ? [...byId.keys()] : JSON.parse(fs.readFileSync(path.resolve(repoRoot, sampleFile), 'utf8'));
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {
        throw new Error('対象 ID は重複のない非空配列で指定してください');
    }
    for (const id of ids) {
        if (!byId.has(id)) {
            throw new Error(`データに存在しない対象 ID: ${id}`);
        }
    }
    ids = ids.slice(0, options['--limit'] ?? ids.length);
    const records = ids.map((id) => {
        const { title, abstract } = byId.get(id);
        return { id, title, abstract };
    });
    const labels = new Map(ids.map((id) => [id, byId.get(id)[config.dataset.labelField]]));
    const scope = options['--smoke'] ? 'smoke' : options['--all'] ? 'all' : path.parse(sampleFile).name;
    return { config, configText, conditions, records, labels, scope };
}
