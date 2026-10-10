// 台帳の再開と手計算した指標・対象選択を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsonl, readJsonl, compactByRefId } from '../lib/ledger.mjs';
import { confusion, metricsFromConfusion, sweep } from '../lib/metrics.mjs';
import { parseArgs, loadInputs } from '../lib/inputs.mjs';

test('台帳は最後の行を採用し、部分行を数えて再開できる', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ledger-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'nested', 'items.jsonl');
    assert.deepEqual(readJsonl(file), []);
    appendJsonl(file, { ref_id: 'a', value: 1 });
    appendJsonl(file, { ref_id: 'a', value: 2 });
    fs.appendFileSync(file, '{"ref_id":', 'utf8');
    assert.equal(readJsonl(file).skippedPartialLines, 1);
    assert.deepEqual(compactByRefId(readJsonl(file)), [{ ref_id: 'a', value: 2 }]);
    appendJsonl(file, { ref_id: 'b', value: 3 });
    const rows = readJsonl(file);
    assert.equal(rows.skippedPartialLines, 1);
    assert.equal(compactByRefId(rows).length, 2);
});

test('手計算の混同行列と閾値境界、ゼロ分母', () => {
    const labels = new Map([['a', 1], ['b', 1], ['c', 1], ['d', 0], ['e', 0], ['f', 0], ['g', 0]]);
    const rows = [...labels.keys()].map((ref_id, index) => ({
        ref_id, include_probability: [0.5, 1, 0, 0.8, 0.1, 0.2, 0.3][index],
    }));
    const counts = confusion(rows, labels, 0.5);
    assert.deepEqual(counts, { tp: 2, fp: 1, tn: 3, fn: 1 });
    // 手計算: 再現率 2/3、特異度 3/4、適合率 2/3、Fβ7 = 100/(100+49+1) = 2/3。
    assert.deepEqual(metricsFromConfusion(counts), { recall: 2 / 3, specificity: 3 / 4, precision: 2 / 3, fBeta7: 2 / 3 });
    assert.deepEqual(metricsFromConfusion({ tp: 0, fp: 0, tn: 0, fn: 0 }), {
        recall: null, specificity: null, precision: null, fBeta7: null,
    });
    assert.equal(metricsFromConfusion({ tp: 0, fp: 0, tn: 2, fn: 1 }).precision, null);
    assert.equal(metricsFromConfusion({ tp: 0, fp: 0, tn: 2, fn: 1 }).fBeta7, 0);
    assert.equal(sweep(rows, labels, [0.5, 1])[0].tp, 2);
    assert.equal(sweep(rows, labels, [0.5, 1])[1].tp, 1);
});

test('実データの件数、標本、ラベル分離を検証する', () => {
    const smoke = loadInputs(parseArgs(['--condition', 'H1', '--smoke']));
    assert.equal(smoke.records.length, 50);
    assert.equal([...smoke.labels.values()].reduce((a, b) => a + b, 0), 10);
    assert.deepEqual(Object.keys(smoke.records[0]), ['id', 'title', 'abstract']);
    assert.equal(loadInputs(parseArgs(['--condition', 'H1', '--all'])).records.length, 1993);
    assert.throws(() => parseArgs(['--condition', 'H1', '--all', '--smoke']));
    assert.throws(() => parseArgs(['--condition', 'H1', '--all', '--limit', '0']));
});
