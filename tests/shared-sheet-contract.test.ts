import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CONFIG_SHEET,
    DECISIONS_HEADERS,
    DECISIONS_SHEET,
    LLM_EXECUTIONS_HEADERS,
    LLM_EXECUTIONS_SHEET,
    LLM_RUNS_HEADERS,
    LLM_RUNS_SHEET,
    REFERENCES_HEADERS,
    REFERENCES_SHEET,
    AUDIT_LOG_SHEET,
    PUBLICATION_CANDIDATES_SHEET,
    DUPLICATE_CANDIDATES_SHEET
} from '../src/lib/sheets/schema';

/**
 * 抽出アプリ（sr-data-extraction-plugin）から読まれているシートの契約文書が、
 * TiAb のコードに実在する列・キー・ファイルだけを挙げていることの検査。
 *
 * テストは .tmp/tests/ 配下にコンパイルされて実行されるため、__dirname ではなく
 * リポジトリルート（npm test の cwd）基準で解決する。
 */
const CONTRACT_PATH = join('src', 'lib', 'sheets', 'SHARED-SHEET-CONTRACT.md');

function readRepoFile(relative: string): string {
    return readFileSync(join(process.cwd(), relative), 'utf8');
}

function loadDependencies(): Map<string, string[]> {
    const text = readRepoFile(CONTRACT_PATH);
    const begin = '<!-- contract-dependencies:begin -->';
    const end = '<!-- contract-dependencies:end -->';
    const from = text.indexOf(begin);
    const to = text.indexOf(end);
    assert.ok(from >= 0 && to > from, '契約文書に contract-dependencies の囲みが無い');
    const result = new Map<string, string[]>();
    for (const line of text.slice(from + begin.length, to).split('\n')) {
        const m = /^(\w+)\s*=\s*(.+)$/.exec(line.trim());
        if (!m) continue;
        result.set(m[1], m[2].split(',').map((v) => v.trim()).filter((v) => v !== ''));
    }
    return result;
}

function get(deps: Map<string, string[]>, name: string): string[] {
    const v = deps.get(name);
    assert.ok(v && v.length > 0, `${name} の行が無い`);
    return v;
}

test('契約: References の列がすべて REFERENCES_HEADERS にある', () => {
    for (const col of get(loadDependencies(), 'References')) {
        assert.ok(REFERENCES_HEADERS.includes(col), `References に ${col} が無い`);
    }
});

test('契約: Decisions の列がすべて DECISIONS_HEADERS にある', () => {
    for (const col of get(loadDependencies(), 'Decisions')) {
        assert.ok(DECISIONS_HEADERS.includes(col), `Decisions に ${col} が無い`);
    }
});

test('契約: tabs が TiAb のタブ名と一致し、5つがすべて出てくる', () => {
    const tabs = get(loadDependencies(), 'tabs');
    const known = [REFERENCES_SHEET, DECISIONS_SHEET, CONFIG_SHEET, LLM_RUNS_SHEET, LLM_EXECUTIONS_SHEET];
    for (const tab of tabs) {
        assert.ok(known.includes(tab), `tabs の ${tab} が TiAb のタブ名に無い`);
    }
    for (const tab of known) {
        assert.ok(tabs.includes(tab), `tabs に ${tab} が出てこない`);
    }
});

test('契約: LLM_Runs と LLM_Executions の列が TiAb のヘッダーにある', () => {
    const deps = loadDependencies();
    for (const col of get(deps, 'LLM_Runs')) {
        assert.ok(LLM_RUNS_HEADERS.includes(col), `LLM_Runs に ${col} が無い`);
    }
    for (const col of get(deps, 'LLM_Executions')) {
        assert.ok(LLM_EXECUTIONS_HEADERS.includes(col), `LLM_Executions に ${col} が無い`);
    }
});

test('契約: Config のキーが TiAb の Config 読み取りコードに文字列として現れる', () => {
    const source = readRepoFile(join('src', 'lib', 'sheets', 'config-schema.ts')) +
        '\n' + readRepoFile(join('src', 'lib', 'sheets', 'config.ts'));
    for (const key of get(loadDependencies(), 'Config')) {
        assert.ok(source.includes(`'${key}'`), `Config のキー ${key} がコードに無い`);
    }
});

test('契約: reserved_tabs は TiAb のタブ名の定数と衝突しない', () => {
    const tabNames = [
        REFERENCES_SHEET, DECISIONS_SHEET, CONFIG_SHEET, LLM_EXECUTIONS_SHEET, LLM_RUNS_SHEET,
        AUDIT_LOG_SHEET, PUBLICATION_CANDIDATES_SHEET, DUPLICATE_CANDIDATES_SHEET
    ];
    assert.equal(tabNames.length, 8);
    for (const name of get(loadDependencies(), 'reserved_tabs')) {
        assert.ok(!tabNames.includes(name), `reserved_tabs の ${name} を TiAb が使っている`);
    }
});

test('契約: 3節の表に出てくる src/lib のパスがすべて実在する', () => {
    const text = readRepoFile(CONTRACT_PATH);
    const start = text.indexOf('## 3.');
    const stop = text.indexOf('## 4.');
    assert.ok(start >= 0 && stop > start);
    const paths = new Set(text.slice(start, stop).match(/src\/lib\/[\w./-]+\.ts/g) ?? []);
    assert.ok(paths.has('src/lib/sheets/llm-history.ts'));
    assert.ok(paths.has('src/lib/sheets/config.ts'));
    for (const p of paths) {
        assert.ok(existsSync(join(process.cwd(), p)), `${p} が無い`);
    }
});
