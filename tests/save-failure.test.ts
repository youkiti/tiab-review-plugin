import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifySaveFailure,
    shouldAttemptReauth,
    shouldRetryAfterReauth,
    pickSaveFailureToast,
} from '../src/lib/save-failure';
import { SheetsAccessDeniedError } from '../src/lib/sheets-api';

// 判定保存失敗の分類（classifySaveFailure）のユニットテスト。
// 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応の一環で追加。

test('online=false なら常に offline', () => {
    assert.equal(classifySaveFailure(new Error('interaction_required'), false), 'offline');
    assert.equal(classifySaveFailure(new Error('anything'), false), 'offline');
});

test('interaction_required を含むエラーは auth', () => {
    assert.equal(classifySaveFailure(new Error('interaction_required'), true), 'auth');
});

test('401 を含むエラーメッセージは auth', () => {
    assert.equal(classifySaveFailure(new Error('Failed to append: 401 Unauthorized'), true), 'auth');
});

test('unauthorized / invalid (authentication) credentials / invalid_grant / access token を含むエラーは auth', () => {
    assert.equal(classifySaveFailure(new Error('Request failed: Unauthorized'), true), 'auth');
    assert.equal(classifySaveFailure(new Error('invalid credentials supplied'), true), 'auth');
    assert.equal(classifySaveFailure(new Error('invalid_grant'), true), 'auth');
    // Sheets API (Google) の実際の401本文
    assert.equal(
        classifySaveFailure(
            new Error('Failed to append rows: Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.'),
            true
        ),
        'auth'
    );
    assert.equal(classifySaveFailure(new Error('missing access token'), true), 'auth');
});

test('Unexpected token のようなJSONパースエラーは auth と誤判定しない（裸の token では拾わない）', () => {
    // response.json() が HTML エラーページ等のパースに失敗したときに出るメッセージの再現
    assert.equal(
        classifySaveFailure(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), true),
        'other'
    );
    assert.equal(classifySaveFailure(new Error('token expired'), true), 'other');
});

test('SheetsAccessDeniedError（403/404）は権限不足のため other', () => {
    const error403 = new SheetsAccessDeniedError('sheet-1', 403);
    const error404 = new SheetsAccessDeniedError('sheet-1', 404);
    assert.equal(classifySaveFailure(error403, true), 'other');
    assert.equal(classifySaveFailure(error404, true), 'other');
});

test('汎用の Error は other', () => {
    assert.equal(classifySaveFailure(new Error('quota exceeded'), true), 'other');
    assert.equal(classifySaveFailure(new Error('Failed to update range: 500 Internal Server Error'), true), 'other');
});

test('非 Error 値も String化してメッセージ判定される', () => {
    assert.equal(classifySaveFailure('interaction_required', true), 'auth');
    assert.equal(classifySaveFailure({ message: 'not an Error instance' }, true), 'other');
    assert.equal(classifySaveFailure(null, true), 'other');
});

// 判定クリック起点の再ログイン導線（shouldAttemptReauth / shouldRetryAfterReauth）のユニットテスト。

test('shouldAttemptReauth は auth のときだけ true', () => {
    assert.equal(shouldAttemptReauth('auth'), true);
    assert.equal(shouldAttemptReauth('offline'), false);
    assert.equal(shouldAttemptReauth('other'), false);
});

test('shouldRetryAfterReauth は auth かつ再ログイン成功のときだけ true', () => {
    assert.equal(shouldRetryAfterReauth('auth', true), true);
    assert.equal(shouldRetryAfterReauth('auth', false), false);
    assert.equal(shouldRetryAfterReauth('offline', true), false);
    assert.equal(shouldRetryAfterReauth('other', true), false);
});

// 種類別トーストメッセージ（pickSaveFailureToast）のユニットテスト。

test('pickSaveFailureToast: auth は再ログイン導線メッセージ・5000ms', () => {
    assert.deepEqual(pickSaveFailureToast('auth'), {
        messageKey: 'screening_reloginQueued',
        duration: 5000,
    });
});

test('pickSaveFailureToast: offline は既存の未送信メッセージ・既定2000ms', () => {
    assert.deepEqual(pickSaveFailureToast('offline'), {
        messageKey: 'screening_offlineQueued',
        duration: 2000,
    });
});

test('pickSaveFailureToast: other は保存失敗メッセージ・5000ms', () => {
    assert.deepEqual(pickSaveFailureToast('other'), {
        messageKey: 'screening_saveFailedQueued',
        duration: 5000,
    });
});
