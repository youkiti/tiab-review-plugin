// 保存済みの対象文献だけを集計し、比較表と JSON を出力する。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadInputs, resultsRoot, repoRoot } from './lib/inputs.mjs';
import { ledgerPaths, readJsonl, compactByRefId } from './lib/ledger.mjs';
import { confusion, metricsFromConfusion, sweep } from './lib/metrics.mjs';

const tokenKeys = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'thinking_tokens'];

function aggregate(condition, rows, failures, labels, config, target) {
    const counts = confusion(rows, labels, config.primaryThreshold);
    const durations = rows.map((row) => row.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const median = durations.length === 0 ? null
        : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    return {
        condition: condition.id, model: condition.model, target, n: rows.length,
        partial: rows.length !== target, positives: counts.tp + counts.fn,
        threshold: config.primaryThreshold, confusion: counts, ...metricsFromConfusion(counts),
        sweep: sweep(rows, labels, config.thresholds),
        usage: Object.fromEntries(tokenKeys.map((key) => [key, rows.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0)])),
        total_cost_usd: rows.reduce((sum, row) => sum + (row.total_cost_usd ?? 0), 0),
        mean_duration_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        median_duration_ms: median, retried_records: rows.filter((row) => row.attempt > 1).length,
        failed_attempts: failures.length,
        models_reported: [...new Set(rows.map((row) => JSON.stringify([...row.models_reported].sort())))].map(JSON.parse),
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2), true);
    const { config, records, labels, conditions, scope } = loadInputs(options);
    const ids = new Set(records.map((record) => record.id));
    const loaded = conditions.map((condition) => {
        const paths = ledgerPaths(resultsRoot, condition.id);
        const items = readJsonl(paths.items);
        const failures = readJsonl(paths.failures);
        return {
            condition, rows: compactByRefId(items).filter((row) => ids.has(row.ref_id)),
            failures: failures.filter((row) => ids.has(row.ref_id)),
            skipped: items.skippedPartialLines + failures.skippedPartialLines,
        };
    });
    if (!options['--allow-partial'] && loaded.some(({ rows }) => rows.length !== ids.size)) {
        for (const { condition, rows } of loaded) {
            console.error(`${condition.id}: 未処理 ${ids.size - rows.length} 件`);
        }
        return 1;
    }
    const summaries = loaded.map(({ condition, rows, failures, skipped }) => ({
        ...aggregate(condition, rows, failures, labels, config, ids.size), skipped_partial_lines: skipped,
    }));
    const tag = (summary) => summary.partial ? `（途中集計: ${summary.n}/${summary.target} 件）` : '';
    const percent = (value) => value === null ? '—' : (100 * value).toFixed(2);
    const lines = [
        '| 条件・モデル | 件数 | 閾値 | 再現率 % | 特異度 % | 適合率 % | Fβ(7) % |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const summary of summaries) {
        const values = ['recall', 'specificity', 'precision', 'fBeta7'].map((key) => percent(summary[key]));
        const name = `${summary.condition} ${summary.model}${tag(summary)}`;
        lines.push(`| ${name} | ${summary.n} | ${summary.threshold} | ${values.join(' | ')} |`);
    }
    for (const baseline of config.baselines) {
        const values = ['recall', 'specificity', 'precision', 'fBeta7'].map((key) => baseline[key] ?? '—');
        lines.push(`| 参考 ${baseline.model} ${baseline.condition} | — | ${baseline.threshold} | ${values.join(' | ')} |`);
    }
    for (const summary of summaries) {
        lines.push(`${summary.condition}${tag(summary)} 集計詳細: ${JSON.stringify(summary)}`);
    }
    let disagreement = null;
    if (loaded.length >= 2) {
        const maps = loaded.map(({ rows }) => new Map(rows.map((row) => [row.ref_id, row.include_probability])));
        const common = [...ids].filter((id) => maps.every((map) => map.has(id)));
        const count = common.filter((id) => {
            return new Set(maps.map((map) => map.get(id) >= config.primaryThreshold)).size > 1;
        }).length;
        disagreement = { common_records: common.length, disagreeing_records: count, threshold: config.primaryThreshold };
        const tags = summaries.map((summary) => `${summary.condition}${tag(summary)}`).join(' / ');
        lines.push(`${tags}: 判定不一致 ${count} 件（共通 ${common.length} 件）`);
    }
    console.log(lines.join('\n'));
    const out = options['--out'] ? path.resolve(repoRoot, options['--out']) : path.join(resultsRoot, `summary_${scope}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
        scope, summaries, disagreement, baselines: config.baselines, markdown: lines.join('\n'),
    }, null, 4) + '\n', 'utf8');
    return 0;
}

try {
    process.exitCode = main();
} catch (error) {
    console.error(`入力・集計エラー: ${error.message}`);
    process.exitCode = 2;
}
