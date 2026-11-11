#!/usr/bin/env node
// bundle-stats の既存JSONから初期JS量と遅延チャンクの量を検査する。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
    { label: '拡張版 (extension)', entry: 'sidepanel/sidepanel' },
    { label: 'Web版 (web)', entry: 'app' },
    { label: '拡張版 (extension)', entry: 'fulltext/fulltext' },
    { label: '拡張版 (extension)', chunk: 'pdf-image-only' },
];

export function readMeasurements(stats) {
    if (!Array.isArray(stats.reports)) throw new Error('バンドル統計に reports がありません');
    return Object.fromEntries(TARGETS.map(({ label, entry, chunk }) => {
        const reports = stats.reports.filter((report) => report.label === label);
        if (chunk) {
            const chunks = reports[0]?.asyncChunks?.filter((item) => item.names?.includes(chunk)) ?? [];
            const bytes = chunks[0]?.size;
            if (reports.length !== 1 || chunks.length !== 1 || !Number.isSafeInteger(bytes) || bytes <= 0) {
                throw new Error(`遅延チャンクJSバイト数が不正です: ${label} / ${chunk}`);
            }
            return [chunk, bytes];
        }
        const bytes = reports[0]?.entrypoints?.[entry]?.jsBytes;
        if (reports.length !== 1 || !Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new Error(`初期JSバイト数が不正です: ${label} / ${entry}`);
        }
        return [entry, bytes];
    }));
}

export function createBudget(measurements) {
    return {
        version: 1,
        entries: Object.fromEntries(Object.entries(measurements).map(([entry, bytes]) => [entry, {
            measuredBytes: bytes,
            maxBytes: Math.ceil(bytes * 1.01),
        }])),
    };
}

export function compareBudget(measurements, budget) {
    if (budget.version !== 1) throw new Error('バンドル予算のバージョンが不正です');
    return Object.entries(measurements).map(([entry, bytes]) => {
        const maxBytes = budget.entries?.[entry]?.maxBytes;
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`バンドル予算が不正です: ${entry}`);
        return { entry, bytes, maxBytes, failed: bytes > maxBytes, improved: bytes <= maxBytes * 0.97 };
    });
}

export function main(args) {
    let statsPath;
    let update = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--update-budget') update = true;
        else if (args[i] === '--stats' && args[i + 1] && !args[i + 1].startsWith('--')) statsPath = path.resolve(args[++i]);
        else throw new Error('使用方法: node scripts/check-bundle-budget.mjs [--stats <JSONパス>] [--update-budget]');
    }
    if (!statsPath) {
        const directory = path.join(ROOT, '.tmp/bench');
        // bundle-stats はISO日時をファイル名に含めるので辞書順で最新を選べる。
        const latest = readdirSync(directory).filter((name) => /^bundle-stats-.*\.json$/.test(name)).sort().at(-1);
        if (!latest) throw new Error('統計がありません。npm run bench:bundle を先に実行してください');
        statsPath = path.join(directory, latest);
    }
    const measurements = readMeasurements(JSON.parse(readFileSync(statsPath, 'utf8')));
    const budgetPath = path.join(ROOT, 'scripts/bundle-budget.json');
    if (update) {
        writeFileSync(budgetPath, `${JSON.stringify(createBudget(measurements), null, 2)}\n`);
        console.log('実測値の101%（整数切り上げ）にバンドル予算を更新しました。変更理由をコミットに記録してください。');
    }
    const results = compareBudget(measurements, JSON.parse(readFileSync(budgetPath, 'utf8')));
    console.log(`バンドル統計: ${path.relative(ROOT, statsPath)}`);
    for (const result of results) {
        const description = TARGETS.some((target) => target.chunk === result.entry) ? '遅延チャンク JS' : '初期JS';
        console.log(`${result.failed ? 'FAIL' : 'PASS'}: ${result.entry} ${description} ${result.bytes} bytes / 上限 ${result.maxBytes} bytes（.map除外）`);
        if (result.improved) console.log(`${result.entry}: 3%以上の余裕があります。予算を更新できます。`);
    }
    return results.some((result) => result.failed) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`バンドル予算検査エラー: ${error.message}`);
        process.exitCode = 1;
    }
}
