/**
 * results/ の最新の実行から report.md の表を作る。
 *
 * 作るもの: 全件の比較表（B4 を基準に併記）、トークン消費 / レイテンシ、費用の実績（モデル別・
 * データセット別の USD）、採用判断（同梱の基準 Recall ≥ 0.90、既定モデルの置き換え基準 Recall ≥ 0.95）、
 * CQ1〜5 を実行していればその表、サンプル実行の参考表（全件の費用の外挿つき）、評価の限界。
 * 考察の文章は実行結果を見て書き足す（この script は数値の表と機械的な判定だけを出す）。
 *
 * 使い方:
 *   npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/summarize.ts
 *   ... --results-dir <dir> --out-dir <dir>（テスト用に入出力を差し替える）
 */

import fs from 'fs';
import path from 'path';
import { calculateMetrics, loadLatestRuns, pct, readFlag } from './common';
import type { LoadedRun } from './common';

interface BenchConfig {
    invalidFailureRate?: number;
    adoptionThresholds?: { bundle: number; default: number };
    baselineResults: {
        depression: { B4: { model: string; config: string; recall: number; specificity: number; precision: number; fBeta7: number; tp: number; fp: number; tn: number; fn: number } };
        recallByDataset: { columns: string[]; rows: Record<string, number[]> };
    };
}

const DATASET_ORDER = ['depression', 'cq1', 'cq2', 'cq3', 'cq4', 'cq5'];
const CQ = DATASET_ORDER.slice(1);

function usd(v: number | undefined, dec = 3): string {
    return v === undefined ? '-' : `$${v.toFixed(dec)}`;
}

function byDataset(a: LoadedRun, b: LoadedRun): number {
    const d = DATASET_ORDER.indexOf(a.log.parameters.dataset) - DATASET_ORDER.indexOf(b.log.parameters.dataset);
    return d !== 0 ? d : a.log.parameters.condition.id.localeCompare(b.log.parameters.condition.id);
}

