// measure-recall.ts
// Issue #119「着手条件」の測定本体。#118 の3戦略が結果論文をどれだけ取りこぼすかを測る。
//
// 実行:
//   npx ts-node --project experiments/tsconfig.json experiments/registry-linkage/measure-recall.ts \
//     --input experiments/registry-linkage/data/ground-truth.json --email you@example.com
//
// **ネットワークが必要**（clinicaltrials.gov / eutils.ncbi.nlm.nih.gov / www.ebi.ac.uk）。
// 詳細と正解セットの作り方は同ディレクトリの README.md を参照。
//
// 測定対象は再実装ではなく**出荷している探索コードそのもの**（src/lib/publication-suggest.ts の
// discoverPublicationCandidates と src/lib/publication-candidate-rerun.ts の discoverCandidatesForRerun）。
// 両モジュールとも chrome API に依存せず fetch しか使わないため Node から直接呼べる。

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fetchCtgStudy } from '../../src/lib/registry-api';
import { discoverPublicationCandidates } from '../../src/lib/publication-suggest';
import { discoverCandidatesForRerun } from '../../src/lib/publication-candidate-rerun';
import {
    validateGroundTruth, evaluatePair, summarize, decide, classifyRegistry,
    type GroundTruthPair, type PairResult, type Summary,
} from './scoring';

interface Args {
    input: string;
    outDir: string;
    email?: string;
    /** eutils（esearch→esummary）の間隔。APIキー無しの上限3 req/s に合わせる */
    delayMs: number;
    /** 試験1件を処理し終えてから次の試験へ移るまでの待機 */
    pairDelayMs: number;
    limit?: number;
}

