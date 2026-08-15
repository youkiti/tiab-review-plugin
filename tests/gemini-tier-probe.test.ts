// gemini-tier-probe.test.ts
// batchGenerateContent プローブによる tier 判定ロジック（純関数）の回帰テスト。
// classifyTierProbeResponse() は「requests が空の batch」への応答を分類するだけの純関数で、
// ネットワークアクセスは行わない（実際の HTTP 呼び出しは detectTierByBatchProbe() の責務）。
//
// 参照実装: experiments/gemini-tier-detection/probe3-detector.mjs の detectTier()
// 実測結果: experiments/gemini-tier-detection/report.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTierProbeResponse } from '../src/lib/gemini-api';

function objectBody(status: string, message: string): string {
    return JSON.stringify({ error: { code: 400, status, message } });
}

function arrayBody(status: string, message: string): string {
    return JSON.stringify([{ error: { code: 400, status, message } }]);
}

// ===== free =====

test('classifyTierProbeResponse: 400 + FAILED_PRECONDITION → free（オブジェクト形式）', () => {
    const body = objectBody('FAILED_PRECONDITION', 'Your project has not enabled billing.');
    assert.equal(classifyTierProbeResponse(400, body), 'free');
});

test('classifyTierProbeResponse: 400 + FAILED_PRECONDITION → free（配列形式）', () => {
    const body = arrayBody('FAILED_PRECONDITION', 'Your project has not enabled billing.');
    assert.equal(classifyTierProbeResponse(400, body), 'free');
});

// ===== paid =====

test('classifyTierProbeResponse: 400 + INVALID_ARGUMENT + inlined requests 文言 → paid（オブジェクト形式）', () => {
    const body = objectBody(
        'INVALID_ARGUMENT',
        'Invalid JSON payload received. Must specify either an input file or a non-empty list of inlined requests.'
    );
    assert.equal(classifyTierProbeResponse(400, body), 'paid');
});

test('classifyTierProbeResponse: 400 + INVALID_ARGUMENT + inlined requests 文言 → paid（配列形式）', () => {
    const body = arrayBody(
        'INVALID_ARGUMENT',
        'Invalid JSON payload received. Must specify either an input file or a non-empty list of inlined requests.'
    );
    assert.equal(classifyTierProbeResponse(400, body), 'paid');
});

test('classifyTierProbeResponse: message が "input file" を含む場合も paid', () => {
    const body = objectBody('INVALID_ARGUMENT', 'You must provide either an input file or inline requests.');
    assert.equal(classifyTierProbeResponse(400, body), 'paid');
});

// ===== invalid_key =====

test('classifyTierProbeResponse: message が "API key not valid" を含む → invalid_key', () => {
    const body = objectBody('INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.');
    assert.equal(classifyTierProbeResponse(400, body), 'invalid_key');
});

// ===== unknown（一過性の失敗を paid/free と誤断定しないこと） =====

test('classifyTierProbeResponse: 400 + INVALID_ARGUMENT だが inlined requests と無関係な message → unknown（paid と誤断定しない）', () => {
    const body = objectBody('INVALID_ARGUMENT', 'The request body is malformed for an unrelated reason.');
    assert.equal(classifyTierProbeResponse(400, body), 'unknown');
});

test('classifyTierProbeResponse: 空文字 body → unknown', () => {
    assert.equal(classifyTierProbeResponse(400, ''), 'unknown');
});

test('classifyTierProbeResponse: 非JSON body（HTMLエラーページ等）→ unknown', () => {
    assert.equal(classifyTierProbeResponse(502, '<html><body>Bad Gateway</body></html>'), 'unknown');
});

test('classifyTierProbeResponse: 200 → unknown', () => {
    assert.equal(classifyTierProbeResponse(200, JSON.stringify({ name: 'batches/xyz' })), 'unknown');
});

test('classifyTierProbeResponse: 429 → unknown', () => {
    const body = objectBody('RESOURCE_EXHAUSTED', 'You exceeded your current quota.');
    assert.equal(classifyTierProbeResponse(429, body), 'unknown');
});

test('classifyTierProbeResponse: 500 → unknown', () => {
    const body = objectBody('INTERNAL', 'Internal error.');
    assert.equal(classifyTierProbeResponse(500, body), 'unknown');
});
