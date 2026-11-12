// 同じ成功集合の PDF・XML の指標と理由の一致を集計し、日本語レポートにする。
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_EXCLUDE_REASON_ITEMS } from '../../src/lib/exclude-reasons';
import {
    atomicWrite, configHash, directory, ExperimentError, fail, FailureRow, fakeDirectory, LedgerRow,
    outputPaths, readConfig, readFailures, readRecords, readSuccess, recordsDirectory, RecordRow, Tier, tiers,
} from './common';
import { mapReasons } from './reasons';

const ratio = (n: number, d: number) => d ? n / d : null;
interface Score { record: RecordRow; p: number }
export function metrics(items: Score[], threshold: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    const studies = new Set<string>(), found = new Set<string>();
    for (const { record, p } of items) {
        const include = p >= threshold;
        if (record.label === 'included') {
            if (include) {
                tp++;
            } else {
                fn++;
            }
            const keys = record.study_keys.length ? record.study_keys : [`pmid:${record.pmid}`];
            for (const study of keys) {
                const key = JSON.stringify([record.pmcid, study]);
                studies.add(key);
                if (include) {
                    found.add(key);
                }
            }
        } else if (include) {
            fp++;
        } else {
            tn++;
        }
    }
    return { tp, fp, tn, fn, recall: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp),
        precision: ratio(tp, tp + fp), studyRecall: ratio(found.size, studies.size),
        found: found.size, includedStudies: studies.size };
}
export function rocAuc(items: Score[]): number | null {
    const positive = items.filter(item => item.record.label === 'included').map(item => item.p);
    const negative = items.filter(item => item.record.label === 'excluded').map(item => item.p);
    if (!positive.length || !negative.length) {
        return null;
    }
    let sum = 0;
    for (const p of positive) {
        for (const n of negative) {
            sum += p > n ? 1 : p === n ? 0.5 : 0;
        }
    }
    return sum / (positive.length * negative.length);
}
const increment = (table: Record<string, number>, key: string) => { table[key] = (table[key] ?? 0) + 1; };
export function calculate(records: RecordRow[], successes: Map<string, LedgerRow>, failures: Map<string, FailureRow>) {
    const states = { ok: 0, no_pdf: 0, image_only: 0, too_long: 0, pdf_error: 0, failed: 0, unexecuted: 0 };
    const compared = records.filter(row => successes.has(row.key));
    for (const row of records) {
        if (successes.has(row.key)) {
            states.ok++;
        } else {
            const status = failures.get(row.key)?.status;
            states[status ?? 'unexecuted']++;
        }
    }
    const pdf = compared.map(record => ({ record, p: successes.get(record.key)!.include_probability }));
    const xml = compared.map(record => ({ record, p: record.jev_probability }));
    const paired = {
        included: { xml_only: 0, pdf_only: 0, both: 0, neither: 0 },
        excluded: { xml_only: 0, pdf_only: 0, both: 0, neither: 0 },
    };
    const reasons = { single: 0, single_match: 0, single_rate: null as number | null,
        multiple: 0, multiple_match: 0, multiple_rate: null as number | null, unmapped: 0,
        table: {} as Record<string, Record<string, number>>, choices: {} as Record<string, number> };
    for (const record of compared) {
        const row = successes.get(record.key)!;
        const a = record.jev_probability >= 0.3, b = row.include_probability >= 0.3;
        increment(paired[record.label], a && b ? 'both' : a ? 'xml_only' : b ? 'pdf_only' : 'neither');
        increment(reasons.choices, row.choice ?? 'missing');
        if (record.label !== 'excluded' || row.decision !== 'exclude') {
            continue;
        }
        const mapped = mapReasons(record.gold_exclusion_reason ?? '');
        if (mapped.size === 0) {
            reasons.unmapped++;
        } else if (mapped.size === 1) {
            reasons.single++;
            reasons.single_match += Number(mapped.has(row.choice ?? ''));
        } else {
            reasons.multiple++;
            reasons.multiple_match += Number(mapped.has(row.choice ?? ''));
        }
        for (const category of mapped.size ? mapped : ['unmapped']) {
            reasons.table[category] ??= {};
            increment(reasons.table[category], row.choice ?? 'missing');
        }
    }
    reasons.single_rate = ratio(reasons.single_match, reasons.single);
    reasons.multiple_rate = ratio(reasons.multiple_match, reasons.multiple);
    const pdf03 = metrics(pdf, 0.3), xml03 = metrics(xml, 0.3);
    const incomplete = states.unexecuted + states.pdf_error + states.failed;
    const verdict = incomplete ? '未完了' : pdf03.recall === null || xml03.recall === null ? '比較不能'
        : pdf03.recall >= xml03.recall ? '下がっていない' : '下がった';
    const rows = compared.map(record => successes.get(record.key)!);
    const chars = rows.map(row => row.chars_sent).sort((a, b) => a - b);
    const middle = Math.floor(chars.length / 2);
    return { states, comparison_count: compared.length, incomplete, verdict,
        pdf: { '0.3': pdf03, '0.5': metrics(pdf, 0.5), auc: rocAuc(pdf) },
        xml: { '0.3': xml03, '0.5': metrics(xml, 0.5), auc: rocAuc(xml) },
        xml_all: metrics(records.map(record => ({ record, p: record.jev_probability })), 0.3), paired, reasons,
        truncated: rows.filter(row => row.truncated).length,
        references_removed: rows.filter(row => row.references_removed).length,
        chars_sent_median: chars.length ? (chars.length % 2 ? chars[middle] : (chars[middle - 1] + chars[middle]) / 2) : null,
        input_tokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
        output_tokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
        cost_usd: rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
        cost_unknown: rows.filter(row => row.cost_usd === null).length };
}
type Summary = ReturnType<typeof calculate> & { tier: Tier; records_sha256: string; config_hash: string; records_file: string };
export function render(summaries: Summary[], fake: boolean): string {
    const reportDir = fake ? fakeDirectory : directory;
    const link = (label: string, file: string) => {
        const relative = path.relative(reportDir, file).replace(/\\/g, '/');
        const target = path.isAbsolute(relative) ? pathToFileURL(file).href : encodeURI(relative);
        return `[${label}](${target})`;
    };
    const sourceFiles = ['common.ts', 'config.json', 'extract.ts', 'runner.ts', 'reasons.ts', 'summarize.ts', 'selftest.ts', 'tsconfig.json'];
    const links = sourceFiles.map(file => link(file, path.join(directory, file)));
    links.push(link('pdf-text-extract.ts', path.resolve('src/lib/pdf-text-extract.ts')));
    links.push(link('typesafe-fulltext.ts', path.resolve('src/lib/typesafe-fulltext.ts')));
    const lines = ['# TypeSafe 全文 PDF 評価', '', 'ソース:', '', ...links.map(item => `- ${item}`), '',
        // リポジトリの外にあるので、置き場所に依らない絶対パスで書く。
        '元データ: [Cochrane-bench](<C:/Users/youki/codes/Cochrane-bench>)。',
        `XML 比較確率の出所: ${link('比較確率', path.resolve('experiments/gemini-decision-1/fulltext/plan.md'))} の「比較確率」。`, '',
        '除外理由の区分は機械的な近似であり、Cochrane-bench の正解ではない。',
        '比較の集合は成功した記録だけとする。研究単位の分母も同じ成功集合の陽性に限る。',
        '理由の対応表は複数区分に該当した記録を各行に数える。choice 分布は成功集合全体を数える。',
        '費用・トークンは成功した最終試行だけの合計であり、失敗した試行の課金は不明である。',
        ...(fake ? ['このレポートは偽応答による動作確認であり、性能の評価結果ではない。'] : []), ''];
    const value = (n: number | null) => n === null ? '—' : String(n);
    for (const summary of summaries) {
        lines.push(`## ${summary.tier}`, '', `入力: ${link('records.jsonl', summary.records_file)}`,
            `records SHA-256: \`${summary.records_sha256}\``, `config_hash: \`${summary.config_hash}\``, '',
            `判定: ${summary.verdict}`, '',
            '| 状態 | 記録数 |', '|---|---:|',
            ...Object.entries(summary.states).map(([key, count]) => `| ${key} | ${count} |`), '',
            `truncated: ${summary.truncated}、references_removed: ${summary.references_removed}、chars_sent 中央値: ${value(summary.chars_sent_median)}`, '',
            '| 入力 | 閾値 | TP | FP | TN | FN | Recall | Specificity | Precision | 研究 Recall | found / 全研究 | AUC |',
            '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
        for (const input of ['pdf', 'xml'] as const) {
            for (const threshold of ['0.3', '0.5'] as const) {
                const m = summary[input][threshold];
                lines.push(`| ${input} | ${threshold} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} | ${value(m.recall)}`
                    + ` | ${value(m.specificity)} | ${value(m.precision)} | ${value(m.studyRecall)}`
                    + ` | ${m.found} / ${m.includedStudies} | ${value(summary[input].auc)} |`);
            }
        }
        lines.push('', `全記録 XML 0.3: n=${Object.values(summary.states).reduce((a, b) => a + b, 0)}`
            + `、Recall=${value(summary.xml_all.recall)}、Specificity=${value(summary.xml_all.specificity)}`, '',
            '| ゴールド | XML のみ | PDF のみ | 両方 | どちらもなし |', '|---|---:|---:|---:|---:|');
        for (const [label, pair] of Object.entries(summary.paired)) {
            lines.push(`| ${label} | ${pair.xml_only} | ${pair.pdf_only} | ${pair.both} | ${pair.neither} |`);
        }
        const r = summary.reasons;
        lines.push('', `単一: ${r.single}、一致: ${r.single_match}、割合: ${value(r.single_rate)}`,
            `複数: ${r.multiple}、集合内: ${r.multiple_match}、割合: ${value(r.multiple_rate)}`,
            `unmapped: ${r.unmapped}`, '');
        const columns = [...new Set([...DEFAULT_EXCLUDE_REASON_ITEMS.map(item => item.key),
            ...Object.values(r.table).flatMap(counts => Object.keys(counts))])];
        lines.push(`| Cochrane 区分 | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---:|').join('')}`);
        for (const [category, counts] of Object.entries(r.table)) {
            lines.push(`| ${category} | ${columns.map(choice => counts[choice] ?? 0).join(' | ')} |`);
        }
        lines.push('', '| jev choice | 成功集合の件数 |', '|---|---:|',
            ...Object.entries(r.choices).map(([choice, count]) => `| ${choice} | ${count} |`), '',
            `input_tokens=${summary.input_tokens}、output_tokens=${summary.output_tokens}`
            + `、cost_usd=${summary.cost_usd}、費用不明=${summary.cost_unknown}`, '');
    }
    return lines.join('\n');
}
export function summarize(args = process.argv.slice(2)) {
    let fake = false, recordsDir = recordsDirectory;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') {
            fake = true;
        } else if (args[i] === '--records-dir' && args[i + 1] && !args[i + 1].startsWith('--')) {
            recordsDir = path.resolve(args[++i]);
        } else {
            throw new ExperimentError('集計の引数が不正です。');
        }
    }
    const config = readConfig();
    const summaries: Summary[] = tiers.map(tier => {
        const file = path.join(recordsDir, tier, 'records.jsonl');
        const { records, digest } = readRecords(file);
        const hash = configHash(config, digest), files = outputPaths(tier, config, fake);
        const success = readSuccess(files.ledger, hash).rows, failures = readFailures(files.failures, hash).rows;
        const keys = new Set(records.map(record => record.key));
        if ([...success.keys(), ...failures.keys()].some(key => !keys.has(key))) {
            throw new ExperimentError('台帳に入力外のキーがあります。');
        }
        return { tier, records_sha256: digest, config_hash: hash, records_file: file, ...calculate(records, success, failures) };
    });
    const base = fake ? fakeDirectory : path.join(directory, 'results');
    for (const summary of summaries) {
        atomicWrite(path.join(base, `summary_${summary.tier}.json`), JSON.stringify(summary, null, 2) + '\n');
    }
    atomicWrite(path.join(fake ? fakeDirectory : directory, 'report.md'), render(summaries, fake));
    console.log('集計とレポートを保存しました。');
    return summaries;
}
if (require.main === module) {
    try {
        summarize();
    } catch (error) {
        fail(error);
    }
}