function parseArgs(argv: string[]): Args {
    const get = (name: string): string | undefined => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    return {
        input: get('input') ?? 'experiments/registry-linkage/data/ground-truth.json',
        outDir: get('out') ?? 'experiments/registry-linkage/results',
        email: get('email') ?? process.env.NCBI_EMAIL,
        delayMs: Number(get('delay-ms') ?? 350),
        pairDelayMs: Number(get('pair-delay-ms') ?? 1000),
        limit: get('limit') ? Number(get('limit')) : undefined,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 3つの外部APIへ実際に到達できるか先に確かめる。
 *
 * **これが無いと測定が静かに壊れる**。discoverPublicationCandidates() は各戦略の失敗を
 * 握りつぶして空配列を返す設計（一括ループを止めないための正しい挙動）なので、
 * ネットワークが遮断されていても例外は出ず「候補0件 ＝ 全部取りこぼし ＝ 取りこぼし率100%」
 * という、いかにも「LLM検索式が必要」に見える結果がそのまま出てしまう。
 */
async function preflight(): Promise<void> {
    const targets: Array<{ name: string; url: string }> = [
        { name: 'ClinicalTrials.gov API v2', url: 'https://clinicaltrials.gov/api/v2/studies/NCT01470703?format=json&fields=NCTId' },
        { name: 'PubMed E-utilities', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=NCT01470703%5Bsi%5D' },
        { name: 'Europe PMC', url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=ABSTRACT%3A%22NCT01470703%22&format=json&resultType=lite&pageSize=1' },
    ];

    const failures: string[] = [];
    for (const target of targets) {
        try {
            const resp = await fetch(target.url);
            if (!resp.ok) failures.push(`${target.name}: HTTP ${resp.status}`);
        } catch (e) {
            failures.push(`${target.name}: ${(e as Error).message}`);
        }
        await sleep(400);
    }

    if (failures.length > 0) {
        throw new Error(
            `外部APIへ到達できないため測定を中止します（この状態で走らせると、全戦略が空を返して\n` +
            `「取りこぼし率100%」という誤った結果が出ます）:\n  - ${failures.join('\n  - ')}`
        );
    }
}

async function measureOne(pair: GroundTruthPair, args: Args): Promise<PairResult> {
    const trialId = pair.trial_id.trim();
    // 製品側 extractTrialId() と同じ判定（NCT........ だけが 'nct'）
    const kind = /^NCT\d{8}$/.test(trialId.toUpperCase()) ? 'nct' as const : 'other' as const;

    const candidates = await discoverCandidatesForRerun(
        { id: trialId, kind },
        ctgPmids => discoverPublicationCandidates(
            {
                refId: `measure-${trialId}`,
                trialId,
                kind,
                ctgPmids,
                // **必ず空**。ここに正解論文が入っていると filterAlreadyImportedCandidates() が
                // 正解を候補から除外してしまい、当たっているのに「取りこぼし」と数えてしまう。
                existingRefs: [],
                email: args.email,
            },
            { delayMs: args.delayMs }
        ),
        fetchCtgStudy
    );

    return evaluatePair(pair, candidates);
}

function renderSummaryMarkdown(
    summary: Summary,
    results: PairResult[],
    rejected: Array<{ pair: GroundTruthPair; reason: string }>,
    args: Args,
    resultsJsonPath: string
): string {
    const verdict = decide(summary.overall.miss_rate);
    const verdictLabel: Record<string, string> = {
        not_worth_it: '取りこぼし10%未満 → Issue #119 はクローズ（not_planned）',
        low_priority: '取りこぼし10〜25% → 実装するが優先度は低のまま',
        build_it: '取りこぼし25%超 → 実装する',
    };
    const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

    const lines: string[] = [];
    lines.push('# #118 論文候補探索の取りこぼし率測定');
    lines.push('');
    lines.push(`実行日時: ${new Date().toISOString()} / Node ${process.version}`);
    lines.push('');
    lines.push('## 再現手順');
    lines.push('');
    lines.push('```bash');
    lines.push(`npx ts-node --project experiments/tsconfig.json experiments/registry-linkage/measure-recall.ts --input ${args.input}`);
    lines.push('```');
    lines.push('');
    lines.push('- スクリプト: [`experiments/registry-linkage/measure-recall.ts`](../measure-recall.ts) / [`scoring.ts`](../scoring.ts)');
    lines.push(`- 入力（正解セット）: [\`${args.input}\`](../../../${args.input})`);
    lines.push(`- 生の結果: [\`${resultsJsonPath}\`](./${resultsJsonPath.split('/').pop()})`);
    lines.push('');
    lines.push('## 結果');
    lines.push('');
    lines.push('| 層 | n | 発見 | 取りこぼし | 取りこぼし率 | 平均候補件数 | 当てた戦略の内訳 |');
    lines.push('|---|---:|---:|---:|---:|---:|---|');
    const strata = Object.entries(summary.by_stratum);
    for (const [stratum, s] of strata) {
        if (!s) continue;
        const foundBy = Object.entries(s.found_by).map(([k, v]) => `${k} ${v}`).join(' / ') || '—';
        lines.push(`| ${stratum} | ${s.n} | ${s.found} | ${s.missed} | ${pct(s.miss_rate)} | ${s.mean_candidate_count.toFixed(1)} | ${foundBy} |`);
    }
    const o = summary.overall;
    const overallFoundBy = Object.entries(o.found_by).map(([k, v]) => `${k} ${v}`).join(' / ') || '—';
    lines.push(`| **全体** | **${o.n}** | **${o.found}** | **${o.missed}** | **${pct(o.miss_rate)}** | **${o.mean_candidate_count.toFixed(1)}** | ${overallFoundBy} |`);
    lines.push('');
    lines.push(`**判定（全体）: ${verdictLabel[verdict]}**`);
    lines.push('');
    lines.push('層ごとに取りこぼし率が大きく違う場合は、全体の数字ではなく層ごとに判断すること');
    lines.push('（戦略1はNCTにしか効かないため、非NCT層の取りこぼしが大きくなるのは想定内。');
    lines.push('その場合「非NCTのみLLM検索式生成を使う」という結論があり得る）。');
    lines.push('');
    lines.push('## 取りこぼした試験');
    lines.push('');
    const missed = results.filter(r => !r.found);
    if (missed.length === 0) {
        lines.push('なし。');
    } else {
        lines.push('| 試験ID | 層 | 由来 | 候補件数 |');
        lines.push('|---|---|---|---:|');
        for (const r of missed) {
            lines.push(`| ${r.trial_id} | ${r.stratum} | ${r.provenance} | ${r.candidate_count} |`);
        }
        lines.push('');
        lines.push('**Issue #119 を実装する場合、LLM検索式の評価はこの一覧で行うこと**');
        lines.push('（既存3戦略が当てているペアで測っても、この issue の存在理由を検証したことにならない）。');
    }
    lines.push('');
    lines.push('## 除外したペア');
    lines.push('');
    if (rejected.length === 0) {
        lines.push('なし。');
    } else {
        lines.push('| 試験ID | 理由 |');
        lines.push('|---|---|');
        for (const r of rejected) {
            lines.push(`| ${r.pair.trial_id ?? '(空)'} | ${r.reason} |`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const raw = JSON.parse(readFileSync(args.input, 'utf-8')) as GroundTruthPair[];
    const { usable, rejected } = validateGroundTruth(raw);

    console.log(`正解セット: ${raw.length} 件 → 使用 ${usable.length} 件 / 除外 ${rejected.length} 件`);
    for (const r of rejected) {
        console.log(`  除外: ${r.pair.trial_id ?? '(空)'} — ${r.reason}`);
    }
    if (usable.length === 0) {
        throw new Error('使用できるペアが0件です。README.md の「正解セットの作り方」を参照してください。');
    }

    const targets = args.limit ? usable.slice(0, args.limit) : usable;

    console.log('外部APIへの到達を確認します...');
    await preflight();
    console.log('OK\n');

    const results: PairResult[] = [];
    for (const [i, pair] of targets.entries()) {
        const result = await measureOne(pair, args);
        results.push(result);
        const mark = result.found ? `✓ ${result.found_by} (rank ${result.rank})` : '✗ 取りこぼし';
        console.log(`[${i + 1}/${targets.length}] ${pair.trial_id} (${classifyRegistry(pair.trial_id)}) 候補${result.candidate_count}件 ${mark}`);
        if (i < targets.length - 1) await sleep(args.pairDelayMs);
    }

    const summary = summarize(results);
    mkdirSync(args.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = join(args.outDir, `results-${stamp}.json`);
    const mdPath = join(args.outDir, `report-${stamp}.md`);
    writeFileSync(jsonPath, JSON.stringify({ args, summary, results, rejected }, null, 2), 'utf-8');
    writeFileSync(mdPath, renderSummaryMarkdown(summary, results, rejected, args, jsonPath), 'utf-8');

    console.log(`\n全体の取りこぼし率: ${(summary.overall.miss_rate * 100).toFixed(1)}% (${summary.overall.missed}/${summary.overall.n})`);
    console.log(`判定: ${decide(summary.overall.miss_rate)}`);
    console.log(`\n結果: ${mdPath}`);
    console.log(`      ${jsonPath}`);
}

main().catch(e => {
    console.error(`\n${(e as Error).message}`);
    process.exit(1);
});
