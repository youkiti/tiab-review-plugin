import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeAiBatchRun } from '../src/sidepanel/features/fulltext/ai-batch-run';
import type { AiBatchRunDeps, AiBatchRunParams } from '../src/sidepanel/features/fulltext/ai-batch-run';
import { createBulkWriter } from '../src/sidepanel/features/fulltext/bulk-run';
import type { BulkWriterDeps } from '../src/sidepanel/features/fulltext/bulk-run';
import type { LlmExecution, ReferenceWithStatus } from '../src/lib/types';
import type { PublicationCandidateDraft } from '../src/lib/publication-suggest';

/**
 * 全文タブの戻る・ログアウトの中止と宛先の検査（DOM を使わない部分）。
 * 実行本体を DOM から切り出した ai-batch-run.ts・bulk-run.ts を、模型の依存で動かす。
 */

function ref(id: string): ReferenceWithStatus {
    return { ref_id: id, title: `title-${id}` } as ReferenceWithStatus;
}

interface AiHarness {
    params: AiBatchRunParams;
    deps: AiBatchRunDeps;
    calls: string[];
    judged: string[];
    /** isCurrentRun が返す値を切り替える（戻る・ログアウトの初期化を模す） */
    setCurrent: (value: boolean) => void;
}

function aiHarness(options: { targets: string[]; onJudge?: (id: string, h: AiHarness) => void }): AiHarness {
    const calls: string[] = [];
    const judged: string[] = [];
    let current = true;
    const run = { cancelled: false };
    const initialExecution = { execution_id: 'exec-1' } as LlmExecution;
    const harness: AiHarness = {
        calls,
        judged,
        setCurrent: value => { current = value; },
        params: {
            spreadsheetId: 'sheet-A',
            reviewerId: 'llm:model@t',
            executionId: 'exec-1',
            targets: options.targets.map(ref),
            run,
            isCurrentRun: () => current,
            initialExecution,
            executionLogWritten: true,
        },
        deps: {
            judgeOne: async r => {
                judged.push(r.ref_id);
                options.onJudge?.(r.ref_id, harness);
                return { decision: 'include', evidenceTruncated: false };
            },
            setFulltextAiActiveRound: async (sid, id) => { calls.push(`adopt:${sid}:${id}`); },
            updateLlmExecution: async (sid, eid) => { calls.push(`updateExecution:${sid}:${eid}`); },
            saveLlmExecution: async sid => { calls.push(`saveExecution:${sid}`); },
            reloadReferences: async sid => { calls.push(`reload:${sid}`); },
            showToast: msg => { calls.push(`toast:${msg}`); },
            appendLog: text => { calls.push(`log:${text}`); },
            updateProgress: (done, total) => { calls.push(`progress:${done}/${total}`); },
            finishUi: () => { calls.push('finishUi'); },
            clearRun: () => { calls.push('clearRun'); },
        },
    };
    return harness;
}

const uiCalls = (calls: string[]): string[] =>
    calls.filter(c => /^(log|progress|toast|finishUi|clearRun)/.test(c));

test('全文の AI 一括判定: 中断されなければ全件を判定し、採用・実行記録・画面の戻しが行われる', async () => {
    const h = aiHarness({ targets: ['r1', 'r2'] });
    const result = await executeAiBatchRun(h.params, h.deps);
    assert.deepEqual(h.judged, ['r1', 'r2']);
    assert.deepEqual(result, { ok: 2, ng: 0 });
    assert.ok(h.calls.includes('adopt:sheet-A:llm:model@t'));
    assert.ok(h.calls.includes('updateExecution:sheet-A:exec-1'));
    assert.ok(h.calls.includes('finishUi'));
    assert.ok(h.calls.includes('clearRun'));
});

test('全文の AI 一括判定: 実行中に初期化されると次の文献へ進まず、採用せず、実行記録は開始時のシートへ書く', async () => {
    const h = aiHarness({
        targets: ['r1', 'r2', 'r3'],
        // 1件目の判定の最中に戻る・ログアウトが起きた状況（resetFulltextAiSession と同じ: cancelled を立て、現役でなくなる）
        onJudge: (id, harness) => {
            if (id === 'r1') {
                harness.params.run.cancelled = true;
                harness.setCurrent(false);
            }
        },
    });
    const result = await executeAiBatchRun(h.params, h.deps);
    // 実行中の1件は終わるまで続くが、次へは進まない
    assert.deepEqual(h.judged, ['r1']);
    assert.deepEqual(result, { ok: 1, ng: 0 });
    // ラウンドは採用されない
    assert.equal(h.calls.some(c => c.startsWith('adopt:')), false);
    // 実行記録の確定と参照の読み直しは開始時の spreadsheetId で行う
    assert.ok(h.calls.includes('updateExecution:sheet-A:exec-1'));
    assert.ok(h.calls.includes('reload:sheet-A'));
});