function main(): void {
    const config: BenchConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
    const resultsDir = readFlag('results-dir') ?? path.join(__dirname, 'results');
    const outDir = readFlag('out-dir') ?? __dirname;
    const invalidRate = config.invalidFailureRate ?? 0.01;
    const bundleMin = config.adoptionThresholds?.bundle ?? 0.90;
    const defaultMin = config.adoptionThresholds?.default ?? 0.95;

    const { full, samples } = loadLatestRuns(resultsDir);
    if (full.length === 0 && samples.length === 0) {
        console.error(`${resultsDir} に終了済みの実行がありません`);
        process.exit(1);
    }
    full.sort(byDataset);
    samples.sort(byDataset);
    const dep = full.filter(r => r.log.parameters.dataset === 'depression');
    const isValid = (r: LoadedRun) => (r.log.results?.failureRate ?? 0) <= invalidRate;
    const b4 = config.baselineResults.depression.B4;

    const lines: string[] = [];
    lines.push('# Anthropic 同梱モデル ベンチマーク結果');
    lines.push('');
    lines.push('**depression データセット (1,993件 / 陽性 280件) での、アプリが送る設定 (effort `low`) のままの評価。閾値 0.5 固定。**');
    lines.push('同梱の採用基準 (Recall ≥ 0.90) の判定が目的で、条件の調整はしていない。基準は B4 (`gemini-3-flash-preview`, thinkingLevel=LOW) と並べて示す。');
    lines.push('');

    lines.push('## 全件 (N=1,993) ベンチマーク比較');
    lines.push('');
    if (dep.length === 0) {
        lines.push('depression の全件の実行はまだない。');
    } else {
        lines.push('| 条件 | Model | effort | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN | 時間(s) | 費用(USD) | 有効 |');
        lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
        lines.push(
            `| **B4** (既存記録) | ${b4.model} | LOW | **${pct(b4.recall)}** | ${pct(b4.specificity)} | ${pct(b4.precision)} | ${pct(b4.fBeta7)} ` +
            `| ${b4.tp} | ${b4.fp} | ${b4.tn} | ${b4.fn} | - | - | - |`
        );
        for (const r of dep) {
            const c = r.log.parameters.condition;
            const e = calculateMetrics(r.items, 0.5);
            const res = r.log.results;
            lines.push(
                `| ${c.id} | ${c.model} | ${c.reasoningEffort ?? '-'} | **${pct(e.sensitivity)}** | ${pct(e.specificity)} | ${pct(e.precision)} | ${pct(e.fBetaScore)} ` +
                `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} ` +
                `| ${res ? (res.durationMs / 1000).toFixed(0) : '-'} | ${usd(res?.estimatedCostUsd)} | ${isValid(r) ? '有効' : '**無効**'} |`
            );
        }
    }

    lines.push('');
    lines.push('## トークン消費 / レイテンシ (全件の実行)');
    lines.push('');
    lines.push('| データセット | 条件 | 1件平均(ms) | prompt | cached | completion | thinking | 失敗 | 打ち切り(max_tokens) | 拒否 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of full) {
        const res = r.log.results;
        const tk = res?.tokensTotal;
        lines.push(
            `| ${r.log.parameters.dataset} | ${r.log.parameters.condition.id} | ${res ? Math.round(res.avgTimePerItem) : '-'} ` +
            `| ${tk?.prompt ?? '-'} | ${tk?.cached ?? '-'} | ${tk?.completion ?? '-'} | ${tk?.reasoning ?? '-'} ` +
            `| ${res?.failCount ?? '-'} (${res?.failureRate !== undefined ? (res.failureRate * 100).toFixed(2) + '%' : '-'}) | ${res?.truncatedCount ?? '-'} | ${res?.refusalCount ?? '-'} |`
        );
    }
    lines.push('');
    lines.push('- completion は thinking を含む出力トークン数（課金の対象）。thinking はその内訳。');
    lines.push('- 打ち切り（`max_tokens` で応答が途切れた件）は使用量が返らず、費用に入らない。その分、実際の請求は下の表より少し多い。');

    lines.push('');
    lines.push('## 費用の実績 (USD)');
    lines.push('');
    if (full.length === 0) {
        lines.push('全件の実行はまだない。');
    } else {
        lines.push('| データセット | 条件 | モデル | 件数 | 費用(USD) | 1,000件あたり(USD) |');
        lines.push('|---|---|---|---|---|---|');
        const perModel = new Map<string, number>();
        let grand = 0;
        for (const r of full) {
            const cost = r.log.results?.estimatedCostUsd ?? 0;
            const p = r.log.parameters;
            perModel.set(p.condition.model, (perModel.get(p.condition.model) ?? 0) + cost);
            grand += cost;
            lines.push(`| ${p.dataset} | ${p.condition.id} | ${p.condition.model} | ${r.items.length} | ${usd(cost)} | ${usd(r.items.length > 0 ? cost / r.items.length * 1000 : undefined)} |`);
        }
        lines.push('');
        lines.push('| モデル | 全件の実行の費用の合計(USD) |');
        lines.push('|---|---|');
        for (const [m, v] of perModel) lines.push(`| ${m} | ${usd(v)} |`);
        lines.push(`| **合計** | **${usd(grand)}** |`);
        lines.push('');
        lines.push('疎通・smoke の費用は下の「サンプル実行」の表にある。');
    }

    lines.push('');
    lines.push('## 採用判断');
    lines.push('');
    lines.push(`- 同梱の採用基準: depression 全件で Recall ≥ ${bundleMin.toFixed(2)}（閾値 0.5）。既定モデルの置き換え基準: Recall ≥ ${defaultMin.toFixed(2)}。`);
    lines.push(`- 失敗（API のエラーでフォールバックになった件）が全体の ${(invalidRate * 100).toFixed(0)}% を超えた実行は無効として扱う。`);
    if (dep.length === 0) {
        lines.push('- depression の全件の実行がまだないため、判定は未了。');
    }
    for (const r of dep) {
        const c = r.log.parameters.condition;
        const e = calculateMetrics(r.items, 0.5);
        const res = r.log.results;
        const rate = res?.failureRate ?? 0;
        if (!isValid(r)) {
            lines.push(`- ${c.id} (${c.model}): 失敗 ${res?.failCount} 件 (${(rate * 100).toFixed(2)}%) で無効。判定しない。原因を書いて取り直す。`);
            continue;
        }
        lines.push(
            `- ${c.id} (${c.model}): Recall ${pct(e.sensitivity)}（TP ${e.truePositives} / 陽性 ${e.truePositives + e.falseNegatives}）。` +
            `同梱の採用基準 ${e.sensitivity >= bundleMin ? '**満たす**' : '**満たさない**'}、` +
            `既定モデルの置き換え基準 ${e.sensitivity >= defaultMin ? '満たす' : '満たさない'}。` +
            (e.sensitivity >= bundleMin ? ' CQ1〜5 は smoke で外挿した費用を本人に示してから実行する。' : ' CQ1〜5 は実行しない。同梱から外すか注記を付けて残すかを本人に確かめる。')
        );
    }

    const cqRuns = full.filter(r => CQ.includes(r.log.parameters.dataset));
    if (cqRuns.length > 0) {
        lines.push('');
        lines.push('## 全データセット Recall');
        lines.push('');
        const conds = Array.from(new Set(full.map(r => r.log.parameters.condition.id))).sort();
        const bl = config.baselineResults.recallByDataset;
        lines.push(`| データセット | n | 陽性率 | ${bl.columns.join(' | ')} | ${conds.join(' | ')} |`);
        lines.push(`|---|---|---|${bl.columns.map(() => '---').join('|')}|${conds.map(() => '---').join('|')}|`);
        const cell = (ds: string, cond: string): string => {
            const r = full.find(x => x.log.parameters.dataset === ds && x.log.parameters.condition.id === cond);
            return r ? `${pct(calculateMetrics(r.items, 0.5).sensitivity)}${isValid(r) ? '' : '（無効）'}` : '未実施';
        };
        for (const ds of ['depression', ...CQ]) {
            const any = full.find(r => r.log.parameters.dataset === ds);
            if (!any) continue;
            const n = any.items.length;
            const pos = any.items.filter(i => i.label_included === 1).length;
            const b = bl.rows[ds];
            lines.push(`| ${ds} | ${n.toLocaleString('en-US')} | ${pct(pos / n)} | ${b.map(v => v.toFixed(1) + '%').join(' | ')} | ${conds.map(c => cell(ds, c)).join(' | ')} |`);
        }
        // CQ1〜5 合算（5データセットの混同行列を足したマイクロ平均。5つそろった条件だけ）
        const pooledCells = conds.map(cond => {
            const rs = CQ.map(ds => full.find(x => x.log.parameters.dataset === ds && x.log.parameters.condition.id === cond));
            if (rs.some(r => !r)) return '未実施';
            let tp = 0, fn = 0;
            for (const r of rs as LoadedRun[]) {
                const e = calculateMetrics(r.items, 0.5);
                tp += e.truePositives; fn += e.falseNegatives;
            }
            return `${pct(tp / (tp + fn))}（${tp}/${tp + fn}）`;
        });
        lines.push(`| CQ1〜5 合算 | - | - | ${bl.rows.pooled.map(v => v.toFixed(1) + '%').join(' | ')} | ${pooledCells.join(' | ')} |`);
        lines.push('');
        lines.push('- 閾値はいずれも 0.5（`jev-1.14.0` の列は拡張の既定閾値 0.3）。CQ1〜5 合算は5データセットの混同行列を足したマイクロ平均。');
        lines.push('- Anthropic の2列は、depression で同梱の基準を満たした条件だけを CQ1〜5 まで実行した結果。「未実施」は実行していない。');
    }

    if (samples.length > 0) {
        lines.push('');
        lines.push('## 参考: サンプル実行（疎通・smoke）');
        lines.push('');
        lines.push('小サンプルでは Recall が陽性数に大きく左右されるため、判定には使わない。費用の外挿は `cost.totalUSD / 成功件数 × 全件数`。');
        lines.push('');
        lines.push('| データセット | 条件 | サンプルN | Recall | Precision | 失敗 | 費用(USD) | 1件あたり(USD) | 全件への外挿(USD) |');
        lines.push('|---|---|---|---|---|---|---|---|---|');
        for (const r of samples) {
            const p = r.log.parameters;
            const e = calculateMetrics(r.items, 0.5);
            const res = r.log.results;
            lines.push(
                `| ${p.dataset} | ${p.condition.id} | ${p.sampleSize} | ${pct(e.sensitivity)} | ${pct(e.precision)} | ${res?.failCount ?? '-'} ` +
                `| ${usd(res?.estimatedCostUsd, 4)} | ${usd(res?.cost?.perItemUSD, 6)} | ${usd(res?.cost?.extrapolatedFullUSD, 2)}（全 ${p.totalRecords.toLocaleString('en-US')} 件） |`
            );
        }
    }

    lines.push('');
    lines.push('## 評価の限界');
    lines.push('');
    lines.push('- 評価は開発者自身によるもので、第三者による独立した検証はない。');
    lines.push('- depression は前臨床の系統的レビュー（うつ病の動物モデル）で、抄録はほぼ英語。他の分野・言語での性能は確かめていない。');
    lines.push('- depression は条件の調整にも使ったデータセットで、値は楽観的になりえる（この実験では Anthropic の条件を調整していないが、プロンプトと判定基準の文は他のモデルの調整後のものを使っている）。');
    lines.push('- 評価データは公開済みの系統的レビューなので、LLM が学習の段階で見ている可能性があり（データの汚染）、性能が高めに出ることがある。');
    lines.push('- モデルの提供元が更新すると性能は変わりえる。モデル ID は固定だが、提供終了や挙動の更新はこの結果に反映されない。');
    lines.push('- 打ち切りで使用量が返らなかった件は費用に入らず、費用は実際の請求よりわずかに少ない。');

    const out = lines.join('\n') + '\n';
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'report.md');
    fs.writeFileSync(outPath, out);
    console.log(out);
    console.log(`\n出力: ${outPath}`);
}

main();
