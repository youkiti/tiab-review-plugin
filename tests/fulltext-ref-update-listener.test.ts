import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFulltextRefUpdatedMessage } from '../src/lib/fulltext-ref-update';
import type { ReferenceWithStatus } from '../src/lib/types';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { state } from '../src/sidepanel/state';
import { initializeStore } from '../src/sidepanel/store';
import { setReferences, setSpreadsheetId } from '../src/sidepanel/store/compat';
import { setupFulltextRefUpdateListener } from '../src/sidepanel/features/fulltext/ref-update-listener';
import { loadFulltextFeature } from '../src/sidepanel/features/fulltext/lazy';

test('全文更新の受信は未読込でも両配列へ反映し、本体読込後だけ再描画する', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    setPlatform({ onMessage: listener => { listeners.push(listener); } } as PlatformAdapter);
    initializeStore();
    setSpreadsheetId('project-a');
    const ref: ReferenceWithStatus = {
        ref_id: 'ref-a', title: '対象文献', status: 'pending', fulltext_status: 'unavailable',
        fulltext_drive_source_id: 'source', fulltext_drive_copy_id: 'copy',
    };
    const allRef = { ...ref };
    const onlyAll = { ...ref, ref_id: 'ref-b' };
    setReferences([ref]);
    state.setAllReferences([allRef, onlyAll]);
    const modulePath = require.resolve('../src/sidepanel/features/fulltext/tab');
    const originalModule = require.cache[modulePath];
    let setupCalls = 0;
    let renderCalls = 0;
    let statusAtFirstRender: string | undefined;
    // 本体だけを偽物にし、リスナー・状態更新・遅延入口は実装を通す。
    require.cache[modulePath] = {
        exports: {
            setupFulltextTabListeners: () => { setupCalls++; },
            renderFulltextTab: () => {
                renderCalls++;
                statusAtFirstRender ??= state.references[0].fulltext_status;
            },
        },
    } as NodeModule;
    try {
        setupFulltextRefUpdateListener();
        assert.equal(listeners.length, 1);
        const receive = listeners[0];
        const update = buildFulltextRefUpdatedMessage('project-a', 'ref-a', 'https://example.com/pdf', 'cached');
        receive(update);
        for (const updated of [ref, allRef]) {
            assert.equal(updated.fulltext_status, 'cached');
            assert.equal(updated.fulltext_url, update.fulltextUrl);
            assert.equal(updated.fulltext_drive_source_id, undefined);
            assert.equal(updated.fulltext_drive_copy_id, undefined);
        }
        assert.equal(onlyAll.fulltext_status, 'unavailable');
        assert.equal(setupCalls, 0);
        assert.equal(renderCalls, 0);

        const loaded = await loadFulltextFeature();
        loaded.renderFulltextTab();
        assert.equal(setupCalls, 1);
        assert.equal(statusAtFirstRender, 'cached');

        receive({ ...update, spreadsheetId: 'project-b', fulltextStatus: 'unavailable' });
        receive({ ...update, fulltextStatus: 'unknown' });
        receive({ ...update, refId: 'missing' });
        assert.equal(renderCalls, 1);
        assert.equal(ref.fulltext_status, 'cached');
        assert.equal(allRef.fulltext_status, 'cached');

        receive({ ...update, fulltextUrl: '', fulltextStatus: 'not_retrieved' });
        assert.equal(renderCalls, 2);
        assert.equal(ref.fulltext_url, '');
        assert.equal(allRef.fulltext_status, 'not_retrieved');

        receive({ ...update, refId: 'ref-b' });
        assert.equal(onlyAll.fulltext_status, 'cached');
        assert.equal(renderCalls, 3);

        // 両配列が同じオブジェクトを持っていても、描画は通知ごとに一度だけ行う。
        state.setAllReferences([ref]);
        receive(update);
        assert.equal(ref.fulltext_status, 'cached');
        assert.equal(renderCalls, 4);
    } finally {
        state.setAllReferences([]);
        if (originalModule) require.cache[modulePath] = originalModule;
        else delete require.cache[modulePath];
    }
});
