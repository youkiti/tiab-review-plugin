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
import { basename, join, relative, resolve } from 'path';
import { fetchCtgStudy } from '../../src/lib/registry-api';
import { extractTrialId } from '../../src/lib/registry-record';
import { discoverPublicationCandidates } from '../../src/lib/publication-suggest';
import { discoverCandidatesForRerun } from '../../src/lib/publication-candidate-rerun';
import {
    validateGroundTruth, evaluatePair, summarize, decide, classifyRegistry, detectStrategyOutage,
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

/**
 * `--delay-ms` などの数値オプションを検証する。
 *
 * 素の `Number()` だと非数値で `NaN` になり、`setTimeout(fn, NaN)` は 0 と同じ挙動なので
 * **待機が黙って消える**。eutils はAPIキー無しで3 req/s が上限で、超過すると
 * NCBI 側から接続を絞られる（測定が途中から静かに失敗し、取りこぼし率が水増しされる）。
 * 落として気づかせる方が安全なので、ここで弾く。
 */
function parseNumber(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--${name} には0以上の数値を指定してください（受け取った値: ${JSON.stringify(raw)}）`);
    }
    return value;
}

function parseArgs(argv: string[]): Args {
    const get = (name: string): string | undefined => {
        const i = argv.indexOf(`--${name}`);
        const value = i >= 0 ? argv[i + 1] : undefined;
        // `--input --email x` のように値を書き忘れた場合、次のフラグを値として拾わない
        if (value !== undefined && value.startsWith('--')) {
            throw new Error(`--${name} の値がありません（次の引数 ${value} をフラグとして解釈しました）`);
        }
        return value;
    };
    const rawLimit = get('limit');
    const limit = rawLimit === undefined ? undefined : parseNumber('limit', rawLimit, 0);
    if (limit !== undefined && limit < 1) {
        throw new Error('--limit には1以上の整数を指定してください（全件流すならオプションごと省略）');
    }
    return {
        input: get('input') ?? 'experiments/registry-linkage/data/ground-truth.json',
        outDir: get('out') ?? 'experiments/registry-linkage/results',
        email: get('email') ?? process.env.NCBI_EMAIL,
        delayMs: parseNumber('delay-ms', get('delay-ms'), 350),
        pairDelayMs: parseNumber('pair-delay-ms', get('pair-delay-ms'), 1000),
        limit,
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
async function checkReachability(): Promise<string[]> {
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
    return failures;
}

async function preflight(): Promise<void> {
    const failures = await checkReachability();
    if (failures.length > 0) {
        throw new Error(
            `外部APIへ到達できないため測定を中止します（この状態で走らせると、全戦略が空を返して\n` +
            `「取りこぼし率100%」という誤った結果が出ます）:\n  - ${failures.join('\n  - ')}`
        );
    }
}

/**
 * 全ペアを流し終えたあとに、もう一度3ホストへ到達できるか確かめる。
 *
 * preflight() は開始時点しか見ていないので、**途中で eutils が 429 を返し始めた／回線が切れた
 * 場合は防げない**。discoverPublicationCandidates() は戦略ごとの失敗を握りつぶすため、
 * それ以降のペアは静かに全部「取りこぼし」に積まれ、preflight を入れた目的（取りこぼし率の
 * 水増しを防ぐ）がそのまま破られる。事後にもう一度確認して、駄目ならレポートへ警告を残す。
 */
async function postflight(): Promise<string[]> {
    return await checkReachability();
}


async function measureOne(pair: GroundTruthPair, args: Args): Promise<PairResult> {
    const trialId = pair.trial_id.trim();
    // 製品と同じ判定にするため、正規表現を書き写さず extractTrialId() をそのまま呼ぶ。
    // 以前はここで `.toUpperCase()` してから判定していたが、製品側（src/lib/registry-record.ts）は
    // 大文字化しないため、`nct01470703` のような小文字IDで判定が食い違い、測定だけ戦略1が走って
    // recall を過大評価する（＝「#119 は不要」側へ倒れる）。測定の目的は製品の再現なので、
    // 判定ロジックを二重に持たないことが正しい。
    const extracted = extractTrialId({ pmid: trialId });
    if (!extracted) throw new Error(`試験IDが空です: ${JSON.stringify(pair)}`);
    const kind = extracted.kind;

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

/**
 * レポート（`outDir` 配下）から見た相対リンクを作る。
 *
 * 以前は `../../../` や `resultsJsonPath.split('/').pop()` と決め打ちしていたため、
 * (1) `--out` を既定から変えると相対の深さが合わなくなり、
 * (2) Windows では `path.join()` が `\` を返すので `split('/')` が効かず
 *     `./experiments\registry-linkage\...` という壊れたリンクになっていた
 * （このリポジトリは bump / build:release が PowerShell 前提＝Windows 開発）。
 * `path.relative()` に任せ、区切りは Markdown 用に `/` へ正規化する。
 */
function linkFromOutDir(outDir: string, target: string): string {
    const rel = relative(resolve(outDir), resolve(target)).split(/[\\/]/).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function renderSummaryMarkdown(
    summary: Summary,
    results: PairResult[],
    rejected: Array<{ pair: GroundTruthPair; reason: string }>,
    args: Args,
    resultsJsonPath: string,
    warnings: string[]
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
    const selfDir = __dirname;
    lines.push(`- スクリプト: [\`measure-recall.ts\`](${linkFromOutDir(args.outDir, join(selfDir, 'measure-recall.ts'))})`
        + ` / [\`scoring.ts\`](${linkFromOutDir(args.outDir, join(selfDir, 'scoring.ts'))})`);
    lines.push(`- 入力（正解セット）: [\`${args.input}\`](${linkFromOutDir(args.outDir, args.input)})`);
    lines.push(`- 生の結果: [\`${basename(resultsJsonPath)}\`](${linkFromOutDir(args.outDir, resultsJsonPath)})`);
    lines.push('');
    if (warnings.length > 0) {
        lines.push('## ⚠ 警告');
        lines.push('');
        lines.push('**この結果は信用する前に下の警告を確認すること**（外部APIが落ちていると、');
        lines.push('全戦略が空を返して「取りこぼし率100%」という誤った結果がそのまま出る）。');
        lines.push('');
        for (const w of warnings) lines.push(`- ${w}`);
        lines.push('');
    }
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
        lines.push('| 試験ID | 層 | 由来 | 候補件数 | 戦略別の候補件数 |');
        lines.push('|---|---|---|---:|---|');
        for (const r of missed) {
            const byStrategy = Object.entries(r.count_by_strategy).map(([k, v]) => `${k} ${v}`).join(' / ') || '—';
            lines.push(`| ${r.trial_id} | ${r.stratum} | ${r.provenance} | ${r.candidate_count} | ${byStrategy} |`);
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

    let raw: GroundTruthPair[];
    try {
        raw = JSON.parse(readFileSync(args.input, 'utf-8')) as GroundTruthPair[];
    } catch (e) {
        throw new Error(
            `正解セットを読めませんでした: ${args.input}\n` +
            `  ${(e as Error).message}\n` +
            `正解セットはリポジトリに含めていません（人手で作るもの）。作り方は\n` +
            `experiments/registry-linkage/README.md「正解セットの作り方」、スキーマの実例は\n` +
            `experiments/registry-linkage/data/ground-truth.example.json を参照してください。`
        );
    }
    if (!Array.isArray(raw)) {
        throw new Error(`正解セットは配列である必要があります: ${args.input}`);
    }
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

    // preflight は開始時点しか見ていないので、走り切ったあとにもう一度確かめる。
    console.log('\n外部APIへの到達を再確認します...');
    const postFailures = await postflight();
    const warnings: string[] = [];
    for (const f of postFailures) {
        warnings.push(`**測定終了時に外部APIへ到達できなくなっていた: ${f}** — 途中から候補が取れず、` +
            `取りこぼし率が水増しされている可能性がある。この結果は破棄して測定し直すこと`);
    }
    for (const o of detectStrategyOutage(results)) {
        warnings.push(`戦略 \`${o.strategy}\` が末尾 ${o.trailing} 件で一度も候補を返していない` +
            `（最後に返したのは ${o.lastHitIndex + 1} 件目）。途中でAPIが落ちた可能性を確認すること`);
    }
    for (const w of warnings) console.warn(`⚠ ${w.replace(/\*\*/g, '')}`);
    if (postFailures.length === 0) console.log('OK');

    const summary = summarize(results);
    mkdirSync(args.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = join(args.outDir, `results-${stamp}.json`);
    const mdPath = join(args.outDir, `report-${stamp}.md`);
    // email は結果ファイルへ残さない。results/ は再現性のためコミットする運用なので、
    // そのまま書くと NCBI 申告用の個人メールアドレスが公開リポジトリに載る（AGENTS.md 9）。
    const { email: _email, ...argsForRecord } = args;
    writeFileSync(
        jsonPath,
        JSON.stringify(
            { args: { ...argsForRecord, email: args.email ? '(指定あり・記録しない)' : undefined }, warnings, summary, results, rejected },
            null,
            2
        ),
        'utf-8'
    );
    writeFileSync(mdPath, renderSummaryMarkdown(summary, results, rejected, args, jsonPath, warnings), 'utf-8');

    console.log(`\n全体の取りこぼし率: ${(summary.overall.miss_rate * 100).toFixed(1)}% (${summary.overall.missed}/${summary.overall.n})`);
    console.log(`判定: ${decide(summary.overall.miss_rate)}`);
    console.log(`\n結果: ${mdPath}`);
    console.log(`      ${jsonPath}`);
}

// import しただけで測定が走らないようにする（tests/tsconfig.json の型検査対象に含めているため、
// 直接実行されたときだけ main() を呼ぶ）。
if (require.main === module) {
    main().catch(e => {
        console.error(`\n${(e as Error).message}`);
        process.exit(1);
    });
}
