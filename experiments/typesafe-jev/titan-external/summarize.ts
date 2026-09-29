import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { BenchError, calculateMetrics, rocAuc } from '../ledger';
import type { Score } from './export-scores';
import { atomicWrite, Config, directory, fail, fakeDirectory, loadConfig, scoresPath } from './common';
import { medianIqr, operatingPointAtRecall } from './metrics';

const number = (value: number | null) => value === null ? '—' : value.toFixed(4);
const distribution = (values: Array<number | null>) => {
    const valid = values.filter((v): v is number => v !== null);
    const { median, q1, q3 } = medianIqr(valid);
    return `${number(median)}［${number(q1)}, ${number(q3)}］（${valid.length}件）`;
};
function analyze(scores: Score[], config: Config) {
    return Object.keys(config.reviews).map(review => {
        const items = scores.filter(r => r.review === review).map(r => ({ label_included: r.label, include_probability: r.p }));
        return { review, items, n: items.length, positives: items.filter(r => r.label_included === 1).length,
            primary: calculateMetrics(items, config.thresholds.primary), reference: calculateMetrics(items, config.thresholds.reference),
            auc: rocAuc(items), r99: operatingPointAtRecall(items, 0.99), r95: operatingPointAtRecall(items, 0.95) };
    });
}
type Analysis = ReturnType<typeof analyze>;
function section(title: string, analysis: Analysis, config: Config): string[] {
    const { primary, reference } = config.thresholds;
    const rows = [
        `## ${title}`, '',
        `| レビュー | N | 採用 | Recall@${primary} | Specificity@${primary} | FN@${primary} | Recall@${reference} | Specificity@${reference} | FN@${reference} | AUC | S@99R | S@95R | WSS@95 |`,
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const r of analysis) rows.push(`| ${r.review} | ${r.n} | ${r.positives} | ${[
        r.positives ? number(r.primary.recall) : '—', r.n > r.positives ? number(r.primary.specificity) : '—', r.primary.fn,
        r.positives ? number(r.reference.recall) : '—', r.n > r.positives ? number(r.reference.specificity) : '—', r.reference.fn,
        number(r.auc), number(r.r99?.specificity ?? null), number(r.r95?.specificity ?? null), number(r.r95?.wss_at_recall ?? null),
    ].join(' | ')} |`);
    rows.push('', '### レビュー単位の中央値［IQR］', '', '| 指標 | 中央値［Q1, Q3］・有効レビュー数 |', '|---|---|');
    const metrics: Array<[string, Array<number | null>]> = [
        ['AUC', analysis.map(r => r.auc)], ['S@99R', analysis.map(r => r.r99?.specificity ?? null)],
        ['S@95R', analysis.map(r => r.r95?.specificity ?? null)],
        [`Recall@${primary}`, analysis.map(r => r.positives ? r.primary.recall : null)],
        [`Specificity@${primary}`, analysis.map(r => r.n > r.positives ? r.primary.specificity : null)],
        [`Recall@${reference}`, analysis.map(r => r.positives ? r.reference.recall : null)],
        [`Specificity@${reference}`, analysis.map(r => r.n > r.positives ? r.reference.specificity : null)],
    ];
    metrics.forEach(([name, values]) => rows.push(`| ${name} | ${distribution(values)} |`));
    const all = analysis.flatMap(r => r.items);
    rows.push('', `全件合算（マイクロ）: N=${all.length}、採用=${all.filter(r => r.label_included === 1).length}。`, '',
        '| 閾値 | Recall | Specificity | FN |', '|---:|---:|---:|---:|');
    for (const threshold of [primary, reference]) {
        const m = calculateMetrics(all, threshold);
        rows.push(`| ${threshold} | ${number(m.tp + m.fn ? m.recall : null)} | ${number(m.tn + m.fp ? m.specificity : null)} | ${m.fn} |`);
    }
    rows.push('', `閾値${primary}で Recall ≥99%: ${analysis.filter(r => r.positives && r.primary.recall >= 0.99).length} / ${analysis.length} レビュー。`, '');
    return rows;
}
function loadScores(file: string, config: Config, partial: boolean): Score[] {
    const scores: Score[] = gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const seen = new Set<string>();
    for (const row of scores) {
        const expected = row && config.reviews[row.review];
        const suffix = typeof row?.id === 'string' ? row.id.slice(row.review.length + 1) : '';
        const index = Number(suffix);
        if (!expected || !Number.isInteger(index) || index < 0 || index >= expected.n || row.id !== `${row.review}:${index}`
            || seen.has(row.id) || ![0, 1].includes(row.label) || !Number.isFinite(row.p) || row.p < 0 || row.p > 1
            || typeof row.has_abstract !== 'boolean') throw new BenchError('要約の形式・ID・確率・重複が不正です。');
        seen.add(row.id);
    }
    for (const [review, expected] of Object.entries(config.reviews)) {
        const items = scores.filter(r => r.review === review);
        const positives = items.filter(r => r.label === 1).length;
        const empty = items.filter(r => !r.has_abstract).length;
        if ((!partial && (items.length !== expected.n || positives !== expected.positives || empty !== expected.emptyAbstracts))
            || positives > expected.positives || empty > expected.emptyAbstracts) throw new BenchError(`要約の件数が設定と一致しません: ${review}`);
    }
    if (!partial && scores.filter(r => !r.has_abstract && r.label === 1).length !== 129) throw new BenchError('抄録なしの採用数が想定と一致しません。');
    return scores;
}
function main(): void {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--fake')) throw new BenchError('引数は --fake だけです。');
    const fake = args.includes('--fake'), config = loadConfig();
    const completeFile = scoresPath(config, fake), partialFile = scoresPath(config, fake, true);
    // 正式要約がある場合はそれだけを使い、暫定要約との重複集計を避ける。
    const file = fs.existsSync(completeFile) ? completeFile : partialFile;
    if (!fs.existsSync(file)) throw new BenchError('要約がありません。export-scores.ts を先に実行してください。');
    const partial = file === partialFile;
    const scores = loadScores(file, config, partial);
    const mainAnalysis = analyze(scores, config), abstractAnalysis = analyze(scores.filter(r => r.has_abstract), config);
    const report = path.join(fake ? fakeDirectory : directory, 'report.md');
    const link = (target: string) => path.relative(path.dirname(report), target).replace(/\\/g, '/');
    const source = (name: string) => `[${name}](${link(path.join(directory, name))})`;
    const lines = [
        `# TITAN-SR 外部検証：TypeSafe ${config.model}${fake ? '（偽応答・性能評価には使用不可）' : ''}${partial ? '（暫定）' : ''}`, '',
        '## 共通条件', '',
        `モデル: ${config.model}、質問設計: ${config.questionDesign}（総合 Noul 1問）、出力言語: ${config.outputLanguage}。`,
        `プロンプトは [親config.json](${link(path.join(directory, '../config.json'))}) の defaultScreeningPrompt を実行時に読み、{{CRITERIA}} をレビュー基準で置換。`,
        `入力 SHA-256: \`${config.inputSha256}\`。`,
        'データ出典: [Chan et al. 2025](https://doi.org/10.1017/rsm.2025.1)、[Mendeley](https://doi.org/10.17632/7sgmg89zb6)。',
        '比較論文: [Pitre et al. 2026, TITAN-SR](https://doi.org/10.1016/j.jclinepi.2026.112514)。',
        `ソース: ${['prepare.ts', 'run.ts', 'export-scores.ts', 'metrics.ts', 'summarize.ts', 'config.json', 'plan.md'].map(source).join(' / ')}。`,
        `再現用入力: [スコア要約](${link(file)}) のみ（設定を除く）。レジャ・本文データは集計に不要。`,
        `完了 ${scores.length} / 142504 件。${partial ? '暫定値は未完了分を分母に含めず、欠測による偏りがあり、全件評価とは比較できない。' : '全22レビュー完了。'}`,
        '', '主解析は全142,504件・採用768件。副解析は抄録あり136,456件・採用639件（抄録なし6,048件、うち採用129件を除外）。',
        '副解析は論文 l.492 の「136,456-record external set」と件数が一致するため、TITAN-SR と同じ条件と推定される。ただし本文に抄録なしの除外の記載はなく、同一条件と確定はできない。',
        'S@rR は目標Recallを満たす閾値での特異度。陽性スコアの降順で ceil(r×陽性数/100) 番目を閾値とし、同点を全件スクリーニングする。WSS@95 = 非スクリーニング割合 − 0.05。分位点はNumPy既定の線形補間。',
        '数値は割合（0〜1）。算出不能値は「—」で表示し、中央値から除外。有効件数を併記する。', '',
        ...section('主解析（抄録なしを含む）', mainAnalysis, config),
        ...section('副解析（抄録あり）', abstractAnalysis, config),
        '## レビュー別の比較', '', `${config.comparison.source}。誤差は±0.01程度。`, '',
        '| レビュー | TITAN-SR S@95R | ASReview S@95R | Jev 副解析 S@95R | Jev 主解析 S@95R |', '|---|---:|---:|---:|---:|',
    ];
    for (let i = 0; i < mainAnalysis.length; i++) {
        const r = mainAnalysis[i], c = config.comparison.reviews[r.review];
        lines.push(`| ${r.review} | ${number(c.titan)} | ${number(c.asreview)} | ${number(abstractAnalysis[i].r95?.specificity ?? null)} | ${number(r.r95?.specificity ?? null)} |`);
    }
    for (const [name, analysis] of [['副解析', abstractAnalysis], ['主解析', mainAnalysis]] as const) {
        for (const [key, model] of [['titan', 'TITAN-SR'], ['asreview', 'ASReview']] as const) {
            const differences: number[] = [], excluded: string[] = [];
            for (const r of analysis) {
                const baseline = config.comparison.reviews[r.review][key], value = r.r95?.specificity;
                if (baseline === null || value == null) excluded.push(r.review);
                else differences.push(value - baseline);
            }
            lines.push('', `${name}・Jev − ${model}: 上回る ${differences.filter(d => d > 0).length}、下回る ${differences.filter(d => d < 0).length}、同値 ${differences.filter(d => d === 0).length} レビュー。差の中央値 ${number(medianIqr(differences).median)}。比較から除外（図の値がnullまたは算出不能）: ${excluded.join(', ') || 'なし'}。`);
        }
    }
    lines.push('', '## 論文本文・表2の要約値との比較', '', '| 条件 | 中央値 AUC | 中央値 S@99R | 中央値 S@95R |', '|---|---:|---:|---:|');
    for (const [name, value] of Object.entries(config.paperSummary)) lines.push(`| ${name}${name === 'ASReview' ? '（ウォームアップあり）' : ''} | ${number(value.auc)} | ${number(value.s99)} | ${number(value.s95)} |`);
    for (const [name, analysis] of [['Jev 副解析', abstractAnalysis], ['Jev 主解析', mainAnalysis]] as const) {
        const median = (values: Array<number | null>) => number(medianIqr(values.filter((v): v is number => v !== null)).median);
        lines.push(`| ${name} | ${median(analysis.map(r => r.auc))} | ${median(analysis.map(r => r.r99?.specificity ?? null))} | ${median(analysis.map(r => r.r95?.specificity ?? null))} |`);
    }
    lines.push('', '考察は自動生成しない。図3Bの概数と本文表2の要約値は別の出典として扱う。', '');
    atomicWrite(report, lines.join('\n'));
    console.log(`レポートを書き出しました: ${report}`);
}
if (require.main === module) { try { main(); } catch (error) { fail(error); } }
