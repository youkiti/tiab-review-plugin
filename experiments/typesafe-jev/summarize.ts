import fs from 'fs';
import path from 'path';
import {
    BenchConfig, BenchError, Comparison, LedgerRow, calculateMetrics, configHash, loadConfig, loadDataset, outputPaths,
    projectRoot, readLedger, recall95, rocAuc, thresholdSweep,
} from './ledger';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');

function collect(config: BenchConfig, fake: boolean, key: string) {
    const dataset = loadDataset(config, key);
    const paths = outputPaths(config, fake, key);
    const hash = configHash(config, key);
    const exists = fs.existsSync(paths.ledger);
    const ledger = readLedger(paths.ledger, hash, key);
    const warnings: string[] = [];
    if (ledger.brokenLines) warnings.push(`読めないレジャ行 ${ledger.brokenLines} 件を読み飛ばしました。`);
    let mismatched = 0;
    const items = dataset.flatMap(record => {
        const row = ledger.rows.get(record.id);
        if (!row) return [];
        if (row.label_included !== record.label_included) mismatched++;
        return [{ ...row, label_included: record.label_included }];
    });
    if (mismatched) warnings.push(`ラベル不一致 ${mismatched} 件はデータセットのラベルで集計しました。`);
    const unknown = ledger.rows.size - items.length;
    if (unknown) warnings.push(`データセットに存在しないキー ${unknown} 件を集計から除外しました。`);
    for (const warning of warnings) console.warn(`警告（${key}）: ${warning}`);
    return { key, dataset, paths, hash, exists, items, warnings };
}

function decision(items: LedgerRow[], threshold: number): string {
    if (!items.some(r => r.label_included === 1)) return '判定不能（陽性の完了記録なし）';
    const { recall } = calculateMetrics(items, threshold);
    return recall >= 0.95 ? '採用候補（Precision・コスト・レイテンシで B4 と比較が必要）'
        : recall >= 0.93 ? 'フォールバック枠' : '不採用';
}

