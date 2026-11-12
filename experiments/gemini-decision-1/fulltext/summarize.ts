// 成功集合を揃えて全文判定を比較し、凍結閾値・DeLong 推定・日本語レポートを保存する。
import fs from 'fs';
import path from 'path';
import {
    Config, ExperimentError, Input, RecordRow, Tier, atomicWrite, configHash, directory, fail, fakeDirectory, loadConfig,
    outputPaths, pdfState, readFailures, readRecords, readSuccess, sha256,
} from './common';
import { Score, chooseThreshold, delong, metrics } from './metrics';

interface Threshold { threshold: number; jevRecall: number; n: number; computedAt: string; configHash: string }
type Thresholds = Partial<Record<Input, Threshold>>;
export interface SummaryOptions {
    fake: boolean;
    tier?: Tier;
    freeze: boolean;
    force: boolean;
    recordsDir: string;
    outputDir?: string;
}
export function parseArgs(args: string[]): SummaryOptions {
    const options: SummaryOptions = { fake: false, freeze: false, force: false, recordsDir: path.join(directory, 'data') };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') {
            options.fake = true;
        } else if (args[i] === '--freeze-threshold') {
            options.freeze = true;
        } else if (args[i] === '--force') {
            options.force = true;
        } else if (args[i] === '--tier') {
            options.tier = args[++i] as Tier;
            if (!['cc-by', 'cc-by-nc'].includes(options.tier)) {
                throw new ExperimentError('層の指定が不正です。');
            }
        } else if (args[i] === '--records-dir') {
            const value = args[++i];
            if (!value) {
                throw new ExperimentError('入力ディレクトリがありません。');
            }
            options.recordsDir = path.resolve(value);
        } else {
            throw new ExperimentError('不明な引数です。');
        }
    }
    if ((options.freeze && options.tier !== 'cc-by') || (options.force && !options.freeze)) {
        throw new ExperimentError('閾値の凍結は --tier cc-by でだけ許可し、--force は凍結時だけ指定できます。');
    }
    return options;
}
function collect(tier: Tier, input: Input, config: Config, options: SummaryOptions) {
    const file = path.join(options.recordsDir, tier, 'records.jsonl');
    const { records, digest } = readRecords(file);
    const hash = configHash(config, input, digest);
    const paths = outputPaths(tier, input, config, options.fake, options.outputDir);
    const ledger = readSuccess(paths.ledger, hash, input, config);
    const failures = readFailures(paths.failures, hash);
    const ids = new Set(records.map(r => r.key));
    if ([...ledger.rows.keys(), ...failures.rows.keys()].some(key => !ids.has(key))) {
        throw new ExperimentError('台帳に入力外のキーがあります。');
    }
    const success = records.filter(r => ledger.rows.has(r.key));
    const failed = [...failures.rows.values()].filter(r => !ledger.rows.has(r.key));
    const scores: Score[] = success.map(record => ({ record, p: ledger.rows.get(record.key)!.include_probability }));
    const jev: Score[] = success.map(record => ({ record, p: record.jev_probability }));
    const skipped = { no_pdf: 0, too_large: 0, pdf_missing: 0 };
    let incomplete = 0;
    for (const record of records) {
        if (ledger.rows.has(record.key)) {
            continue;
        }
        const state = input === 'pdf' ? pdfState(record, file, config, options.fake) : { kind: 'ready' };
        if (state.kind !== 'ready') {
            skipped[state.kind as keyof typeof skipped]++;
        }
        if (state.kind !== 'no_pdf' && state.kind !== 'too_large') {
            incomplete++;
        }
    }
    return { tier, input, records, digest, hash, paths, ledger, scores, jev, failed, skipped, incomplete };
}
type Collection = ReturnType<typeof collect>;
const number = (value: number | null) => value === null ? '—' : value.toFixed(6);
const comparison = (result: ReturnType<typeof delong>) =>
    `AUC ${number(result.aucA)} / ${number(result.aucB)}、対の差 ${number(result.difference)}、95% CI `
    + (result.ci ? `[${number(result.ci[0])}, ${number(result.ci[1])}]` : '—');
