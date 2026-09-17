import fs from 'fs';
import path from 'path';
import {
    BenchError, calculateMetrics, configHash, loadConfig, loadDataset, outputPaths,
    projectRoot, readLedger, recall95, rocAuc, thresholdSweep,
} from './ledger';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');

function main(): void {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--fake')) throw new BenchError('指定できる引数は --fake だけです。');
    const fake = args.includes('--fake');
    const config = loadConfig();
    const dataset = loadDataset(config);
    const paths = outputPaths(config, fake);
    const hash = configHash(config);
    const ledger = readLedger(paths.ledger, hash);
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
    for (const warning of warnings) console.warn(`警告: ${warning}`);
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
        `# TypeSafe jev-1.13.0 ベンチマーク${fake ? '（偽応答・性能評価には使用不可）' : ''}${n < dataset.length ? ` — 暫定（${n} / 1,993件）` : ''}`,
        '', '## 条件とカバレッジ', '',
        `- データセット: [depression](${link(config.datasets.depression)})、N=${dataset.length}、陽性280件、陰性1713件、抄録なし394件。`,
        `- カバレッジ: **${n} / 1,993件**（${percent(n / dataset.length)}）。集計対象の陽性${positives}件、陰性${n - positives}件。`,
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
        '', '## 閾値別の指標', '',
    ];
    const table = (metrics: ReturnType<typeof calculateMetrics>[]) => [
        '| 閾値 | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |',
        '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...metrics.map(m => `| ${m.threshold} | ${percent(m.recall)} | ${percent(m.specificity)} | ${percent(m.precision)} | ${percent(m.fBeta7)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} |`),
    ];
    lines.push(...table([primary, calculateMetrics(items, config.thresholds.extensionDefault)]),
        '', '## 既存記録との比較（主閾値0.5）', '',
        '| モデル | 条件 | Recall | Specificity | Precision | Fβ(7) | 出典 |',
        '|---|---|---:|---:|---:|---:|---|');
    for (const comparison of config.comparison) {
        const values = [comparison.recall, comparison.specificity, comparison.precision, comparison.fBeta7]
            .map(v => v === null ? '-' : `${v.toFixed(1)}%`);
        lines.push(`| ${comparison.model} | ${comparison.condition} | ${values.join(' | ')} | [記録](${link(comparison.source)}) |`);
    }
    lines.push(`| ${cell(config.model)} | 今回${fake ? '・偽応答' : ''}（N=${n}） | ${[primary.recall, primary.specificity, primary.precision, primary.fBeta7].map(percent).join(' | ')} | 本レポート |`,
        '', '## 閾値スイープ', '', ...table(thresholdSweep(items)), '', '## Recall 95%以上の閾値と ROC AUC', '');
    const best = recall95(items);
    lines.push(best
        ? `最大閾値: ${best.threshold}、Recall: ${percent(best.recall)}、Precision: ${percent(best.precision)}、Specificity: ${percent(best.specificity)}、WSS@95: ${percent(best.wss95)}。`
        : '最大閾値: 算出不可（陽性の完了記録なし）。');
    const auc = rocAuc(items);
    lines.push(`ROC AUC（順位法、同順位は0.5）: ${auc === null ? '算出不可（両クラスが必要）' : auc.toFixed(6)}。`,
        '最大閾値は実測確率を全て候補として探索する。WSS@95 = (TN + FN) / 完了件数 − 0.05。',
        '', '## 確率分布', '', '| 区間 | 陽性 | 陰性 |', '|---|---:|---:|');
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
    lines.push('', '## トークン・レイテンシ・コスト', '',
        '| 項目 | 合計 | 1件平均 |', '|---|---:|---:|',
        `| input tokens | ${input} | ${n ? (input / n).toFixed(2) : '-'} |`,
        `| output tokens | ${output} | ${n ? (output / n).toFixed(2) : '-'} |`,
        '', `レイテンシ: 平均 ${mean?.toFixed(2) ?? '-'} ms、中央値 ${median?.toFixed(2) ?? '-'} ms。`,
        `コスト: ${cost}。`,
        '成功した最終試行だけのトークン・時間・推定コスト。失敗試行の課金やバックオフ時間は含まない。',
        '', '## 採用判断（機械的な規則適用）', '',
        '主閾値0.5の Recall ≥95%: 採用候補（Precision・コスト・レイテンシで B4 と比較が必要）。93%以上95%未満: フォールバック枠。93%未満: 不採用。');
    const decision = positives === 0 ? '判定不能（陽性の完了記録なし）'
        : primary.recall >= 0.95 ? '採用候補（Precision・コスト・レイテンシで B4 と比較が必要）'
            : primary.recall >= 0.93 ? 'フォールバック枠' : '不採用';
    lines.push('', `判定: **${decision}**${n < dataset.length ? '（暫定）' : ''}${fake ? '（偽応答に対する動作確認のみ）' : ''}。`, '');
    fs.mkdirSync(path.dirname(paths.report), { recursive: true });
    fs.writeFileSync(paths.report, lines.join('\n'), 'utf8');
    console.log(`レポートを書き出しました: ${paths.report}（完了 ${n} / ${dataset.length}件）`);
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(error instanceof BenchError ? error.message : '集計に失敗しました。設定・入力ファイル・保存先を確認してください。');
        process.exitCode = 1;
    }
}