function datasetSection(config: BenchConfig, fake: boolean, result: ReturnType<typeof collect>): string[] {
    const { key, dataset, paths, hash, items, warnings } = result;
    const n = items.length;
    const positives = items.filter(r => r.label_included === 1).length;
    const primary = calculateMetrics(items, config.thresholds.primary);
    const versions = new Map<string, number>();
    const requested = new Set<string>();
    for (const row of items) {
        versions.set(row.model_version ?? '不明', (versions.get(row.model_version ?? '不明') ?? 0) + 1);
        requested.add(row.model_requested);
    }
    const times = items.map(r => r.completed_at).sort((a, b) => Date.parse(a) - Date.parse(b));
    const firstStart = n ? new Date(Math.min(...items.map(r => Date.parse(r.completed_at) - r.latency_ms))).toISOString() : '-';
    const link = (relative: string) => path.relative(path.dirname(paths.report), path.join(projectRoot, relative)).replace(/\\/g, '/');
    const lines = [
        `## ${key}${n < dataset.length ? ` — 暫定（${n} / ${dataset.length}件）` : ''}`,
        '', '### 条件とカバレッジ', '',
        `- データセット: [${key}](${link(config.datasets[key].path)})、N=${dataset.length}、陽性${config.datasets[key].expected.positives}件、陰性${dataset.length - config.datasets[key].expected.positives}件、抄録なし${config.datasets[key].expected.emptyAbstracts}件。`,
        `- カバレッジ: **${n} / ${dataset.length}件**（${percent(n / dataset.length)}）。集計対象の陽性${positives}件、陰性${n - positives}件。`,
        '- 未完了の記録は指標の分母に含めない。暫定結果と既存全件結果の比較は未完了分による偏りを含み得る。',
        `- モデル要求値（設定）: ${cell(config.model)}。レジャの要求値: ${[...requested].map(cell).join(', ') || '-' }。`,
        `- 質問設計: ${cell(config.questionDesign)}（総合 Noul 1問、criteria 引数なし）、出力言語: ${cell(config.outputLanguage)}。`,
        `- config_hash: \`${hash}\`、レジャ版: ${cell(config.ledgerVersion)}。`,
        `- 実行期間（保存済み成功試行）: ${firstStart} ～ ${times[n - 1] ?? '-'}。中断時間・失敗試行の開始時刻は復元できない。`,
        `- ソース: [runner.ts](${link('experiments/typesafe-jev/runner.ts')}) / [ledger.ts](${link('experiments/typesafe-jev/ledger.ts')}) / [summarize.ts](${link('experiments/typesafe-jev/summarize.ts')}) / [config.json](${link('experiments/typesafe-jev/config.json')})。`,
        `- 元の成功レジャ: [JSONL](${path.relative(path.dirname(paths.report), paths.ledger).replace(/\\/g, '/')})。キーごとの最終行のみを使用。`,
        '', '| 応答 model_version | 件数 |', '|---|---:|',
        ...[...versions].sort().map(([version, count]) => `| ${cell(version)} | ${count} |`),
        '', ...warnings.map(w => `警告: ${w}`),
        '', '### 閾値別の指標', '',
    ];
    const table = (metrics: ReturnType<typeof calculateMetrics>[]) => [
        '| 閾値 | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |',
        '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...metrics.map(m => `| ${m.threshold} | ${percent(m.recall)} | ${percent(m.specificity)} | ${percent(m.precision)} | ${percent(m.fBeta7)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} |`),
    ];
    const reference = calculateMetrics(items, config.thresholds.reference);
    lines.push(...table([primary, reference]),
        '', '### 既存記録との比較', '',
        '| モデル | 条件 | 閾値 | Recall | Specificity | Precision | Fβ(7) | 出典 |',
        '|---|---|---:|---:|---:|---:|---:|---|');
    for (const comparison of config.comparison[key]) {
        const values = [comparison.recall, comparison.specificity, comparison.precision, comparison.fBeta7]
            .map(v => v === null ? '-' : `${v.toFixed(1)}%`);
        lines.push(`| ${cell(comparison.model)} | ${cell(comparison.condition)} | ${comparison.threshold} | ${values.join(' | ')} | [記録](${link(comparison.source)}) |`);
    }
    for (const m of [primary, reference]) {
        lines.push(`| ${cell(config.model)} | 今回${fake ? '・偽応答' : ''}（N=${n}） | ${m.threshold} | ${[m.recall, m.specificity, m.precision, m.fBeta7].map(percent).join(' | ')} | 本レポート |`);
    }
    lines.push('', '### 閾値スイープ', '', ...table(thresholdSweep(items)), '', '### Recall 95%以上の閾値と ROC AUC', '');
    const best = recall95(items);
    lines.push(best
        ? `最大閾値: ${best.threshold}、Recall: ${percent(best.recall)}、Precision: ${percent(best.precision)}、Specificity: ${percent(best.specificity)}、WSS@95: ${percent(best.wss95)}。`
        : '最大閾値: 算出不可（陽性の完了記録なし）。');
    const auc = rocAuc(items);
    lines.push(`ROC AUC（順位法、同順位は0.5）: ${auc === null ? '算出不可（両クラスが必要）' : auc.toFixed(6)}。`,
        '最大閾値は実測確率を全て候補として探索する。WSS@95 = (TN + FN) / 完了件数 − 0.05。',
        '', '### 確率分布', '', '| 区間 | 陽性 | 陰性 |', '|---|---:|---:|');
    const bins = Array.from({ length: 10 }, () => [0, 0]);
    for (const item of items) bins[Math.min(9, Math.floor(item.include_probability * 10))][item.label_included === 1 ? 0 : 1]++;
    bins.forEach(([positive, negative], i) => lines.push(`| [${(i / 10).toFixed(1)}, ${((i + 1) / 10).toFixed(1)}${i === 9 ? ']' : ')'} | ${positive} | ${negative} |`));
    const input = items.reduce((sum, r) => sum + r.input_tokens, 0);
    const output = items.reduce((sum, r) => sum + r.output_tokens, 0);
    const latency = items.map(r => r.latency_ms).sort((a, b) => a - b);
    const mean = n ? latency.reduce((a, b) => a + b, 0) / n : null;
    const median = n ? (latency[Math.floor((n - 1) / 2)] + latency[Math.floor(n / 2)]) / 2 : null;
    const cost = config.pricing === null ? '単価未公開のため未算出'
        : `${((input * config.pricing.inputPerMillion + output * config.pricing.outputPerMillion) / 1e6).toFixed(6)} USD`;
    lines.push('', '### トークン・レイテンシ・コスト', '',
        '| 項目 | 合計 | 1件平均 |', '|---|---:|---:|',
        `| input tokens | ${input} | ${n ? (input / n).toFixed(2) : '-'} |`,
        `| output tokens | ${output} | ${n ? (output / n).toFixed(2) : '-'} |`,
        '', `レイテンシ: 平均 ${mean?.toFixed(2) ?? '-'} ms、中央値 ${median?.toFixed(2) ?? '-'} ms。`,
        `コスト: ${cost}。`,
        '成功した最終試行だけのトークン・時間・推定コスト。失敗試行の課金やバックオフ時間は含まない。',
        '', '### 採用判断（機械的な規則適用）', '',
        `主閾値${config.thresholds.primary}の Recall ≥95%: 採用候補（Precision・コスト・レイテンシで B4 と比較が必要）。93%以上95%未満: フォールバック枠。93%未満: 不採用。`);
    lines.push('', `判定: **${decision(items, config.thresholds.primary)}**${n < dataset.length ? '（暫定）' : ''}${fake ? '（偽応答に対する動作確認のみ）' : ''}。`, '');
    return lines;
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--fake')) throw new BenchError('指定できる引数は --fake だけです。');
    const fake = args.includes('--fake');
    const config = loadConfig();
    const results = Object.keys(config.datasets).map(key => collect(config, fake, key));
    const report = results[0].paths.report;
    const link = (relative: string) => path.relative(path.dirname(report), path.join(projectRoot, relative)).replace(/\\/g, '/');
    const { primary, reference } = config.thresholds;
    const lines = [
        `# TypeSafe ${cell(config.model)} ベンチマーク${fake ? '（偽応答・性能評価には使用不可）' : ''}`,
        '', '## 共通条件', '',
        `- 全データセット共通: モデル ${cell(config.model)}、質問設計 ${cell(config.questionDesign)}（総合 Noul 1問、criteria 引数なし）、出力言語 ${cell(config.outputLanguage)}。`,
        '- プロンプトは共通の defaultScreeningPrompt を使用し、{{CRITERIA}} だけを各データセットの基準で置換する。',
        `- 主の閾値は ${primary}（拡張機能の既定閾値）、参考は ${reference}。比較対象の既存記録は閾値 0.5 の値である。`,
        `- 採用判断は主の閾値 ${primary} の Recall に適用: ≥95% 採用候補 / 93%以上95%未満 フォールバック枠 / 93%未満 不採用。`,
        '- 未完了の記録は指標の分母に含めない。暫定結果と既存全件結果の比較には未完了分による偏りがあり得る。',
        `- ソース: [runner.ts](${link('experiments/typesafe-jev/runner.ts')}) / [ledger.ts](${link('experiments/typesafe-jev/ledger.ts')}) / [summarize.ts](${link('experiments/typesafe-jev/summarize.ts')}) / [config.json](${link('experiments/typesafe-jev/config.json')})。`,
        '', '| データセット・元データ | config_hash |', '|---|---|',
        ...results.map(r => `| [${r.key}](${link(config.datasets[r.key].path)}) | \`${r.hash}\` |`),
        '', '## 概要', '',
        `| データセット | 完了 / N | Recall@${primary} | Specificity@${primary} | Precision@${primary} | Fβ(7)@${primary} | FN@${primary} | Recall@${reference} | B4 Recall@0.5 | flash-lite Recall@0.5 | 判定 |`,
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ];
    const summaryRow = (name: string, items: LedgerRow[], total: number, exists: boolean, comparisons: Comparison[], suffix: string) => {
        const m = calculateMetrics(items, primary);
        const values = items.length
            ? [...[m.recall, m.specificity, m.precision, m.fBeta7].map(percent), String(m.fn), percent(calculateMetrics(items, reference).recall)]
            : Array<string>(6).fill('-');
        const baseline = (model: string) => {
            const value = comparisons.find(c => c.model === model && c.threshold === 0.5);
            return value ? `[${value.recall.toFixed(1)}%](${link(value.source)})` : '-';
        };
        const verdict = exists ? decision(items, primary) : '未実行';
        return `| ${name} | ${items.length} / ${total} | ${values.join(' | ')} | ${baseline('gemini-3-flash-preview')} | ${baseline('gemini-3.1-flash-lite')} | ${verdict}${suffix} |`;
    };
    for (const r of results) {
        const footnote = config.datasets[r.key].expected.positives < 20 ? `[^${r.key}]` : '';
        lines.push(summaryRow(r.key + footnote, r.items, r.dataset.length, r.exists, config.comparison[r.key],
            r.exists && r.items.length < r.dataset.length ? '（暫定）' : ''));
    }
    const pooled = config.pooledGroup.map(key => {
        const result = results.find(r => r.key === key);
        if (!result) throw new BenchError('pooledGroup に未定義のデータセットがあります。');
        return result;
    });
    // データセットをまたいでキーを圧縮せず、全完了記録の混同行列を合算する。
    const items = pooled.flatMap(r => r.items);
    const total = pooled.reduce((sum, r) => sum + r.dataset.length, 0);
    const missing = pooled.filter(r => !r.exists).map(r => r.key);
    const provisional = pooled.some(r => !r.exists || r.items.length < r.dataset.length);
    lines.push(summaryRow('CQ1〜5 合算', items, total, pooled.some(r => r.exists), config.pooledComparison,
        provisional ? `・暫定（完了 ${items.length} / 合計 ${total} 件、未実行: ${missing.join(', ') || 'なし'}）` : ''), '',
        '- CQ1〜5 合算は pooledGroup のレジャがあるデータセットの混同行列を足して計算する（マイクロ平均）。未実行・未完了が1つでもあれば暫定とする。',
        '- 合算の既存比較: B4 は各 CQ の Recall と陽性数から逆算した TP 257 / 陽性259。flash-lite は TP/FP/TN/FN = 236/4631/11755/23。', '');
    for (const r of results) {
        const positives = config.datasets[r.key].expected.positives;
        if (positives > 0 && positives < 20) {
            lines.push(`[^${r.key}]: ${r.key} は陽性${positives}件。全件評価で見落とし1件につき Recall が約${(100 / positives).toFixed(2)}ポイント動く。`);
        }
    }
    lines.push('');
    for (const result of results.filter(r => r.exists)) lines.push(...datasetSection(config, fake, result));
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, lines.join('\n'), 'utf8');
    console.log(`レポートを書き出しました: ${report}`);
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(error instanceof BenchError ? error.message : '集計に失敗しました。設定・入力ファイル・保存先を確認してください。');
        process.exitCode = 1;
    }
}
