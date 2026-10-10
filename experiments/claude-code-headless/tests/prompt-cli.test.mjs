// 製品とのドリフトと CLI 応答の全分類を外部呼び出しなしで検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { repoRoot, experimentRoot } from '../lib/inputs.mjs';
import { SCREENING_SCHEMA, buildScreeningPrompt } from '../lib/prompt.mjs';
import { buildCliArgs, classifyCliResult } from '../lib/cli.mjs';

const model = 'claude-haiku-5-5';
const config = JSON.parse(fs.readFileSync(path.join(experimentRoot, 'config.json'), 'utf8'));
const success = () => ({
    is_error: false, subtype: 'success', modelUsage: { [model]: {} },
    structured_output: { include_probability: 0.5, reasons: [], evidence: [] },
});
const raw = (parsed = success()) => ({
    exitCode: 0, stdout: JSON.stringify(parsed), stderr: 'モデルに関する警告', timedOut: false, spawnError: null,
});

test('製品テンプレートの固定行と生成プロンプトが一致する', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/lib/gemini-api.ts'), 'utf8').replace(/\r\n/g, '\n');
    const prompt = buildScreeningPrompt({ ...config, criteria: config.dataset.criteria }, { title: '題名', abstract: '' });
    const fixed = [
        '## 対象文献', '**タイトル:**', '**抄録:**', '## 出力指示',
        '- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力',
        '- reasons: 判断理由を', 'で短文配列で出力',
        '- evidence: タイトルまたは抄録から判断根拠となる部分を正確に抜粋（quote）し、'
            + 'その開始位置（start_char）と終了位置（end_char）を指定',
        '注意: quoteはtitleまたはabstract内の正確な部分文字列でなければなりません。',
    ];
    for (const line of fixed) {
        assert.ok(source.includes(line));
        assert.ok(prompt.includes(line));
    }
    const template = source.match(/const prompt = (`\$\{screeningPrompt\}[\s\S]*?`);/)[1];
    const expected = vm.runInNewContext(template, {
        screeningPrompt: config.defaultScreeningPrompt.replace('{{CRITERIA}}', config.dataset.criteria),
        title: '題名', abstract: '', outputLanguage: 'ja',
    });
    assert.equal(prompt, expected);
    assert.ok(prompt.includes('(抄録なし)'));
});

test('設定文字列と比較行を参照元からそのまま保持する', () => {
    const gemini = JSON.parse(fs.readFileSync(path.join(repoRoot, 'experiments/gemini-3.8-flash/config.json'), 'utf8'));
    const jev = JSON.parse(fs.readFileSync(path.join(repoRoot, 'experiments/typesafe-jev/config.json'), 'utf8'));
    assert.equal(config.defaultScreeningPrompt, gemini.defaultScreeningPrompt);
    assert.equal(config.dataset.criteria, gemini.datasetConfigs.depression.criteria);
    assert.deepEqual(config.baselines, jev.comparison.depression);
});

test('スキーマは製品と同一で両オブジェクトだけ追加プロパティを禁止する', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/lib/gemini-api.ts'), 'utf8');
    const literal = source.match(/export const SCREENING_OUTPUT_SCHEMA = (\{[\s\S]*?\n\});/)[1];
    const expected = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`)));
    expected.additionalProperties = false;
    expected.properties.evidence.items.additionalProperties = false;
    assert.deepEqual(SCREENING_SCHEMA, expected);
});

test('CLI 引数は空文字を独立した要素として保持する', () => {
    assert.deepEqual(buildCliArgs({ model, effort: 'low' }, SCREENING_SCHEMA), [
        '-p', '--model', model, '--effort', 'low', '--system-prompt', '', '--tools', '', '--setting-sources', '',
        '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
        '--output-format', 'json', '--json-schema', JSON.stringify(SCREENING_SCHEMA),
    ]);
});

test('spawn_error が最優先', () => {
    assert.equal(classifyCliResult({ ...raw(), spawnError: '起動不可', timedOut: true, exitCode: 1 }, model).kind, 'spawn_error');
});
test('timeout は終了コードより優先', () => {
    assert.equal(classifyCliResult({ ...raw(), timedOut: true, exitCode: 1 }, model).kind, 'timeout');
});
test('nonzero_exit は JSON より優先', () => {
    assert.equal(classifyCliResult({ ...raw(), exitCode: 1, stdout: '不正' }, model).kind, 'nonzero_exit');
});
test('bad_json は配列・null・連結 JSON も拒否する', () => {
    for (const stdout of ['不正', '[]', 'null', '{}{}', '42']) {
        assert.equal(classifyCliResult({ ...raw(), stdout }, model).kind, 'bad_json');
    }
});
test('cli_error はエラーフラグまたは成功以外の subtype', () => {
    for (const change of [{ is_error: true }, { subtype: 'error' }, { subtype: undefined }]) {
        assert.equal(classifyCliResult(raw({ ...success(), ...change }), model).kind, 'cli_error');
    }
});
test('model_mismatch は未報告または要求モデルなし', () => {
    for (const modelUsage of [undefined, {}, { auxiliary: {} }]) {
        assert.equal(classifyCliResult(raw({ ...success(), modelUsage }), model).kind, 'model_mismatch');
    }
});
test('invalid_output は欠落、範囲外、文字列、NaN、理由・根拠の不正を拒否する', () => {
    const outputs = [undefined, ...[1.2, '0.5', NaN, -0.1].map((include_probability) => ({
        ...success().structured_output, include_probability,
    })), { include_probability: 0.5, reasons: [1], evidence: [] },
    { include_probability: 0.5, reasons: [], evidence: {} }];
    for (const structured_output of outputs) {
        // NaN は JSON 上で null になるが、CLI 境界でも確率として受理しない。
        assert.equal(classifyCliResult(raw({ ...success(), structured_output }), model).kind, 'invalid_output');
    }
});
test('ok は標準エラーの警告があっても成功', () => {
    assert.equal(classifyCliResult(raw(), model).kind, 'ok');
});
test('補助モデルが追加されても要求モデルがあれば成功', () => {
    const parsed = success();
    parsed.modelUsage.auxiliary = {};
    assert.equal(classifyCliResult(raw(parsed), model).kind, 'ok');
});
