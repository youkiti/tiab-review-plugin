import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
    buildLabelsCsv, buildManifestCsv, createZip, crc32, findLeftoverQuote, inferMeta, manifestRow,
    parseManifestCsv, readZip, sanitizeFile, sha256, stripQuotes,
} from './core.mjs';
import { labelRecords, parseArgs } from './pack.mjs';

const evidence = [
    { field: 'title', quote: '抄録の原文', start_char: 3, end_char: 8, extra: 'x' },
    { field: 'abstract', quote: 'second', start_char: 10, end_char: 16 },
];

test('evidence の要素から quote と余分な項目を落とし、位置を残す', () => {
    const out = stripQuotes({ evidence });
    assert.deepEqual(out.evidence, [
        { field: 'title', start_char: 3, end_char: 8 },
        { field: 'abstract', start_char: 10, end_char: 16 },
    ]);
});

test('文字列に入った JSON の中も同じ規則で処理する', () => {
    const note = JSON.stringify({ type: 'llm', reasons: ['理由'], evidence });
    const out = stripQuotes({ note });
    const parsed = JSON.parse(out.note);
    assert.equal(parsed.reasons[0], '理由');
    assert.equal(parsed.evidence[0].start_char, 3);
    assert.ok(!out.note.includes('quote'));
    // JSON でない文字列と、数値などの値はそのまま
    assert.equal(stripQuotes('plain'), 'plain');
    assert.equal(stripQuotes('{broken'), '{broken');
    assert.equal(stripQuotes(0.5), 0.5);
});

test('入れ子の配列・オブジェクトの中の evidence も処理する', () => {
    const out = stripQuotes([{ decision: { note: JSON.stringify({ evidence }) }, nested: { deeper: [{ evidence }] } }]);
    assert.ok(!JSON.stringify(out).includes('quote'));
    assert.equal(out[0].nested.deeper[0].evidence[1].end_char, 16);
});

