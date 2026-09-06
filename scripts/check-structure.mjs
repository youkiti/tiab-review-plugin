#!/usr/bin/env node
// Issue #157: 相対依存・循環・ファイル規模の回帰を既存の基準値と比較する。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = /^src\/(sidepanel|fulltext|popup|webapp|background|demo)\//;
// 型・既定値の置き場所を増やす場合、この一覧にも追加する。
export const FOUNDATION_MODULES = new Set([
    'src/lib/types.ts', 'src/lib/assignment-set.ts', 'src/lib/sheets/schema.ts', 'src/lib/sheets/config-schema.ts',
    'src/lib/ml/types.ts', 'src/lib/ml/cmh-defaults.ts', 'src/platform/types.ts',
]);
const COMMUNICATION = /^src\/(platform\/|lib\/(sheets-api\.ts$|sheets\/(?!schema\.ts$|config-schema\.ts$|codecs\.ts$)|providers\/|.*(?:-api|-provider|-processor)\.ts$|storage\.ts$|ml\/worker-client\.ts$))/;

/** 正規表現で字句を取り、コメント・文字列中の import の見かけを除外する。 */
export function extractImports(source) {
    const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
        .map((match) => match[0]).filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
    const result = new Set();
    const add = (token) => {
        if (/^['"]\./.test(token || '')) result.add(token.slice(1, -1));
    };
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== 'import' && tokens[i] !== 'export') continue;
        if (tokens[i - 1] === '.') continue;
        if (tokens[i] === 'import' && tokens[i + 1] === '(') {
            add(tokens[i + 2]);
        } else if (/^['"]/.test(tokens[i + 1] || '')) {
            add(tokens[i + 1]);
        } else {
            for (let j = i + 1; j < tokens.length; j++) {
                if ([';', 'import', 'export', '=', '('].includes(tokens[j])) break;
                if (tokens[j] === 'from' && /^['"]/.test(tokens[j + 1] || '')) {
                    add(tokens[j + 1]);
                    break;
                }
            }
        }
    }
    return [...result].sort();
}

export function buildGraph(sources) {
    const graph = new Map();
    for (const [file, source] of Object.entries(sources).sort()) {
        if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
        const targets = new Set();
        for (const specifier of extractImports(source)) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
            const candidates = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')];
            const target = candidates.find((candidate) => Object.hasOwn(sources, candidate) && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts'));
            if (target) targets.add(target);
        }
        graph.set(file, [...targets].sort());
    }
    return graph;
}

export function classifyViolation(from, to) {
    if (from.startsWith('src/lib/') && UI.test(to)) return 'lib-to-ui';
    if (from.startsWith('src/platform/') && UI.test(to)) return 'platform-to-ui';
    if (from.startsWith('src/platform/') && to.startsWith('src/lib/')) return 'platform-to-lib';
    if (FOUNDATION_MODULES.has(from) && COMMUNICATION.test(to) && to !== 'src/platform/types.ts') return 'foundation-to-communication';
    return null;
}

/** Tarjan の強連結成分。型のみ・動的 import も構造上の依存として含める。 */
export function findCycles(graph) {
    let nextIndex = 0;
    const indices = new Map();
    const lows = new Map();
    const stack = [];
    const active = new Set();
    const cycles = [];
    function visit(file) {
        indices.set(file, nextIndex);
        lows.set(file, nextIndex++);
        stack.push(file);
        active.add(file);
        for (const target of graph.get(file) || []) {
            if (!indices.has(target)) {
                visit(target);
                lows.set(file, Math.min(lows.get(file), lows.get(target)));
            } else if (active.has(target)) {
                lows.set(file, Math.min(lows.get(file), indices.get(target)));
            }
        }
        if (lows.get(file) !== indices.get(file)) return;
        const files = [];
        let member;
        do {
            member = stack.pop();
            active.delete(member);
            files.push(member);
        } while (member !== file);
        files.sort();
        if (files.length === 1 && !(graph.get(file) || []).includes(file)) return;
        const members = new Set(files);
        const edges = files.flatMap((from) => (graph.get(from) || []).filter((to) => members.has(to)).map((to) => ({ from, to })));
        cycles.push({ files, edges });
    }
    for (const file of [...graph.keys()].sort()) if (!indices.has(file)) visit(file);
    return cycles.sort((a, b) => a.files[0].localeCompare(b.files[0], 'en'));
}

export function analyzeSources(sources) {
    const graph = buildGraph(sources);
    const violations = [...graph].flatMap(([from, targets]) => targets.flatMap((to) => {
        const rule = classifyViolation(from, to);
        return rule ? [{ rule, from, to }] : [];
    }));
    const largeFiles = Object.entries(sources).filter(([file]) => /\.(ts|css|html)$/.test(file) && !file.endsWith('.d.ts'))
        .map(([file, source]) => ({ file, lines: source === '' ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0) }))
        .filter(({ lines }) => lines > 800).sort((a, b) => a.file.localeCompare(b.file, 'en'));
    return { version: 1, violations, cycles: findCycles(graph), largeFiles };
}

const edgeKey = ({ from, to }) => `${from} → ${to}`;
const violationKey = (violation) => `${violation.rule}: ${edgeKey(violation)}`;

export function compareBaseline(current, baseline) {
    if (baseline.version !== 1 || !Array.isArray(baseline.violations) || !Array.isArray(baseline.cycles) || !Array.isArray(baseline.largeFiles)) {
        throw new Error('構造基準値の形式が不正です');
    }
    const knownViolations = new Set(baseline.violations.map(violationKey));
    // SCC の構成員だけで許容すると、既存 SCC 内の新しい循環を見逃すため辺も比較する。
    const knownEdges = new Set(baseline.cycles.flatMap((cycle) => cycle.edges.map(edgeKey)));
    const knownLarge = new Map(baseline.largeFiles.map(({ file, lines }) => [file, lines]));
    const violations = current.violations.filter((entry) => !knownViolations.has(violationKey(entry)));
    const cycles = current.cycles.filter((cycle) => cycle.edges.some((edge) => !knownEdges.has(edgeKey(edge))));
    const largeFiles = current.largeFiles.filter(({ file }) => !knownLarge.has(file));
    const currentViolations = new Set(current.violations.map(violationKey));
    const currentEdges = new Set(current.cycles.flatMap((cycle) => cycle.edges.map(edgeKey)));
    const currentLarge = new Map(current.largeFiles.map(({ file, lines }) => [file, lines]));
    const improved = [...knownViolations].some((entry) => !currentViolations.has(entry)) ||
        [...knownEdges].some((entry) => !currentEdges.has(entry)) ||
        [...knownLarge].some(([file, lines]) => !currentLarge.has(file) || currentLarge.get(file) < lines);
    return { violations, cycles, largeFiles, improved, failed: violations.length + cycles.length + largeFiles.length > 0 };
}

export function readSources(root) {
    const sources = {};
    function walk(directory) {
        for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const file = `${directory}/${entry.name}`;
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && /\.(ts|css|html)$/.test(file) && !file.endsWith('.d.ts')) sources[file] = readFileSync(path.join(root, file), 'utf8');
        }
    }
    walk('src');
    return sources;
}