test('全文の AI 一括判定: 現役でなくなった後は、ログ・進み具合・ボタン・トースト・実行の印の解除をしない', async () => {
    const h = aiHarness({
        targets: ['r1', 'r2'],
        onJudge: (id, harness) => {
            if (id === 'r1') {
                harness.calls.push('RESET');
                harness.params.run.cancelled = true;
                harness.setCurrent(false);
            }
        },
    });
    await executeAiBatchRun(h.params, h.deps);
    const afterReset = h.calls.slice(h.calls.indexOf('RESET'));
    assert.deepEqual(uiCalls(afterReset), []);
    // 初期化より前（開始時）の画面の書き換えは行われている
    assert.ok(h.calls.some(c => c.startsWith('progress:0/')));
    // 終了処理の画面の書き換えは一度も行われない
    assert.equal(h.calls.includes('finishUi'), false);
    assert.equal(h.calls.includes('clearRun'), false);
    assert.equal(h.calls.some(c => c.startsWith('toast:')), false);
});

test('全文の AI 一括判定: 中止ボタンと同じ（現役のまま cancelled だけ立つ）なら、採用しないが画面は戻す', async () => {
    const h = aiHarness({
        targets: ['r1', 'r2'],
        onJudge: (id, harness) => { if (id === 'r1') harness.params.run.cancelled = true; },
    });
    await executeAiBatchRun(h.params, h.deps);
    assert.deepEqual(h.judged, ['r1']);
    assert.equal(h.calls.some(c => c.startsWith('adopt:')), false);
    assert.ok(h.calls.includes('finishUi'));
    assert.ok(h.calls.includes('clearRun'));
});

// ---------------------------------------------------------------------------
// 一括 OA 検索の書き込み先
// ---------------------------------------------------------------------------

test('一括 OA 検索の書き込み: 実行中に現在のプロジェクトが変わっても、宛先は開始時の spreadsheetId のまま', async () => {
    // 現在開いているプロジェクト（state.spreadsheetId の代わり）を、途中で A から B に変える
    let currentProject = 'sheet-A';
    const seen: string[] = [];
    const deps: BulkWriterDeps = {
        ensureFulltextFolder: async sid => { seen.push(`folder:${sid}`); return 'folder-id'; },
        updateReferenceFulltextUrls: async sid => { seen.push(`urls:${sid}`); },
        savePublicationCandidates: async sid => { seen.push(`candidates:${sid}`); },
        describeDriveAccessError: () => null,
        showToast: () => {},
    };
    // 開始時に控えた値で作る
    const writer = createBulkWriter(currentProject, deps);

    currentProject = 'sheet-B'; // 実行中に戻って別のプロジェクトを開いた
    await writer.ensureFolder();
    await writer.ensureFolder(); // 2回目は使い回す
    writer.pendingWrites.push({ refId: 'r1', fulltextUrl: 'u', status: 'cached', driveSource: null });
    writer.pendingCandidates.push({ refId: 'r1', trialId: 'NCT1', strategy: 'ctgov_reference' } as PublicationCandidateDraft);
    await writer.flush();

    assert.deepEqual(seen, ['folder:sheet-A', 'urls:sheet-A', 'candidates:sheet-A']);
    assert.equal(currentProject, 'sheet-B');
    // 保存できた分はバッファから消える
    assert.equal(writer.pendingWrites.length, 0);
    assert.equal(writer.pendingCandidates.length, 0);
});

test('一括 OA 検索の書き込み: 候補の保存に失敗したらバッファに残し、次の flush で同じ宛先へ再送する', async () => {
    let fail = true;
    const seen: string[] = [];
    const writer = createBulkWriter('sheet-A', {
        ensureFulltextFolder: async () => 'f',
        updateReferenceFulltextUrls: async () => {},
        savePublicationCandidates: async sid => {
            seen.push(sid);
            if (fail) throw new Error('quota');
        },
        describeDriveAccessError: () => null,
        showToast: () => {},
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        writer.pendingCandidates.push({ refId: 'r1', trialId: 'NCT1', strategy: 'ctgov_reference' } as PublicationCandidateDraft);
        assert.equal(await writer.flushCandidates(), false);
        assert.equal(writer.pendingCandidates.length, 1);
        fail = false;
        assert.equal(await writer.flushCandidates(), true);
        assert.equal(writer.pendingCandidates.length, 0);
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(seen, ['sheet-A', 'sheet-A']);
});

test('tab.ts の一括処理（取得・再探索）は、開始時の1回の控え以外で state.spreadsheetId を読まない', () => {
    const source = readFileSync('src/sidepanel/features/fulltext/tab.ts', 'utf8');
    for (const name of ['handleBulkFetch', 'handleBulkSuggest', 'fetchSingleFulltextForRef', 'handleUploadChange']) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `${name} が見つからない`);
        const next = source.indexOf('\n}\n', start);
        const body = source.slice(start, next);
        const reads = body.split('\n').filter(line => /state\.spreadsheetId/.test(line) && !line.trim().startsWith('//'));
        assert.deepEqual(
            reads.map(line => line.trim()),
            ['const spreadsheetId = state.spreadsheetId;'],
            `${name} の中の state.spreadsheetId の読み取り`
        );
    }
});
