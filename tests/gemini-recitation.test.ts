import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionApiKey, setSessionApiKey } from '../src/lib/storage';
import { callGeminiApiWithParts, GeminiApiError } from '../src/lib/gemini-api';
import { judgeFulltext } from '../src/lib/gemini-fulltext';
import { RECITATION_TEXT } from './fixtures/fulltext-recitation';

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const originalKey = process.env.GEMINI_API_KEY;
const usage = { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 30 };
const metadata = { modelVersion: 'test-model', responseId: 'test-response' };
const complete = { decision: 'include', include_probability: 1, reason: '理由', evidence: [] };

test.beforeEach(() => {
    globalThis.chrome = { i18n: { getMessage: (key: string) => key } } as typeof chrome;
    setSessionApiKey('test-api-key');
    process.env.GEMINI_API_KEY = '';
});
test.afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
    clearSessionApiKey();
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
});

function mockResponse(text: string, finishReason: string): void {
    const midpoint = Math.floor(text.length / 2);
    globalThis.fetch = async () => new Response(JSON.stringify([
        { candidates: [{ content: { parts: [{ text: text.slice(0, midpoint) }] } }] },
        { candidates: [{ content: { parts: [{ text: text.slice(midpoint) }] }, finishReason }],
            usageMetadata: usage, ...metadata },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('引用の打ち切りエラーに連結本文・終了理由・使用量・応答情報を保持する', async () => {
    mockResponse(RECITATION_TEXT, 'RECITATION');
    await assert.rejects(callGeminiApiWithParts([], {}), (err: unknown) => {
        assert.ok(err instanceof GeminiApiError);
        assert.equal(err.code, 'recitation_truncated');
        assert.equal(err.retryable, true);
        assert.equal(err.message, 'error_geminiRecitation');
        assert.equal(err.partialText, RECITATION_TEXT);
        assert.equal(err.finishReason, 'RECITATION');
        assert.deepEqual(err.usageMetadata, { ...usage, cachedInputTokens: 0 });
        assert.deepEqual(err.responseMetadata, metadata);
        return true;
    });
});

test('引用打ち切りで本文が空なら専用エラーに空文字を保持する', async () => {
    mockResponse('', 'RECITATION');
    await assert.rejects(callGeminiApiWithParts([], {}), (err: unknown) => {
        assert.ok(err instanceof GeminiApiError);
        assert.equal(err.code, 'recitation_truncated');
        assert.equal(err.partialText, '');
        return true;
    });
});

test('引用打ち切りでも完結したJSONは通常の結果として返す', async () => {
    for (const text of [JSON.stringify(complete), '```json\n' + JSON.stringify(complete) + '\n```']) {
        mockResponse(text, 'RECITATION');
        assert.deepEqual((await callGeminiApiWithParts([], {})).result, complete);
    }
});

test('他の終了理由のエラーコードと再試行可否は変えない', async () => {
    for (const [text, finishReason, code, retryable] of [
        ['{"broken":', 'STOP', 'json_parse_failed', true],
        ['{"broken":', 'MAX_TOKENS', 'max_tokens_truncated', false],
        ['', 'STOP', 'no_text', true],
        ['{"broken":', 'SAFETY', 'json_parse_failed', true],
    ] as const) {
        mockResponse(text, finishReason);
        await assert.rejects(callGeminiApiWithParts([], {}), (err: unknown) => {
            assert.ok(err instanceof GeminiApiError);
            assert.equal(err.code, code);
            assert.equal(err.retryable, retryable);
            return true;
        });
    }
});

test('全文判定は実応答の完結部分を採用し座標を正規化する', async () => {
    mockResponse(RECITATION_TEXT, 'RECITATION');
    const result = await judgeFulltext(new Uint8Array([1, 2]), '基準');
    assert.equal(result.evidenceTruncated, true);
    assert.equal(result.output.decision, 'include');
    assert.equal(result.output.evidence.length, 1);
    assert.deepEqual(result.output.evidence[0].bbox, [515, 655, 748, 685].map(n => n / 1000));
    assert.deepEqual(result.usageMetadata, { ...usage, cachedInputTokens: 0 });
    assert.deepEqual(result.responseMetadata, metadata);
});

test('全文判定は理由の途中で切れた応答を専用エラーのまま返す', async () => {
    mockResponse('{"decision":"include","include_probability":1,"reason":"途中', 'RECITATION');
    await assert.rejects(judgeFulltext(new Uint8Array([1]), '基準'), (err: unknown) => {
        assert.ok(err instanceof GeminiApiError);
        assert.equal(err.code, 'recitation_truncated');
        assert.equal(err.message, 'error_geminiRecitation');
        return true;
    });
});

test('全文判定の通常成功は根拠欠けなしを常に返す', async () => {
    mockResponse(JSON.stringify(complete), 'STOP');
    assert.equal((await judgeFulltext(new Uint8Array([1]), '基準')).evidenceTruncated, false);
});
