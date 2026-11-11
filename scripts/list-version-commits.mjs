// main 上で package.json の version が変わったコミットを、版ごとに Markdown の表で出力する。
// 「その版が main に初めて入ったコミット」を古い順に並べる。KNOWN_ISSUES.md の付録に貼る。
// Node 標準モジュールのみ。実行: node scripts/list-version-commits.mjs
import { execFileSync } from 'node:child_process';

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    console.error('浅い clone では一覧が欠けます。`git fetch --unshallow` してから実行してください。');
    process.exit(1);
}

const commits = git(['rev-list', '--reverse', '--first-parent', 'main', '--', 'package.json'])
    .split('\n')
    .filter(Boolean);

const rows = [];
let previous = null;
for (const commit of commits) {
    let version;
    try {
        version = JSON.parse(git(['show', `${commit}:package.json`])).version;
    } catch {
        // package.json が読めない、または JSON として壊れているコミットは飛ばす
        continue;
    }
    if (typeof version !== 'string' || version === previous) continue;
    previous = version;
    const date = git(['show', '-s', '--format=%cs', commit]).trim();
    rows.push(`| v${version} | ${commit.slice(0, 7)} | ${date} |`);
}

console.log('| 版 | コミット | 日付 |');
console.log('| --- | --- | --- |');
for (const row of rows) console.log(row);
