import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyFulltextRefUpdate, buildFulltextRefUpdatedMessage, parseFulltextRefUpdatedMessage,
} from '../src/lib/fulltext-ref-update';
import type { FulltextStatus, Reference } from '../src/lib/types';

const message = buildFulltextRefUpdatedMessage('project-a', 'ref-a', 'https://example.com/pdf', 'cached');

test('全文更新通知を組み立て、既知の全取得状態を受け取れる', () => {
    assert.deepEqual(message, {
        type: 'fulltext:ref-updated', spreadsheetId: 'project-a', refId: 'ref-a',
        fulltextUrl: 'https://example.com/pdf', fulltextStatus: 'cached',
    });
    const statuses: FulltextStatus[] = ['not_retrieved', 'cached', 'retrieved', 'unavailable'];
    for (const status of statuses) {
        const update = buildFulltextRefUpdatedMessage('project-a', 'ref-a', '', status);
        assert.deepEqual(parseFulltextRefUpdatedMessage(update, 'project-a'), update);
    }
});

test('別の通知・プロジェクト・未知の取得状態は受け取らない', () => {
    assert.equal(parseFulltextRefUpdatedMessage({ ...message, type: 'team-progress:decision-saved' }, 'project-a'), null);
    assert.equal(parseFulltextRefUpdatedMessage(message, 'project-b'), null);
    assert.equal(parseFulltextRefUpdatedMessage({ ...message, fulltextStatus: 'linked' }, 'project-a'), null);
});

test('通知のフィールド欠落・型違い・オブジェクト以外は受け取らない', () => {
    for (const key of Object.keys(message)) {
        const missing: Record<string, unknown> = { ...message };
        delete missing[key];
        assert.equal(parseFulltextRefUpdatedMessage(missing, 'project-a'), null, key);
        for (const value of [null, 42, false, {}, []]) {
            assert.equal(parseFulltextRefUpdatedMessage({ ...message, [key]: value }, 'project-a'), null, key);
        }
    }
    for (const value of [null, undefined, false, 42, 'message', []]) {
        assert.equal(parseFulltextRefUpdatedMessage(value, 'project-a'), null);
    }
});

test('一致する文献だけをその場で更新し、Drive取り込み元・コピーIDをクリアする', () => {
    const matching: Reference = {
        ref_id: 'ref-a', title: '対象文献', fulltext_url: 'old', fulltext_status: 'unavailable',
        fulltext_drive_source_id: 'source', fulltext_drive_copy_id: 'copy',
    };
    const other: Reference = { ...matching, ref_id: 'ref-b' };
    const originalOther = { ...other };
    const refs = [other, matching];
    assert.equal(applyFulltextRefUpdate(refs, message), true);
    assert.equal(refs[1], matching);
    assert.deepEqual(matching, {
        ref_id: 'ref-a', title: '対象文献', fulltext_url: message.fulltextUrl, fulltext_status: 'cached',
        fulltext_drive_source_id: undefined, fulltext_drive_copy_id: undefined,
    });
    assert.deepEqual(other, originalOther);
    assert.equal(applyFulltextRefUpdate(refs, buildFulltextRefUpdatedMessage('project-a', 'ref-a', '', 'not_retrieved')), true);
    assert.equal(matching.fulltext_url, '');
    assert.equal(matching.fulltext_status, 'not_retrieved');
});

test('対象の文献がなければ変更せずfalseを返す', () => {
    const refs: Reference[] = [{ ref_id: 'ref-b', title: '別の文献' }];
    assert.equal(applyFulltextRefUpdate(refs, message), false);
    assert.deepEqual(refs, [{ ref_id: 'ref-b', title: '別の文献' }]);
    assert.equal(applyFulltextRefUpdate([], message), false);
});
