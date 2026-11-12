#!/usr/bin/env node
// AI 判定の評価結果を Zenodo に上げる公開物にまとめる（Issue #307）。
// 使い方と規則は scripts/zenodo-eval/README.md。Zenodo へは通信しない（zip を手元に作るだけ）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    buildLabelsCsv, buildManifestCsv, createZip, findLeftoverQuote, inferMeta, manifestRow,
    parseManifestCsv, readZip, sanitizeFile, sha256,
} from './core.mjs';
import { renderMethods, renderReadme } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 公開する評価のディレクトリ（experiments/ 直下）。新しいモデルの評価を README の表に足すときは、
 * 同じ変更でここにも足す。コミットに無いディレクトリ（結果がまだ無い anthropic-bench など）は飛ばす。
 * '' は experiments/ 直下のファイル（再帰しない）。
 */
export const INCLUDED_DIRS = [
    '', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-ga', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gpt-5.6', 'openrouter-bench', 'qwen3.8-27b',
    'typesafe-jev', 'typesafe-jev-fulltext-pdf', 'asreview', 'ensemble-flash-lite-luna', 'anthropic-bench',
    // 主表の B4 の元の判定結果を置く場所（git に無い間は飛ばす）。
    'gemini-3-flash-preview',
];

/** 評価でない結果の一覧（公開しない）。実行時の判断の記録として README に載せる。 */
export const EXCLUDED_DIRS = [
    'claude-subagent-workflow', 'claude-code-headless', 'help-consult', 'registry-linkage',
    'gemini-tier-detection', 'gemini-prompt-cache', 'logs',
];

/** experiments/ 直下のファイルのうち、結果ではなく文字化けした単発の試行の出力なので入れないもの。 */
export const EXCLUDED_ROOT_FILES = ['test_model_b_debug.txt', 'test_model_b_output.txt'];

/**
 * ラベルの表（id,label_included）を出すデータセット。SOURCES.md の「再配布の可否」が「可」のものだけ
 * REDISTRIBUTABLE_LABEL_DATASETS に名前を足す。確認できていないものは足さない。
 * file は scripts/asreview-baseline/datasets/ のファイル名の正規表現。
 */
export const LABEL_DATASETS = {
    depression: { file: /^depression_slim_labeled\.json$/, key: 'label_included' },
    wilson: { file: /^wilson_tiab_labeled\.json$/, key: 'label_final_included' },
    'cq1-5': { file: /^cq[1-5]_labeled\.json$/, key: 'label' },
    'cochrane-mendeley': { file: /^mendeley_.*\.json$/, key: 'label_included' },
};
export const REDISTRIBUTABLE_LABEL_DATASETS = ['depression', 'wilson', 'cq1-5', 'cochrane-mendeley'];

export const MAX_FILES = 100;
const DATASETS_DIR = 'scripts/asreview-baseline/datasets';

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function resolveCommit(ref) {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]).toString('utf8').trim();
}

/** コミット内のファイル一覧。recursive=false なら直下のファイルだけ。 */
export function listFiles(sha, dir, recursive) {
    const prefix = dir ? `experiments/${dir}/` : 'experiments/';
    const args = ['ls-tree', recursive ? '-r' : '', '-z', sha, prefix].filter(Boolean);
    // 出力は「mode type hash<TAB>name」。直下だけを見るときは下位のディレクトリ（tree）を除く。
    return git(args).toString('utf8').split('\0').filter(Boolean)
        .map((entry) => ({ type: entry.split(' ')[1], name: entry.slice(entry.indexOf('\t') + 1) }))
        .filter((entry) => entry.type === 'blob').map((entry) => entry.name);
}

export function readBlob(sha, file) {
    return git(['cat-file', 'blob', `${sha}:${file}`]);
}

