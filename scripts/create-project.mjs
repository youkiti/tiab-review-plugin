#!/usr/bin/env node
// プロジェクト作成 CLI をコンパイルして実行する。
// 使い方: node scripts/create-project.mjs --title ... --ris ... [--share ...] [--dry-run]
// 毎回 .tmp/cli を消し、tsc でコンパイルしてから実行する。
// --dry-run と --help では .env を読み込まない。

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'src/cli/tsconfig.json');

function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) {
        throw new Error('CLI の子プロセスを開始できませんでした。');
    }
    return result.status ?? 1;
}

function main() {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const configured = config.compilerOptions?.outDir;
    if (typeof configured !== 'string' || !configured.trim()) {
        throw new Error('CLI の出力先が未設定です。');
    }
    const output = path.resolve(path.dirname(configPath), configured);
    const relative = path.relative(path.join(root, '.tmp'), output);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('削除対象がリポジトリの .tmp 配下ではありません。');
    }
    rmSync(output, { recursive: true, force: true });
    const compiled = run([path.join(root, 'node_modules/typescript/bin/tsc'), '--project', configPath]);
    if (compiled !== 0) {
        return compiled;
    }
    const argv = process.argv.slice(2);
    // Issue #245: 非通信経路では .env も資格情報も読み込まない。
    if (!argv.some(arg => ['--dry-run', '--help', '-h'].includes(arg))) {
        const envPath = path.join(root, '.env');
        if (existsSync(envPath)) {
            dotenv.config({ path: envPath, override: false, quiet: true });
        }
    }
    process.env.TIAB_CLI_VERSION = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return run([path.join(output, 'src/cli/bin.js'), ...argv]);
}

try {
    process.exitCode = main();
} catch (error) {
    console.error('CLI の準備に失敗しました。ビルド環境とファイル権限を確認してください。');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
