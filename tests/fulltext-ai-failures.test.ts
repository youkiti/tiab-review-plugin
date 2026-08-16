import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyFulltextAiFailure,
    summarizeFailures,
    serializeFailureBreakdown,
    parseFailureBreakdown,
    NoDriveUrlError,
    PdfReadError,
    PdfTooLargeError,
    LlmCallError,
    type FulltextAiFailureKind,
} from '../src/lib/fulltext-ai-failures';

// ---------------------------------------------------------------------------
// classifyFulltextAiFailure
// ---------------------------------------------------------------------------

test('classifyFulltextAiFailure: Drive 権限エラー（403相当）は drive_denied', () => {
    const err = { name: 'DriveAccessDeniedError', status: 403 };
    assert.equal(classifyFulltextAiFailure(err), 'drive_denied');
});

test('classifyFulltextAiFailure: DriveAccessDeniedError で status 未設定でも drive_denied（安全側）', () => {
    const err = { name: 'DriveAccessDeniedError' };
    assert.equal(classifyFulltextAiFailure(err), 'drive_denied');
});

test('classifyFulltextAiFailure: Drive 404相当は drive_not_found', () => {
    const err = { name: 'DriveAccessDeniedError', status: 404 };
    assert.equal(classifyFulltextAiFailure(err), 'drive_not_found');
});

test('classifyFulltextAiFailure: Drive URL 無し（NoDriveUrlError）は no_drive_url', () => {
    assert.equal(classifyFulltextAiFailure(new NoDriveUrlError()), 'no_drive_url');
});

test('classifyFulltextAiFailure: no_drive_url は i18n文言に依存しない（言語非依存の判別子で判定する）', () => {
    // 日本語UIでも英語UIでもメッセージ文言に関わらず同じ種別になることを確認
    const jaMessage = new NoDriveUrlError('Driveのファイル未検出（日本語想定文言）');
    const enMessage = new NoDriveUrlError('Could not resolve a Drive file id (English wording)');
    assert.equal(classifyFulltextAiFailure(jaMessage), 'no_drive_url');
    assert.equal(classifyFulltextAiFailure(enMessage), 'no_drive_url');
});

test('classifyFulltextAiFailure: PDF読み取り失敗（PdfReadError）は pdf', () => {
    assert.equal(classifyFulltextAiFailure(new PdfReadError(new Error('corrupt'))), 'pdf');
});

test('classifyFulltextAiFailure: PDFサイズ超過（PdfTooLargeError）は pdf', () => {
    assert.equal(classifyFulltextAiFailure(new PdfTooLargeError('PDFが大きすぎます')), 'pdf');
});

test('classifyFulltextAiFailure: Gemini呼び出し失敗（GeminiApiError相当）は llm', () => {
    const err = { name: 'GeminiApiError', message: 'timeout' };
    assert.equal(classifyFulltextAiFailure(err), 'llm');
});

test('classifyFulltextAiFailure: Gemini呼び出し中の未分類エラーをラップした LlmCallError は llm', () => {
    assert.equal(classifyFulltextAiFailure(new LlmCallError(new Error('empty response'))), 'llm');
});

test('LlmCallError: 元エラーの message を引き継ぐ（ログ表示を変えないため）', () => {
    const original = new Error('response.body が空でした');
    const wrapped = new LlmCallError(original);
    assert.equal(wrapped.message, original.message);
    assert.equal(wrapped.cause, original);
});

test('LlmCallError: message を明示指定すればそちらを使う', () => {
    const wrapped = new LlmCallError(undefined, 'カスタムメッセージ');
    assert.equal(wrapped.message, 'カスタムメッセージ');
});

test('classifyFulltextAiFailure: Drive認証切れ（DriveAuthError, 401）は drive_auth', () => {
    const err = { name: 'DriveAuthError' };
    assert.equal(classifyFulltextAiFailure(err), 'drive_auth');
});

