import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_LOG_HEADERS, buildAuditEventRow } from '../src/lib/audit-log';
import type { AuditLogEvent } from '../src/lib/audit-log';

// buildAuditEventRow() は AUDIT_LOG_HEADERS と同じ列順で行配列を組み立てる純関数。
// 列順・値をヘッダー定義と突き合わせて検証する。

test('AUDIT_LOG_HEADERS: 列順が固定されている', () => {
    assert.deepEqual(AUDIT_LOG_HEADERS, [
        'event_id', 'event_type', 'actor', 'occurred_at', 'client_version', 'detail_json',
    ]);
});

test('buildAuditEventRow: AUDIT_LOG_HEADERS と同じ列順で値を返す', () => {
    const event: AuditLogEvent = {
        event_id: 'audit-1',
        event_type: 'key_opened',
        actor: 'alice@example.com',
        occurred_at: '2026-01-01T00:00:00.000Z',
        client_version: '1.2.3-human',
        detail_json: '',
    };
    const row = buildAuditEventRow(event);
    assert.deepEqual(row, [
        'audit-1', 'key_opened', 'alice@example.com', '2026-01-01T00:00:00.000Z', '1.2.3-human', '',
    ]);
    assert.equal(row.length, AUDIT_LOG_HEADERS.length);
});

test('buildAuditEventRow: key_closed イベントも同じ列順で組み立てられる', () => {
    const event: AuditLogEvent = {
        event_id: 'audit-2',
        event_type: 'key_closed',
        actor: 'bob@example.com',
        occurred_at: '2026-01-02T00:00:00.000Z',
        client_version: '1.2.3-human',
    };
    const row = buildAuditEventRow(event);
    assert.deepEqual(row, [
        'audit-2', 'key_closed', 'bob@example.com', '2026-01-02T00:00:00.000Z', '1.2.3-human', '',
    ]);
});

test('buildAuditEventRow: detail_json 省略時は空文字になる', () => {
    const event: AuditLogEvent = {
        event_id: 'audit-3',
        event_type: 'key_opened',
        actor: 'carol@example.com',
        occurred_at: '2026-01-03T00:00:00.000Z',
        client_version: '1.2.3-human',
    };
    const row = buildAuditEventRow(event);
    assert.equal(row[AUDIT_LOG_HEADERS.indexOf('detail_json')], '');
});
