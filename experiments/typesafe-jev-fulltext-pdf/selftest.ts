// 一時領域の偽記録と台帳で集計値・理由の近似・追記の復旧を検証する。
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    appendLedger, configHash, FailureRow, LedgerRow, readConfig, readFailures, readRecords,
    readSuccess, RecordRow, sha256,
} from './common';
import { calculate, metrics, render, rocAuc } from './summarize';
import { mapReasons } from './reasons';
import { parseArgs } from './runner';

const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12);
function record(i: number): RecordRow {
    return { key: `PMC1:${i}`, pmcid: 'PMC1', pmid: String(i), label: i < 3 ? 'included' : 'excluded',
        study_keys: [i < 2 ? 'study:same' : `pmid:${i}`], title: '', screening_prompt: '',
        gold_exclusion_reason: ['', '', '', 'Wrong population', 'Wrong intervention and wrong comparator', 'Not postal questionnaire'][i],
        report_pmcid: `PMC${i + 10}`, pdf_url: null, pdf_md5: null,
        jev_probability: [0.9, 0.2, 0.2, 0.4, 0.2, 0.1][i] };
}
function success(row: RecordRow, i: number, hash: string): LedgerRow {
    const p = [0.9, 0.3, 0.2, 0.2, 0.1, 0.1][i];
    return { key: row.key, pmcid: row.pmcid, pmid: row.pmid, report_pmcid: row.report_pmcid,
        include_probability: p, decision: p >= 0.3 ? 'include' : 'exclude',
        choice: ['other', 'other', 'other', 'population', 'comparator', 'other'][i], reason_probabilities: {},
        chars_sent: 100 + i, raw_length: 200, truncated: i === 0, references_removed: i === 1,
        total_text_length: 200, input_tokens: 10, output_tokens: 2, cost_usd: 0.01,
        model_version: 'fake', latency_ms: 1, config_hash: hash };
}
export function selftest() {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ftjev-selftest-'));
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ftjev-selftest-')) {
        throw new Error('一時領域の範囲が一致しません。');
    }
    try {
        const rows = Array.from({ length: 6 }, (_, i) => record(i));
        const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
        fs.writeFileSync(path.join(temporary, 'records.jsonl'), content);
        fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ records: rows.length, records_sha256: sha256(content) }));
        const input = readRecords(path.join(temporary, 'records.jsonl'));
        assert.equal(input.records.length, 6);
        const config = readConfig(), hash = configHash(config, input.digest);
        assert.notEqual(hash, configHash({ ...config, concurrency: 1 }, input.digest));
        assert.notEqual(hash, configHash(config, sha256('different')));
        const file = path.join(temporary, 'success.jsonl');
        rows.forEach((row, i) => appendLedger(file, success(row, i, hash)));
        const ledger = readSuccess(file, hash).rows;
        const result = calculate(input.records, ledger, new Map());
        assert.deepEqual(result.states, { ok: 6, no_pdf: 0, image_only: 0, too_long: 0, pdf_error: 0, failed: 0, unexecuted: 0 });
        const m = result.pdf['0.3'];
        assert.deepEqual([m.tp, m.fp, m.tn, m.fn], [2, 0, 3, 1]);
        close(m.recall, 2 / 3);
        close(m.specificity, 1);
        close(m.precision, 1);
        close(m.studyRecall, 1 / 2);
        close(result.pdf.auc, 8.5 / 9);
        close(result.xml['0.3'].recall, 1 / 3);
        close(result.xml['0.3'].specificity, 2 / 3);
        assert.deepEqual([result.pdf['0.5'].tp, result.pdf['0.5'].fp, result.pdf['0.5'].tn, result.pdf['0.5'].fn], [1, 0, 3, 2]);
        assert.equal(result.verdict, '下がっていない');
        const report = render([{ ...result, tier: 'cc-by', records_sha256: input.digest,
            config_hash: hash, records_file: path.join(temporary, 'records.jsonl') }], true);
        assert.ok(report.includes('判定: 下がっていない'));
        assert.ok(report.includes('| Cochrane 区分 | population | intervention | comparator |'));
        assert.ok(!report.includes('Wrong population'));
        assert.deepEqual(result.paired.included, { xml_only: 0, pdf_only: 1, both: 1, neither: 1 });
        assert.deepEqual(result.paired.excluded, { xml_only: 1, pdf_only: 0, both: 0, neither: 2 });
        assert.deepEqual([result.reasons.single, result.reasons.multiple, result.reasons.unmapped], [1, 1, 1]);
        close(result.reasons.single_rate, 1);
        close(result.reasons.multiple_rate, 1);
        assert.equal(result.reasons.table.comparator.comparator, 1);
        assert.equal(result.reasons.table.intervention.comparator, 1);
        assert.equal(result.chars_sent_median, 102.5);
        assert.equal(result.truncated, 1);
        assert.equal(result.references_removed, 1);
        const lower = new Map(ledger);
        for (const row of rows.slice(0, 3)) {
            lower.set(row.key, { ...lower.get(row.key)!, include_probability: 0.1, decision: 'exclude' });
        }
        assert.equal(calculate(rows, lower, new Map()).verdict, '下がった');
        const partial = new Map(ledger);
        partial.delete(rows[0].key);
        assert.equal(calculate(rows, partial, new Map()).verdict, '未完了');
        const failureFile = path.join(temporary, 'failure.jsonl');
        const failure: FailureRow = { key: rows[0].key, status: 'too_long', error_kind: 'input_too_long',
            http_status: 400, total_text_length: 200, chars_sent: 100, config_hash: hash };
        appendLedger(failureFile, failure);
        const failures = readFailures(failureFile, hash).rows;
        assert.equal(calculate(rows, partial, failures).incomplete, 0);
        for (const status of ['no_pdf', 'image_only', 'too_long', 'pdf_error', 'failed'] as const) {
            failures.set(rows[0].key, { ...failure, status });
            const s = calculate(rows, partial, failures);
            assert.equal(s.states[status], 1);
            assert.equal(s.incomplete, status === 'pdf_error' || status === 'failed' ? 1 : 0);
        }
        assert.equal(rocAuc([]), null);
        assert.equal(metrics([], 0.3).recall, null);
        const crossReview = [rows[0], { ...rows[1], pmcid: 'PMC2' }];
        const cross = metrics(crossReview.map((record, i) => ({ record, p: i ? 0 : 1 })), 0.3);
        assert.equal(cross.includedStudies, 2);
        close(cross.studyRecall, 0.5);
        const fallback = metrics([{ record: { ...rows[0], study_keys: [] }, p: 1 }], 0.3);
        close(fallback.studyRecall, 1);
        const cases: [string, string[]][] = [
            ['Wrong patient population', ['population']], ['Wrong study design', ['study_design']],
            ['Wrong comparator', ['comparator']], ['No relevant outcome measures', ['outcome']],
            ['Duplicate publication', ['duplicate']], ['Not postal questionnaire', []],
            ['Ineligible intervention', ['intervention']], ['Not an RCT', ['study_design']],
            ['Does not report relevant outcomes', ['outcome']], ['Population was wrong', ['population']],
            ['Wrong intervention; wrong comparator', ['intervention', 'comparator']],
            ['NON-RANDOMISED cohort study', ['study_design']], ['', []],
        ];
        for (const [text, expected] of cases) {
            assert.deepEqual([...mapReasons(text)], expected);
        }
        // 改行のない壊れた末尾の後にも追記でき、最後の有効行が勝つ。
        fs.appendFileSync(file, '{broken');
        appendLedger(file, { ...success(rows[0], 0, hash), chars_sent: 999 });
        const recovered = readSuccess(file, hash);
        assert.equal(recovered.brokenLines, 1);
        assert.equal(recovered.rows.get(rows[0].key)!.chars_sent, 999);
        assert.throws(() => readSuccess(file, 'other'));
        assert.throws(() => parseArgs([]));
        assert.equal(parseArgs(['--tier', 'cc-by', '--limit', '0', '--fake']).limit, 0);
        assert.throws(() => parseArgs(['--tier', 'cc-by', '--limit', '-1']));
        console.log('selftest: PASS');
    } finally {
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}
if (require.main === module) {
    selftest();
}