test('JSON と JSONL を書き戻し、quote が残らない', () => {
    const row = { ref_id: 'Depression-SLIM-1', decision: { note: JSON.stringify({ evidence }) } };
    const json = sanitizeFile('experiments/x/results/decisions_2026-05-20T01-11-58.json', Buffer.from(JSON.stringify([row], null, 2) + '\n'));
    assert.ok(json.toString().endsWith('\n'));
    assert.equal(findLeftoverQuote('a.json', json), null);
    assert.equal(JSON.parse(JSON.parse(json.toString())[0].decision.note).evidence[0].start_char, 3);
    const jsonl = sanitizeFile('r/depression_E1_items.jsonl.bak', Buffer.from(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`));
    assert.equal(jsonl.toString().split('\n').filter(Boolean).length, 2);
    assert.equal(findLeftoverQuote('r/depression_E1_items.jsonl.bak', jsonl), null);
    // JSON でないファイルは触らない
    const md = Buffer.from('# report\n');
    assert.equal(sanitizeFile('report.md', md), md);
});

test('quote が残ったら検出する（通常の JSON・文字列に入った JSON・gz の中）', () => {
    assert.match(findLeftoverQuote('a.json', Buffer.from('{"evidence":[{"quote":"x"}]}')), /quote/);
    assert.match(findLeftoverQuote('a.jsonl', Buffer.from('{"note":"{\\"quote\\":\\"x\\"}"}')), /quote/);
    assert.match(findLeftoverQuote('a.jsonl.gz', gzipSync(Buffer.from('{"quote":"x"}'))), /quote/);
    assert.equal(findLeftoverQuote('a.json', Buffer.from('{"evidence":[{"start_char":1}]}')), null);
    // ソースコードにある説明文の "quote" は結果データではない
    assert.equal(findLeftoverQuote('client.ts', Buffer.from('"quote": "<substring>"')), null);
});

test('manifest の行を組み立て、CSV から読み戻せる', () => {
    const data = Buffer.from('hello');
    const row = manifestRow('a.zip', 'experiments/a/b,c.json', data, { model: 'gemini-3.5-flash', dataset: 'Depression-SLIM', run_date: '2026-05-20' });
    assert.deepEqual(row, ['a.zip', 'experiments/a/b,c.json', 5, sha256(data), 'gemini-3.5-flash', 'Depression-SLIM', '2026-05-20']);
    const csv = buildManifestCsv([row, manifestRow('', 'README.md', data, { model: '', dataset: '', run_date: '' })]);
    assert.ok(csv.startsWith('zip,path,bytes,sha256,model,dataset,run_date\n'));
    const back = parseManifestCsv(csv);
    assert.equal(back[0][1], 'experiments/a/b,c.json');
    assert.equal(back[0][3], sha256(data));
    assert.equal(back[1][4], '');
});

test('ファイル名とファイル内の項目から model・dataset・run_date を取る', () => {
    const decisions = Buffer.from(JSON.stringify([{ ref_id: 'Depression-SLIM-9', reviewer_id: 'llm:gemini-3.5-flash@2026-05-20T01:11:02.800Z' }]));
    assert.deepEqual(inferMeta('experiments/g/results/decisions_2026-05-21T01-11-58.json', decisions),
        { model: 'gemini-3.5-flash', dataset: 'Depression-SLIM', run_date: '2026-05-21' });
    const items = Buffer.from(JSON.stringify({ ref_id: 'CQ1-4', decision: { ref_id: 'CQ1-4', reviewer_id: 'llm:m@2026-08-16T08:14:47.323Z' } }) + '\n');
    assert.deepEqual(inferMeta('r/cq1_E1_items.jsonl', items), { model: 'm', dataset: 'CQ1', run_date: '2026-08-16' });
    assert.deepEqual(inferMeta('experiments/typesafe-jev/titan-external/results/CD013042_jev-1.13.0_overall_v1.jsonl', Buffer.from('{}')),
        { model: 'jev-1.13.0', dataset: 'CD013042', run_date: '' });
    assert.deepEqual(inferMeta('plan.md', Buffer.from('x')), { model: '', dataset: '', run_date: '' });
});

test('ラベルの表は id と label_included の2列だけ', () => {
    const csv = buildLabelsCsv([
        { id: 'D-1', title: '題名', abstract: '抄録', label_included: 1 },
        { id: 'D-2', title: 't', abstract: 'a', label_included: 0 },
    ]);
    assert.equal(csv, 'id,label_included\nD-1,1\nD-2,0\n');
    assert.equal(buildLabelsCsv([{ id: 'W-1', label_final_included: true }], 'label_final_included'), 'id,label_included\nW-1,1\n');
});

test('ラベルのキーが無いレコードは id とキー名を含むエラーにする', () => {
    assert.throws(() => buildLabelsCsv([{ id: 'CQ1-1' }], 'label'), {
        name: 'Error',
        message: /id=CQ1-1: label /,
    });
});

test('文字列や null のラベルは id とキー名を含むエラーにする', () => {
    for (const label of ['0', null, 2]) {
        assert.throws(() => buildLabelsCsv([{ id: 'CQ1-2', label }], 'label'), {
            name: 'Error',
            message: /id=CQ1-2: label /,
        });
    }
});

test('id が無いか空のレコードはキー名を含むエラーにする', () => {
    for (const record of [{ label: 1 }, { id: '', label: 1 }, { id: null, label: 1 }]) {
        assert.throws(() => buildLabelsCsv([record], 'label'), {
            name: 'Error',
            message: /id=.*: label /,
        });
    }
});

test('真偽値のラベルを整数に変換する', () => {
    assert.equal(buildLabelsCsv([
        { id: 'CQ1-1', label: true },
        { id: 'CQ1-2', label: false },
    ], 'label'), 'id,label_included\nCQ1-1,1\nCQ1-2,0\n');
});

test('ラベルの配列と records 付きオブジェクトからレコードを取り出す', () => {
    const records = [{ id: 'CQ1-1', label: 1 }];
    assert.equal(labelRecords(records, 'array.json'), records);
    assert.equal(labelRecords({ dataset: 'cq1', records }, 'cq1_labeled.json'), records);
});

test('ラベルのデータ形式が不正ならファイル名を含むエラーにする', () => {
    for (const parsed of [null, {}, { records: {} }, 'invalid']) {
        assert.throws(() => labelRecords(parsed, 'invalid.json'), {
            name: 'Error',
            message: /invalid\.json:/,
        });
    }
});

test('zip を作って読み戻すと内容と CRC が一致する', () => {
    const entries = [
        { name: 'experiments/a/日本語.json', data: Buffer.from('{"a":1}'.repeat(1000)) },
        { name: 'experiments/a/empty.txt', data: Buffer.alloc(0) },
    ];
    const back = readZip(createZip(entries));
    assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
    assert.ok(back[0].data.equals(entries[0].data));
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('引数を読む', () => {
    assert.deepEqual(parseArgs([]), { commit: 'HEAD', verify: false, out: null, date: null });
    assert.equal(parseArgs(['--commit', 'abc', '--verify']).commit, 'abc');
    assert.throws(() => parseArgs(['--nope']));
});
