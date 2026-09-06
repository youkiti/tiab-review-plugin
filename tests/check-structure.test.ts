import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CommonJSへの変換で import() が require() にならないよう、Node自身のESMローダーで読む。
const loadModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const modulePromise = loadModule(pathToFileURL(path.resolve('scripts/check-structure.mjs')).href);

test('相対import・再export・型・動的importを抽出し、コメントと文字列を無視する', async () => {
    const { extractImports } = await modulePromise;
    assert.deepEqual(extractImports(`
        import { a } from './a';
        import type { B } from "./b";
        export { c } from './c';
        export type { D } from './d';
        export * from './e';
        const lazy = import('./lazy');
        import './side-effect';
        import /* コメント */ { x } from './commented';
        import external from 'package';
        // import { fake } from './fake';
        /* export * from './fake-block'; */
        const text = "import('./fake-string')";
        const template = \`import('./fake-template')\`;
    `), ['./a', './b', './c', './commented', './d', './e', './lazy', './side-effect']);
});

test('依存グラフはts・index.tsを解決し、重複と宣言・バックアップを除外する', async () => {
    const { buildGraph } = await modulePromise;
    const graph = buildGraph({
        'src/lib/a.ts': "import './b'; export * from './b'; import('./folder'); import './c.ts'; import './d.js'; import './types.d.ts'; import './old.ts.bak';",
        'src/lib/b.ts': '', 'src/lib/folder/index.ts': '', 'src/lib/c.ts': '', 'src/lib/d.ts': '',
        'src/lib/types.d.ts': '', 'src/lib/old.ts.bak': '',
    });
    assert.deepEqual(graph.get('src/lib/a.ts'), ['src/lib/b.ts', 'src/lib/c.ts', 'src/lib/d.ts', 'src/lib/folder/index.ts']);
    assert.equal(graph.has('src/lib/types.d.ts'), false);
    assert.equal(graph.has('src/lib/old.ts.bak'), false);
});

test('画面・ドメイン・platformと型・既定値の依存方向を判定する', async () => {
    const { classifyViolation } = await modulePromise;
    for (const target of ['sidepanel/store/state', 'fulltext/view', 'popup/view', 'webapp/view', 'background/main', 'demo/constants']) {
        assert.equal(classifyViolation('src/lib/a.ts', `src/${target}.ts`), 'lib-to-ui');
        assert.equal(classifyViolation('src/platform/a.ts', `src/${target}.ts`), 'platform-to-ui');
    }
    assert.equal(classifyViolation('src/platform/a.ts', 'src/lib/a.ts'), 'platform-to-lib');
    for (const source of ['src/lib/types.ts', 'src/lib/sheets/schema.ts', 'src/lib/sheets/config-schema.ts', 'src/lib/ml/cmh-defaults.ts']) {
        assert.equal(classifyViolation(source, 'src/lib/sheets/transport.ts'), 'foundation-to-communication');
        assert.equal(classifyViolation(source, 'src/lib/drive-api.ts'), 'foundation-to-communication');
        assert.equal(classifyViolation(source, 'src/platform/index.ts'), 'foundation-to-communication');
        assert.equal(classifyViolation(source, 'src/platform/types.ts'), null);
    }
    assert.equal(classifyViolation('src/sidepanel/ui.ts', 'src/lib/a.ts'), null);
    assert.equal(classifyViolation('src/lib/a.ts', 'src/platform/index.ts'), null);
});

test('Tarjanは独立した循環・自己参照を検出し、非循環の頂点を含めない', async () => {
    const { findCycles } = await modulePromise;
    const cycles = findCycles(new Map([
        ['a', ['b']], ['b', ['a', 'c']], ['c', []], ['d', ['d']], ['e', ['f']], ['f', ['e']],
    ]));
    assert.deepEqual(cycles.map((cycle: any) => cycle.files), [['a', 'b'], ['d'], ['e', 'f']]);
    assert.deepEqual(cycles[0].edges, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
});

test('基準値は既存だけを許容し、同一SCC内の新しい辺も拒否する', async () => {
    const { analyzeSources, compareBaseline } = await modulePromise;
    const sources = {
        'src/lib/a.ts': "import './b';",
        'src/lib/b.ts': "import './c';",
        'src/lib/c.ts': "import './a';",
    };
    const baseline = analyzeSources(sources);
    assert.equal(compareBaseline(baseline, baseline).failed, false);
    const changed = analyzeSources({ ...sources, 'src/lib/a.ts': "import './b'; import './c';" });
    assert.equal(compareBaseline(changed, baseline).cycles.length, 1);
    const improved = compareBaseline(analyzeSources({ ...sources, 'src/lib/c.ts': '' }), baseline);
    assert.equal(improved.failed, false);
    assert.equal(improved.improved, true);
});

test('規模の800行境界・既存増加・改善を区別する', async () => {
    const { analyzeSources, compareBaseline } = await modulePromise;
    const baseline = analyzeSources({ 'src/old.ts': '// 行\n'.repeat(801) });
    const current = analyzeSources({
        'src/old.ts': '// 行\n'.repeat(820),
        'src/new.css': '/* 行 */\n'.repeat(801),
        'src/limit.html': '<!-- 行 -->\n'.repeat(800),
    });
    const result = compareBaseline(current, baseline);
    assert.deepEqual(result.largeFiles, [{ file: 'src/new.css', lines: 801 }]);
    assert.equal(result.failed, true);
    assert.equal(result.improved, false);
    assert.equal(compareBaseline(analyzeSources({}), baseline).improved, true);
});

test('CLIは新規のUI参照・循環・801行ファイルを拒否し、既存増加は表示する', async () => {
    const { main } = await modulePromise;
    const root = mkdtempSync(path.resolve('.tmp/structure-test-'));
    try {
        for (const directory of ['src/lib', 'src/sidepanel', 'scripts']) mkdirSync(path.join(root, directory), { recursive: true });
        const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
        write('src/lib/old.ts', '// 行\n'.repeat(801));
        write('src/sidepanel/dom.ts', 'export const dom = {};');
        assert.equal(main(['--update-baseline'], root), 0);
        const run = () => {
            const lines: string[] = [];
            const originalLog = console.log;
            console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
            try {
                return { status: main([], root), stdout: lines.join('\n') };
            } finally {
                console.log = originalLog;
            }
        };
        write('src/lib/old.ts', '// 行\n'.repeat(805));
        assert.equal(run().status, 0);
        assert.match(run().stdout, /増減 \+4/);
        write('src/lib/new.ts', "import { dom } from '../sidepanel/dom';");
        assert.equal(run().status, 1);
        assert.match(run().stdout, /新規違反.*src\/lib\/new.ts.*src\/sidepanel\/dom.ts/);
        write('src/lib/new.ts', "import './cycle';");
        write('src/lib/cycle.ts', "import './new';");
        assert.equal(run().status, 1);
        assert.match(run().stdout, /新規循環/);
        write('src/lib/cycle.ts', '');
        write('src/lib/new.ts', '// 行\n'.repeat(801));
        assert.equal(run().status, 1);
        assert.match(run().stdout, /新規800行超/);
        write('src/lib/new.ts', '');
        assert.equal(run().status, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