function headings(markdown) {
    return markdown.split('\n').filter((line) => /^#{1,2}\s+\S/.test(line)).map((line) => line.replace(/^#+\s+/, '').trim());
}

function dateStamp(now) {
    const d = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}.${d(now.getMonth() + 1)}.${d(now.getDate())}`;
}

/** 1つのディレクトリの zip の中身と manifest の行を作る。 */
export function buildDirectory(sha, dir) {
    let files = listFiles(sha, dir, dir !== '');
    if (dir === '') files = files.filter((f) => !EXCLUDED_ROOT_FILES.includes(f.split('/').pop()));
    if (!files.length) return null;
    const zipName = `${dir || 'experiments-root'}.zip`;
    const entries = [];
    const rows = [];
    const leftovers = [];
    const models = new Set();
    const datasets = new Set();
    const dates = new Set();
    let resultFiles = 0;
    let reportPath = null;
    let reportText = '';
    for (const file of files) {
        const original = readBlob(sha, file);
        const data = sanitizeFile(file, original);
        const leftover = findLeftoverQuote(file, data);
        if (leftover) leftovers.push(leftover);
        const meta = inferMeta(file, data);
        entries.push({ name: file, data });
        rows.push(manifestRow(zipName, file, data, meta));
        if (file.includes('/results/')) {
            resultFiles++;
            if (meta.model) models.add(meta.model);
            if (meta.dataset) datasets.add(meta.dataset);
            if (meta.run_date) dates.add(meta.run_date);
        }
        if (file === `experiments/${dir}/report.md` || (dir === '' && file === 'experiments/report.md')) {
            reportPath = file;
            reportText = data.toString('utf8');
        }
    }
    return {
        dir, zipName, entries, rows, leftovers, resultFiles, reportPath,
        headings: headings(reportText),
        models: [...models].sort(), datasets: [...datasets].sort(), dates: [...dates].sort(),
        zip: createZip(entries),
    };
}

/** ラベルの JSON（配列、または records が配列のオブジェクト）からレコードの配列を取り出す。 */
export function labelRecords(parsed, file) {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
        return parsed.records;
    }
    throw new Error(`${file}: ラベルのデータは配列または records が配列のオブジェクトである必要があります`);
}

/** 再配布できるデータセットのラベルの表を作る。 */
export function buildLabels(sha, allowed = REDISTRIBUTABLE_LABEL_DATASETS) {
    const names = new Map();
    const files = git(['ls-tree', '-z', '--name-only', sha, `${DATASETS_DIR}/`]).toString('utf8').split('\0').filter(Boolean);
    for (const name of allowed) {
        const spec = LABEL_DATASETS[name];
        if (!spec) throw new Error(`LABEL_DATASETS に無いデータセットです: ${name}`);
        for (const file of files) {
            const base = file.split('/').pop();
            if (!spec.file.test(base)) continue;
            const parsed = JSON.parse(readBlob(sha, file).toString('utf8'));
            const records = labelRecords(parsed, file);
            const outName = name === 'depression' || name === 'wilson'
                ? name : base.replace(/\.json$/, '').replace(/_labeled$/, '').replace(/_data_cleaned$/, '');
            names.set(`labels/${outName}.csv`, Buffer.from(buildLabelsCsv(records, spec.key), 'utf8'));
        }
    }
    return names;
}

export function parseArgs(argv) {
    const args = { commit: 'HEAD', verify: false, out: null, date: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--commit') args.commit = argv[++i];
        else if (argv[i] === '--verify') args.verify = true;
        else if (argv[i] === '--out') args.out = argv[++i];
        else if (argv[i] === '--date') args.date = argv[++i];
        else throw new Error(`知らない引数です: ${argv[i]}`);
    }
    return args;
}

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** 出力先を読み直し、manifest の sha256・件数と zip の中身が一致することと quote が無いことを確かめる。 */
export function verifyOutput(outDir) {
    const problems = [];
    const rows = parseManifestCsv(readFileSync(path.join(outDir, 'manifest.csv'), 'utf8'));
    const expected = new Map();
    for (const [zip, file, bytes, hash] of rows) expected.set(`${zip}\0${file}`, { bytes: Number(bytes), hash });
    const seen = new Set();
    const check = (zip, name, data) => {
        const key = `${zip}\0${name}`;
        seen.add(key);
        const row = expected.get(key);
        if (!row) problems.push(`manifest に無いファイル: ${zip} ${name}`);
        else if (row.hash !== sha256(data) || row.bytes !== data.length) problems.push(`sha256 または容量が一致しません: ${zip} ${name}`);
        const leftover = findLeftoverQuote(name, data);
        if (leftover) problems.push(leftover);
    };
    let fileCount = 0;
    for (const file of walk(outDir)) {
        const rel = path.relative(outDir, file).split(path.sep).join('/');
        if (rel === 'manifest.csv') continue;
        fileCount++;
        const bytes = readFileSync(file);
        if (rel.endsWith('.zip')) {
            for (const entry of readZip(bytes)) check(rel, entry.name, entry.data);
        } else {
            check('', rel, bytes);
            if (rel.startsWith('labels/') && !/^id,label_included\n/.test(bytes.toString('utf8'))) problems.push(`${rel}: 列が id,label_included ではありません`);
        }
    }
    for (const key of expected.keys()) if (!seen.has(key)) problems.push(`manifest にあるのに出力に無い: ${key.replace('\0', ' ')}`);
    if (fileCount + 1 > MAX_FILES) problems.push(`ファイル数が ${MAX_FILES} を超えています: ${fileCount + 1}`);
    return { problems, fileCount: fileCount + 1 };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const date = args.date ?? dateStamp(new Date());
    const outDir = path.resolve(ROOT, args.out ?? path.join('.tmp', 'zenodo-eval', date));
    if (args.verify) {
        const { problems, fileCount } = verifyOutput(outDir);
        if (problems.length) {
            console.error(problems.join('\n'));
            process.exit(1);
        }
        console.log(`検査に通りました: ${outDir}（${fileCount} ファイル）`);
        return;
    }
    const sha = resolveCommit(args.commit);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(path.join(outDir, 'labels'), { recursive: true });

    const built = [];
    const skipped = [];
    for (const dir of INCLUDED_DIRS) {
        const result = buildDirectory(sha, dir);
        if (!result) {
            skipped.push(dir);
            console.log(`飛ばしました（コミットに無い）: experiments/${dir}/`);
            continue;
        }
        built.push(result);
    }
    const leftovers = built.flatMap((b) => b.leftovers);
    if (leftovers.length) {
        console.error(leftovers.join('\n'));
        console.error('quote が残っているので中止します。');
        process.exit(1);
    }

    const labels = buildLabels(sha);
    let sources;
    try {
        sources = readBlob(sha, 'scripts/zenodo-eval/SOURCES.md');
    } catch {
        // SOURCES.md がまだコミットに無いときだけ、作業ツリーのものを使う（公開物はマージ後のコミットで作ること）。
        console.warn('警告: コミットに scripts/zenodo-eval/SOURCES.md が無いので、作業ツリーのものを使います。');
        sources = readFileSync(path.join(ROOT, 'scripts/zenodo-eval/SOURCES.md'));
    }
    const ctx = {
        sha, date, dirs: built.map((b) => b.dir || 'experiments-root'), skipped: EXCLUDED_DIRS,
        labelDatasets: REDISTRIBUTABLE_LABEL_DATASETS,
        b4Included: built.some((b) => b.dir === 'gemini-3-flash-preview'),
    };
    const top = new Map([
        ['README.md', Buffer.from(renderReadme(ctx), 'utf8')],
        ['METHODS.md', Buffer.from(renderMethods({
            sha, date,
            entries: built.map((b) => ({
                dir: b.dir || 'experiments-root', reportPath: b.reportPath, headings: b.headings, files: b.entries.length,
                resultFiles: b.resultFiles, models: b.models, datasets: b.datasets, dates: b.dates,
            })),
        }), 'utf8')],
        ['SOURCES.md', sources],
        ...labels,
    ]);

    const rows = [];
    for (const b of built) {
        writeFileSync(path.join(outDir, b.zipName), b.zip);
        rows.push(...b.rows);
    }
    for (const [name, data] of top) {
        mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true });
        writeFileSync(path.join(outDir, name), data);
        rows.push(manifestRow('', name, data, { model: '', dataset: '', run_date: '' }));
    }
    writeFileSync(path.join(outDir, 'manifest.csv'), buildManifestCsv(rows));

    const { problems, fileCount } = verifyOutput(outDir);
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    let total = 0;
    console.log(`コミット ${sha}、出力先 ${outDir}`);
    for (const file of readdirSync(outDir).sort()) {
        const size = statSync(path.join(outDir, file)).size;
        if (statSync(path.join(outDir, file)).isFile()) {
            total += size;
            console.log(`  ${file}\t${size.toLocaleString('en-US')} bytes`);
        }
    }
    for (const file of walk(path.join(outDir, 'labels'))) total += statSync(file).size;
    console.log(`合計 ${total.toLocaleString('en-US')} bytes、ファイル数 ${fileCount}（上限 ${MAX_FILES}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
