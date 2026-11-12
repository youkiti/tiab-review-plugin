// 一時ディレクトリの偽データで指標・閾値凍結・台帳・再開・応答検証を確かめる。
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rocAuc } from '../ledger';
import {
    FailureRow, LedgerRow, RecordRow, appendLedger, configHash, loadConfig, outputPaths, readRecords, readSuccess, sha256,
} from './common';
import { chooseThreshold, delong, metrics, structural } from './metrics';
import { Options, fakeScreen, parseArgs, run } from './runner';
import { SummaryOptions, summarize } from './summarize';
import { createScreen, pdfInput } from './decisions-fulltext';

const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12);
function record(i: number): RecordRow {
    return { key: `PMC1:${i}`, pmcid: 'PMC1', pmid: String(i), cochrane_id: 'test', label: i < 3 ? 'included' : 'excluded',
        gold_exclusion_reason: '非公開の除外理由', study_keys: [i < 2 ? 'study:same' : `pmid:${i}`], title: '非公開の題名',
        screening_prompt: '非公開の基準', text: '非公開の本文', text_chars: 6, text_truncated: false,
        report_pmcid: `PMC${i + 1}`, pdf_url: i === 5 ? null : 'https://example.invalid/test.pdf', pdf_md5: null,
        jev_probability: [0.9, 0.6, 0.2, 0.7, 0.4, 0.1][i] };
}
function writeRecords(dir: string, records: RecordRow[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'records.jsonl'), content);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ records_sha256: sha256(content) }));
    return path.join(dir, 'records.jsonl');
}
async function main(): Promise<void> {
    const config = loadConfig(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dec1ft-selftest-'));
    if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)
        || !path.basename(temporary).startsWith('dec1ft-selftest-')) {
        throw new Error('一時ディレクトリの範囲が一致しません。');
    }
    try {
        const rows = Array.from({ length: 6 }, (_, i) => record(i));
        const a = [0.9, 0.6, 0.3, 0.7, 0.4, 0.1], b = [0.9, 0.8, 0.2, 0.7, 0.6, 0.1];
        const labels = rows.map(r => r.label === 'included');
        const pairs = rows.map((record, i) => ({ record, p: a[i] }));
        const tied = [0.9, 0.5, 0.5, 0.5, 0.5, 0.1];
        close(structural(labels, tied)!.auc, rocAuc(tied.map((p, i) => ({ include_probability: p, label_included: labels[i] ? 1 : 0 })))!);
        // A: V10=(1,2/3,1/3)、V01=(1/3,2/3,1)、標本分散は両方1/9。
        // B: V10=(1,1,1/3)、V01=(2/3,2/3,1)、標本分散は4/27と1/27。
        // 標本共分散は1/9と1/18なので、DeLong 共分散は (1/9+1/18)/3=1/18。
        // A の分散は (1/9+1/9)/3=2/27、B の分散は (4/27+1/27)/3=5/81。
        const paired = delong(labels, a, b);
        close(paired.aucA, 2 / 3);
        close(paired.aucB, 7 / 9);
        close(paired.varianceA, 2 / 27);
        close(paired.varianceB, 5 / 81);
        close(paired.covariance, 1 / 18);
        assert.deepEqual(delong(labels, a, a).ci, [0, 0]);
        assert.equal(delong([true], [0.2], [0.4]).aucA, null);
        assert.equal(delong([true, false], [0.2, 0.1], [0.4, 0.1]).ci, null);
        close(chooseThreshold(pairs, 2 / 3), 0.6);
        close(chooseThreshold(rows.map((record, i) => ({ record, p: tied[i] })), 2 / 3), 0.5);
        assert.throws(() => chooseThreshold([], null));
        const studyRows = [record(0), record(1), record(2), { ...record(0), key: 'PMC2:0', pmcid: 'PMC2' }];
        const study = metrics(studyRows.map((record, i) => ({ record, p: [0, 1, 1, 0][i] })), 0.5);
        assert.equal(study.includedStudies, 3);
        assert.equal(study.found, 2);
        close(study.studyRecall, 2 / 3);
        const recordsFile = writeRecords(path.join(temporary, 'data/cc-by'), rows);
        writeRecords(path.join(temporary, 'data/cc-by-nc'), rows);
        const { digest } = readRecords(recordsFile);
        const hash = configHash(config, 'text', digest);
        const fake = await fakeScreen(config)(rows[0], 2, '');
        const row: LedgerRow = { key: rows[0].key, pmcid: rows[0].pmcid, pmid: rows[0].pmid, input: 'text', ...fake,
            attempts: 1, latency_ms: 1, config_hash: hash, completed_at: new Date().toISOString() };
        const ledgerFile = path.join(temporary, 'ledger.jsonl');
        fs.writeFileSync(ledgerFile, JSON.stringify(row) + '\n{"key":');
        assert.equal(readSuccess(ledgerFile, hash, 'text', config).brokenLines, 1);
        appendLedger(ledgerFile, { ...row, include_probability: 0.123 });
        close(readSuccess(ledgerFile, hash, 'text', config).rows.get(row.key)!.include_probability, 0.123);
        appendLedger(ledgerFile, { ...row, config_hash: 'different' });
        appendLedger(ledgerFile, row);
        assert.throws(() => readSuccess(ledgerFile, hash, 'text', config));
        const outputDir = path.join(temporary, 'results');
        const options: Options = { ...parseArgs(['--tier', 'cc-by', '--input', 'text', '--fake', '--records', recordsFile], config), outputDir };
        const messages: string[] = [];
        const first = await run(options, config, undefined, s => messages.push(s));
        assert.equal(first.code, 0);
        assert.equal(first.success, 6);
        const resumed = await run(options, config, undefined, s => messages.push(s));
        assert.equal(resumed.code, 0);
        assert.equal(resumed.success, 0);
        const pdf = await run({ ...options, input: 'pdf' }, config, undefined, s => messages.push(s));
        assert.equal(pdf.code, 0);
        assert.equal(pdf.success, 5);
        assert.equal(pdf.skipped.no_pdf, 1);
        assert.ok(messages.some(m => m.includes('no_pdf 1')));
        const missingPdf = await run({ ...options, input: 'pdf', fake: false, outputDir: path.join(temporary, 'missing') },
            config, fakeScreen(config), () => undefined);
        assert.equal(missingPdf.code, 1);
        assert.equal(missingPdf.skipped.pdf_missing, 5);
        const pdfDirectory = path.join(path.dirname(recordsFile), 'pdf');
        fs.mkdirSync(pdfDirectory);
        for (const item of rows.filter(r => r.pdf_url)) {
            fs.writeFileSync(path.join(pdfDirectory, `${item.report_pmcid}.pdf`), 'fake-pdf');
        }
        const tooLarge = await run({ ...options, input: 'pdf', fake: false, outputDir: path.join(temporary, 'large') },
            { ...config, maxPdfBytes: 1 }, fakeScreen(config), () => undefined);
        assert.equal(tooLarge.code, 0);
        assert.equal(tooLarge.skipped.too_large, 5);
        assert.equal(tooLarge.success, 0);
        const md5Rows = rows.map(r => ({ ...r, pdf_md5: r.pdf_url ? '0'.repeat(32) : null }));
        const md5File = writeRecords(path.join(temporary, 'md5/cc-by'), md5Rows);
        fs.mkdirSync(path.join(path.dirname(md5File), 'pdf'));
        for (const item of md5Rows.filter(r => r.pdf_url)) {
            fs.writeFileSync(path.join(path.dirname(md5File), 'pdf', `${item.report_pmcid}.pdf`), 'fake-pdf');
        }
        const badMd5 = await run({ ...options, input: 'pdf', fake: false, recordsFile: md5File, outputDir: path.join(temporary, 'md5-results') },
            config, fakeScreen(config), () => undefined);
        assert.equal(badMd5.code, 1);
        assert.equal(badMd5.skipped.pdf_missing, 5);
        assert.equal(badMd5.success, 0);
        const summary: SummaryOptions = { fake: true, freeze: true, force: false, tier: 'cc-by',
            recordsDir: path.join(temporary, 'data'), outputDir };
        summarize(summary, config);
        assert.throws(() => summarize(summary, config));
        const frozen = JSON.parse(fs.readFileSync(path.join(outputDir, 'thresholds.json'), 'utf8'));
        close(frozen.text.threshold, chooseThreshold(rows.map(record => ({ record,
            p: readSuccess(outputPaths('cc-by', 'text', config, true, outputDir).ledger, hash, 'text', config).rows.get(record.key)!.include_probability })),
        metrics(rows.map(record => ({ record, p: record.jev_probability })), 0.3).recall));
        for (const input of ['pdf', 'text'] as const) {
            const result = await run({ ...options, input, tier: 'cc-by-nc', recordsFile: path.join(temporary, 'data/cc-by-nc/records.jsonl') },
                config, undefined, () => undefined);
            assert.equal(result.code, 0);
        }
        const report = summarize({ ...summary, freeze: false, tier: undefined }, config);
        const reportText = fs.readFileSync(report, 'utf8');
        assert.ok(reportText.includes('PDF − テキスト'));
        assert.ok(reportText.includes('採用条件:'));
        for (const text of ['非公開の題名', '非公開の本文', '非公開の除外理由', '非公開の基準']) {
            assert.ok(!reportText.includes(text));
        }
        const sampleFile = path.join(temporary, 'data/cc-by-nc/reason_sample_pdf.jsonl');
        const sample = fs.readFileSync(sampleFile, 'utf8');
        summarize({ ...summary, freeze: false, tier: undefined }, config);
        assert.equal(fs.readFileSync(sampleFile, 'utf8'), sample);
        assert.throws(() => summarize({ ...summary, outputDir: path.join(temporary, 'incomplete') }, config));
        const fatalDir = path.join(temporary, 'fatal');
        const fatal = await run({ ...options, outputDir: fatalDir, concurrency: 1 }, config, async () => {
            throw Object.assign(new Error('API error 401'), { httpStatus: 401 });
        }, () => undefined);
        assert.equal(fatal.code, 3);
        assert.equal(fatal.failed, 1);
        const exhausted = await run({ ...options, outputDir: path.join(temporary, 'exhausted') }, { ...config, maxAttempts: 2 }, async () => {
            throw Object.assign(new Error('API error 400'), { httpStatus: 400, errorStatus: 'INVALID_ARGUMENT' });
        }, () => undefined);
        assert.equal(exhausted.code, 2);
        assert.equal(exhausted.failed, 6);
        const failures = fs.readFileSync(path.join(temporary, 'exhausted/cc-by_text_v1.failures.jsonl'), 'utf8')
            .trim().split('\n').map(line => JSON.parse(line) as FailureRow);
        assert.ok(failures.every(f => f.attempts === 2 && f.error_status === 'INVALID_ARGUMENT'));
        assert.equal(pdfInput('test', Buffer.from('pdf'))[1].data, Buffer.from('pdf').toString('base64'));
        const originalFetch = globalThis.fetch;
        try {
            let sent: { questions: Record<string, unknown>; input: unknown } | undefined;
            globalThis.fetch = async (_url, init) => {
                sent = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({ answers: { include: { noul: 0.5 },
                    exclude_reason: { choice: fake.reason_choice, probabilities: fake.reason_probabilities } },
                usage: { total_input_tokens: 12 }, model_version: 'test' }), { status: 200 });
            };
            const result = await createScreen(config, 'text', 'fake-key')(rows[0], 1, '');
            assert.equal(result.input_tokens, 12);
            assert.equal(sent!.input, `Title: ${rows[0].title}\n\nFull text:\n${rows[0].text}`);
            assert.deepEqual(Object.keys(sent!.questions), ['include', 'exclude_reason']);
            globalThis.fetch = async () => new Response(JSON.stringify({ answers: {} }), { status: 200 });
            await assert.rejects(createScreen(config, 'text', 'fake-key')(rows[0], 1, ''), { kind: 'invalid_response' });
            globalThis.fetch = async () => new Response(JSON.stringify({ error: { status: 'secret text' } }), { status: 400 });
            await assert.rejects(createScreen(config, 'text', 'fake-key')(rows[0], 1, ''), { message: 'API error 400', errorStatus: null });
        } finally {
            globalThis.fetch = originalFetch;
        }
        console.log('自己テスト: 全項目 PASS');
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
if (require.main === module) {
    main().catch(error => {
        console.error('自己テストに失敗しました。', error);
        process.exitCode = 1;
    });
}