test('classifyFulltextAiFailure: Drive一時エラー（DriveTransientError, 5xx/429/レート制限403）は drive_transient', () => {
    const err = { name: 'DriveTransientError' };
    assert.equal(classifyFulltextAiFailure(err), 'drive_transient');
});

test('classifyFulltextAiFailure: それ以外の Error は other', () => {
    assert.equal(classifyFulltextAiFailure(new Error('unexpected')), 'other');
});

test('classifyFulltextAiFailure: null / undefined / 非オブジェクトも other に倒す', () => {
    assert.equal(classifyFulltextAiFailure(null), 'other');
    assert.equal(classifyFulltextAiFailure(undefined), 'other');
    assert.equal(classifyFulltextAiFailure('plain string'), 'other');
    assert.equal(classifyFulltextAiFailure(42), 'other');
});

// ---------------------------------------------------------------------------
// summarizeFailures
// ---------------------------------------------------------------------------

test('summarizeFailures: 合計件数と種別ごとの内訳を返す', () => {
    const kinds: FulltextAiFailureKind[] = ['drive_denied', 'drive_denied', 'llm', 'other'];
    assert.deepEqual(summarizeFailures(kinds), {
        failedCount: 4,
        breakdown: { drive_denied: 2, llm: 1, other: 1 },
    });
});

test('summarizeFailures: 空配列は0件・空内訳', () => {
    assert.deepEqual(summarizeFailures([]), { failedCount: 0, breakdown: {} });
});

// ---------------------------------------------------------------------------
// serializeFailureBreakdown / parseFailureBreakdown
// ---------------------------------------------------------------------------

test('serializeFailureBreakdown: 0件の種別はキーごと落とす', () => {
    const json = serializeFailureBreakdown({ drive_denied: 3, llm: 0, pdf: 0, other: 1 });
    assert.deepEqual(JSON.parse(json), { drive_denied: 3, other: 1 });
});

test('serializeFailureBreakdown: 空/全0件なら空文字を返す', () => {
    assert.equal(serializeFailureBreakdown({}), '');
    assert.equal(serializeFailureBreakdown({ drive_denied: 0, llm: 0 }), '');
});

test('parseFailureBreakdown: 未定義/空文字は空オブジェクト', () => {
    assert.deepEqual(parseFailureBreakdown(undefined), {});
    assert.deepEqual(parseFailureBreakdown(''), {});
});

test('parseFailureBreakdown: 壊れたJSONは握りつぶして空オブジェクト', () => {
    assert.deepEqual(parseFailureBreakdown('{not valid json'), {});
    assert.deepEqual(parseFailureBreakdown('[1,2,3]'), {});
    assert.deepEqual(parseFailureBreakdown('"just a string"'), {});
});

test('parseFailureBreakdown: 想定外のキーは無視する（シート直編集対策）', () => {
    assert.deepEqual(
        parseFailureBreakdown('{"drive_denied":2,"totally_unknown_kind":5}'),
        { drive_denied: 2 }
    );
});

test('parseFailureBreakdown: 数値でない値は無視する', () => {
    assert.deepEqual(
        parseFailureBreakdown('{"drive_denied":"two","llm":3,"pdf":null,"other":[1,2]}'),
        { llm: 3 }
    );
});

test('parseFailureBreakdown: ラウンドトリップ（serialize → parse で一致、全種別）', () => {
    const original: Partial<Record<FulltextAiFailureKind, number>> = {
        drive_denied: 3, drive_not_found: 1, drive_auth: 1, drive_transient: 2,
        no_drive_url: 2, pdf: 1, llm: 4, other: 1
    };
    const roundTripped = parseFailureBreakdown(serializeFailureBreakdown(original));
    assert.deepEqual(roundTripped, original);
});

test('parseFailureBreakdown: 0件の種別を含めて保存した場合もラウンドトリップで一致する（0は落ちる）', () => {
    const original: Partial<Record<FulltextAiFailureKind, number>> = { drive_denied: 5, llm: 0 };
    const roundTripped = parseFailureBreakdown(serializeFailureBreakdown(original));
    assert.deepEqual(roundTripped, { drive_denied: 5 });
});