export function summarize(options: SummaryOptions, config = loadConfig()): string {
    const base = options.outputDir ?? (options.fake ? fakeDirectory : path.join(directory, 'results'));
    const thresholdFile = options.fake || options.outputDir ? path.join(base, 'thresholds.json') : path.join(directory, config.thresholdsFile);
    const tiers: Tier[] = options.tier ? [options.tier] : ['cc-by', 'cc-by-nc'];
    const collections: Collection[] = [];
    for (const tier of tiers) {
        if (!fs.existsSync(path.join(options.recordsDir, tier, 'records.jsonl'))) {
            if (options.freeze || options.tier) {
                throw new ExperimentError('入力が未準備です。');
            }
            continue;
        }
        for (const input of ['pdf', 'text'] as Input[]) {
            collections.push(collect(tier, input, config, options));
        }
    }
    let thresholds: Thresholds = fs.existsSync(thresholdFile) ? JSON.parse(fs.readFileSync(thresholdFile, 'utf8')) : {};
    if (options.freeze) {
        if (fs.existsSync(thresholdFile) && !options.force) {
            throw new ExperimentError('閾値は凍結済みです。上書きには --force が必要です。');
        }
        const frozen: Thresholds = {};
        for (const result of collections) {
            if (result.incomplete || result.ledger.brokenLines) {
                throw new ExperimentError(`未完了 ${result.incomplete} 件または不正な台帳行があるため閾値を凍結しません。`);
            }
            const jevRecall = metrics(result.jev, 0.3).recall;
            frozen[result.input] = { threshold: chooseThreshold(result.scores, jevRecall), jevRecall: jevRecall!,
                n: result.scores.length, computedAt: new Date().toISOString(), configHash: result.hash };
        }
        atomicWrite(thresholdFile, JSON.stringify(frozen, null, 2) + '\n');
        thresholds = frozen;
    }
    for (const input of ['pdf', 'text'] as Input[]) {
        const frozen = thresholds[input];
        if (!frozen) {
            continue;
        }
        const trainingFile = path.join(options.recordsDir, 'cc-by', 'records.jsonl');
        if (!fs.existsSync(trainingFile) || configHash(config, input, readRecords(trainingFile).digest) !== frozen.configHash
            || !Number.isFinite(frozen.threshold) || frozen.threshold < 0 || frozen.threshold > 1) {
            throw new ExperimentError('凍結した閾値の設定ハッシュまたは値が一致しません。');
        }
    }
    const report = options.fake || options.outputDir ? path.join(base, 'report.md') : path.join(directory, 'report.md');
    const link = (file: string) => path.relative(path.dirname(report), file).replace(/\\/g, '/');
    const lines = ['<!-- 全文評価の件数・指標・採用条件の機械的な判定を記録する。 -->',
        '# Gemini Decisions API 全文評価', '', `生成時刻: ${new Date().toISOString()}`, '',
        options.fake ? '偽応答の動作確認。性能評価には使用できない。' : '成功台帳にある記録だけで比較する。未成功分の確率は補わない。', '',
        'ソース: ' + ['prepare.py', 'fetch_pdfs.py', 'config.json', 'common.ts', 'decisions-fulltext.ts', 'runner.ts', 'metrics.ts', 'summarize.ts']
            .map(f => `[${f}](${link(path.join(directory, f))})`).join(' / '), '',
        `採用条件: ${config.adoptionRule}`, '',
        '研究単位 Recall の分母も同じ成功集合のゴールド陽性から作る。DeLong の分散・共分散は標本共分散から計算する。',
        '陽性または陰性がない場合は AUC を算出しない。各クラス2件未満の場合は CI を算出しない。', '',
        '| 層 | 入力 | 成功台帳の行数 | 失敗台帳の行数 | records.jsonl SHA-256 |', '|---|---|---:|---:|---|'];
    for (const result of collections) {
        const failures = readFailures(result.paths.failures, result.hash);
        lines.push(`| ${result.tier} | ${result.input} | ${result.ledger.lineCount} | ${failures.lineCount} | ${result.digest} |`);
    }
    const verdicts = new Map<Input, boolean | null>();
    for (const result of collections) {
        const { tier, input, scores, jev, ledger } = result;
        const frozen = thresholds[input];
        lines.push('', `## ${tier} / ${input}`, '',
            `元データ: [records.jsonl](${link(path.join(options.recordsDir, tier, 'records.jsonl'))}) / `
            + `[成功台帳](${link(result.paths.ledger)}) / [失敗台帳](${link(result.paths.failures)})`, '',
            `成功 ${scores.length} / 全記録 ${result.records.length} 件、失敗 ${result.failed.length} 件`
            + `（HTTP 400: ${result.failed.filter(r => r.http_status === 400).length} 件）、未完了 ${result.incomplete} 件。`,
            `送らなかった記録: no_pdf ${result.skipped.no_pdf} / too_large ${result.skipped.too_large} / pdf_missing ${result.skipped.pdf_missing}。`,
            `台帳の不正行: ${ledger.brokenLines}。config_hash: ${result.hash}。`);
        const modalities = new Map<string, number>();
        let tokens = 0, unknownModality = 0;
        for (const { record } of scores) {
            const row = ledger.rows.get(record.key)!;
            tokens += row.input_tokens;
            if (!row.tokens_by_modality) {
                unknownModality += row.input_tokens;
            }
            for (const m of row.tokens_by_modality ?? []) {
                modalities.set(m.modality, (modalities.get(m.modality) ?? 0) + m.tokens);
            }
        }
        lines.push(`入力トークン合計 ${tokens}、推定費用 $${(tokens * config.pricing.inputPerMillion / 1e6).toFixed(6)}。`,
            `単価: ${config.pricingSource}。成功した最終試行のみの費用。失敗試行の費用は不明。`, '',
            '| modality | 入力トークン |', '|---|---:|',
            ...[...modalities].sort().map(([key, count]) => `| ${key.replace(/[^A-Za-z0-9_-]/g, '_')} | ${count} |`),
            `| 内訳なし | ${unknownModality} |`, '');
        if (tier === 'cc-by-nc' && !frozen) {
            lines.push('閾値が未凍結。評価の数値と採用判定は出力しない。');
            verdicts.set(input, null);
            continue;
        }
        lines.push(`凍結閾値 t*: ${frozen ? frozen.threshold : '未凍結'}。`, '',
            '| モデル | 閾値 | Recall | Specificity | Precision | TP | FP | TN | FN | 研究 Recall | found / included_studies |',
            '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
        const points = [
            ...(frozen ? [{ name: 'decision-1 t*', items: scores, threshold: frozen.threshold }] : []),
            ...[0.3, 0.5].map(threshold => ({ name: 'decision-1', items: scores, threshold })),
            ...[0.3, 0.5].map(threshold => ({ name: 'jev-1.14.0', items: jev, threshold })),
        ];
        for (const point of points) {
            const m = metrics(point.items, point.threshold);
            lines.push(`| ${point.name} | ${point.threshold} | ${number(m.recall)} | ${number(m.specificity)} | ${number(m.precision)}`
                + ` | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} | ${number(m.studyRecall)} | ${m.found} / ${m.includedStudies} |`);
        }
        const paired = delong(scores.map(s => s.record.label === 'included'), scores.map(s => s.p), jev.map(s => s.p));
        lines.push('', `decision-1 − jev（同じ ${scores.length} 件）: ${comparison(paired)}。`, '');
        if (frozen) {
            const distribution = new Map<string, number>();
            const excluded = scores.filter(s => s.p < frozen.threshold);
            for (const item of excluded) {
                const reason = ledger.rows.get(item.record.key)!.reason_choice;
                distribution.set(reason, (distribution.get(reason) ?? 0) + 1);
            }
            lines.push('除外理由（参考。採用判定には使用しない）。', '', '| reason_choice | 件数 |', '|---|---:|',
                ...Object.keys(config.reasonCriteria).map(key => `| ${key} | ${distribution.get(key) ?? 0} |`));
            if (tier === 'cc-by-nc' && input === 'pdf') {
                // seed とキーの SHA-256 昇順で選び、台帳の追記順に依存させない。
                const selected = [...excluded].sort((a, b) => {
                    const x = sha256(`2026:${a.record.key}`), y = sha256(`2026:${b.record.key}`);
                    return x < y ? -1 : x > y ? 1 : a.record.key.localeCompare(b.record.key);
                }).slice(0, 50);
                const sample = selected.map(({ record }) => {
                    const row = ledger.rows.get(record.key)!;
                    return { key: record.key, reason_choice: row.reason_choice, reason_probabilities: row.reason_probabilities,
                        label: record.label, gold_exclusion_reason: record.gold_exclusion_reason };
                });
                const sampleFile = path.join(options.recordsDir, tier, 'reason_sample_pdf.jsonl');
                atomicWrite(sampleFile, sample.map(row => JSON.stringify(row)).join('\n') + (sample.length ? '\n' : ''));
                lines.push('', `理由確認用の標本: ${sample.length} 件。seed 2026 とキーの SHA-256 昇順で最大50件を抽出。`);
            }
            if (tier === 'cc-by-nc') {
                const a = metrics(scores, frozen.threshold), b = metrics(jev, 0.3);
                const defined = a.recall !== null && b.recall !== null && a.specificity !== null && b.specificity !== null;
                const pass = defined ? a.recall! >= b.recall! && a.specificity! >= b.specificity! : null;
                verdicts.set(input, pass);
                lines.push('', `採用条件: ${pass === null ? '判定不能' : pass ? '満たす' : '満たさない'}。`
                    + `Recall ${a.recall ?? '—'} / jev ${b.recall ?? '—'}、Specificity ${a.specificity ?? '—'} / jev ${b.specificity ?? '—'}。`
                    + '丸める前の値で比較。' + (result.incomplete ? '未完了があるため暫定。' : ''));
            }
        }
    }
    for (const tier of tiers) {
        const pdf = collections.find(c => c.tier === tier && c.input === 'pdf');
        const text = collections.find(c => c.tier === tier && c.input === 'text');
        if (!pdf || !text || (tier === 'cc-by-nc' && (!thresholds.pdf || !thresholds.text))) {
            continue;
        }
        const common = pdf.scores.filter(s => text.ledger.rows.has(s.record.key));
        const paired = delong(common.map(s => s.record.label === 'included'), common.map(s => s.p),
            common.map(s => text.ledger.rows.get(s.record.key)!.include_probability));
        lines.push('', `## ${tier} / PDF − テキスト`, '', `共通成功 ${common.length} 件: ${comparison(paired)}。`);
    }
    if (tiers.includes('cc-by-nc')) {
        const pdf = verdicts.get('pdf'), text = verdicts.get('text');
        lines.push('', '## 主の採用判定', '', pdf === true ? '組み込む。PDF 入力が条件を満たす。'
            : pdf === false && text === true ? '組み込まない。PDF が満たさず、テキストだけが満たす。'
                : pdf === false ? '組み込まない。PDF 入力が条件を満たさない。' : '閾値未凍結または評価不能のため判定を保留する。');
    }
    atomicWrite(report, lines.join('\n') + '\n');
    console.log(`レポートを書き出しました: ${report}`);
    return report;
}
export function main(args = process.argv.slice(2)): void {
    summarize(parseArgs(args));
}
if (require.main === module) {
    try {
        main();
    } catch (error) {
        fail(error);
    }
}
