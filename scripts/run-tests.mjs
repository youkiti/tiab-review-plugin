#!/usr/bin/env node
// テスト実行ラッパー（Issue #162）
//
// `npm test` の実体。従来の `tsc --project tests/tsconfig.json && node --test .tmp/tests/tests/*.test.js`
// は出力先 `.tmp/tests` を掃除しないため、削除済みブランチのテストがコンパイル済みのまま残っていると
// 件数が水増しされた（AGENTS.md「テスト・作業ツリーの落とし穴」の実例: 392 件と表示されたが真値は 379 件）。
// このラッパーは実行ごとに次を行う。
//   1. tests/tsconfig.json の outDir（専用出力先）を全消去する
//   2. tsc でテストと依存ソースをコンパイルする
//   3. **現在 tests/ に存在する** *.test.ts に対応する .js だけを node --test に渡す
//      （glob で出力先を拾わないので、残骸があっても実行対象にならない）
//
// 使い方:
//   npm test                       # 全件
//   npm test -- doi fulltext-pool  # ファイル名（.test.ts を除いた部分）の部分一致で絞り込む
//   npm test -- tests/doi.test.ts  # パス指定でも可
//   npm test -- --help
//
// 絞り込み時もコンパイルは全件行う（tsc はプロジェクト単位でしか動かないため）。

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const TESTS_TSCONFIG = path.join(TESTS_DIR, 'tsconfig.json');
// npm.cmd 経由の spawn は Node 22 + Windows で EINVAL になるため、tsc は JS エントリを
// 現在の node（process.execPath）で直接起動する。
const TSC_BIN = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function printHelp() {
    console.log(`テスト実行ラッパー（Issue #162）

使い方:
  npm test                       全テストを実行
  npm test -- <pattern> ...      tests/<name>.test.ts の <name> に部分一致するものだけ実行
  npm test -- tests/doi.test.ts  パス指定（tests/ 直下の .test.ts）でも可
  npm test -- --help             このヘルプを表示

毎回 tests/tsconfig.json の outDir を全消去してからコンパイルし、現在 tests/ に存在する
*.test.ts に対応する .js だけを node --test に渡す（削除済みテストの残骸を拾わない）。
`);
}

/**
 * tests/tsconfig.json から outDir を読み、tests/ 基準で絶対パスに解決する。
 * 全消去する対象なので、リポジトリ内の `.tmp/` 配下でなければ中止する（安全弁）。
 */
function resolveOutDir() {
    const tsconfig = JSON.parse(readFileSync(TESTS_TSCONFIG, 'utf8'));
    const outDir = tsconfig?.compilerOptions?.outDir;
    if (typeof outDir !== 'string' || !outDir.trim()) {
        throw new Error(`tests/tsconfig.json に compilerOptions.outDir がありません: ${TESTS_TSCONFIG}`);
    }
    const resolved = path.resolve(TESTS_DIR, outDir);
    const tmpRoot = path.join(REPO_ROOT, '.tmp');
    const rel = path.relative(tmpRoot, resolved);
    const insideTmp = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!insideTmp) {
        throw new Error(
            `tests/tsconfig.json の outDir がリポジトリ内の .tmp/ 配下を指していません: ${resolved}\n` +
            'このスクリプトは outDir を全消去するため、.tmp/ の外を指す設定では実行しません。'
        );
    }
    return resolved;
}

/** 現在 tests/ 直下に存在する *.test.ts のベース名（.test.ts を除く）を返す。 */
function listTestNames() {
    return readdirSync(TESTS_DIR)
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => name.slice(0, -'.test.ts'.length))
        .sort();
}

/**
 * 引数のパターンでテスト名を絞り込む。パターンは `tests/foo.test.ts`・`foo.test.ts`・`foo`
 * のいずれの形でも受け付け、ベース名への部分一致で判定する。
 */
function selectTestNames(allNames, patterns) {
    if (patterns.length === 0) return allNames;
    const normalized = patterns.map((p) => {
        let s = p.replace(/\\/g, '/');
        if (s.startsWith('tests/')) s = s.slice('tests/'.length);
        if (s.endsWith('.test.ts')) s = s.slice(0, -'.test.ts'.length);
        if (s.endsWith('.test.js')) s = s.slice(0, -'.test.js'.length);
        return s;
    });
    const unmatched = normalized.filter((p) => !allNames.some((name) => name.includes(p)));
    if (unmatched.length > 0) {
        throw new Error(`指定パターンに一致するテストが tests/ にありません: ${unmatched.join(', ')}`);
    }
    return allNames.filter((name) => normalized.some((p) => name.includes(p)));
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return 0;
    }
    const patterns = argv.filter((a) => !a.startsWith('--'));
    const unknownFlags = argv.filter((a) => a.startsWith('--'));
    if (unknownFlags.length > 0) {
        console.error(`[run-tests] 不明なオプション: ${unknownFlags.join(' ')}（--help を参照）`);
        return 2;
    }

    const allNames = listTestNames();
    const selected = selectTestNames(allNames, patterns);
    if (selected.length === 0) {
        console.error('[run-tests] tests/ に *.test.ts が 1 件もありません。');
        return 2;
    }

    const outDir = resolveOutDir();
    rmSync(outDir, { recursive: true, force: true });
    console.log(`[run-tests] 出力先を清掃: ${path.relative(REPO_ROOT, outDir)}`);

    const tscStatus = run(process.execPath, [TSC_BIN, '--project', TESTS_TSCONFIG]);
    if (tscStatus !== 0) return tscStatus;

    // rootDir が `..`（リポジトリルート）なので、tests/foo.test.ts は <outDir>/tests/foo.test.js に出る。
    const compiled = selected.map((name) => path.join(outDir, 'tests', `${name}.test.js`));
    const missing = compiled.filter((file) => !existsSync(file));
    if (missing.length > 0) {
        console.error(
            '[run-tests] コンパイル済みファイルが見つかりません（tests/tsconfig.json の rootDir/outDir を確認）:\n' +
            missing.map((file) => `  ${path.relative(REPO_ROOT, file)}`).join('\n')
        );
        return 2;
    }

    console.log(`[run-tests] ${selected.length} / ${allNames.length} テストファイルを実行`);
    return run(process.execPath, ['--test', ...compiled]);
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    console.error(`[run-tests] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