export function main(args, root = ROOT) {
    if (args.some((arg) => arg !== '--update-baseline')) throw new Error('使用方法: node scripts/check-structure.mjs [--update-baseline]');
    const current = analyzeSources(readSources(root));
    const baselinePath = path.join(root, 'scripts/structure-baseline.json');
    if (args.includes('--update-baseline')) {
        writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
        console.log('構造基準値を更新しました。変更理由をコミットに記録してください。');
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const result = compareBaseline(current, baseline);
    console.log(`構造検査: 依存方向違反 ${current.violations.length}件、循環 ${current.cycles.length}件、800行超 ${current.largeFiles.length}件`);
    for (const violation of current.violations) console.log(`${result.violations.includes(violation) ? '新規違反' : '既存違反（改善対象）'}: ${violationKey(violation)}`);
    for (const cycle of current.cycles) {
        console.log(`${result.cycles.includes(cycle) ? '新規循環' : '既存循環（改善対象）'}: ${cycle.files.join(', ')}`);
        for (const edge of cycle.edges) console.log(`  ${edgeKey(edge)}`);
    }
    for (const { file, lines } of current.largeFiles) {
        const previous = baseline.largeFiles.find((entry) => entry.file === file)?.lines;
        console.log(`${previous === undefined ? '新規800行超（設計レビューが必要）' : '既存大規模ファイル（改善対象）'}: ${file} ${lines}行（増減 ${previous === undefined ? '未登録' : `${lines - previous >= 0 ? '+' : ''}${lines - previous}`}）`);
    }
    if (result.improved) console.log('改善を検出しました。基準値を更新できます。');
    console.log(result.failed ? '構造検査 FAIL: 新規の問題を解消するか、設計レビューで基準値変更を判断してください。' : '構造検査 PASS');
    return result.failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`構造検査エラー: ${error.message}`);
        process.exitCode = 1;
    }
}
