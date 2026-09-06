import test from 'node:test';
import assert from 'node:assert/strict';
import {
    discoverCandidatesForRerun,
    flushCandidateBuffer,
    nextCandidateFlushThreshold,
} from '../src/lib/publication-candidate-rerun';
import type { RerunTrial } from '../src/lib/publication-candidate-rerun';
import { isRegistrationRecord } from '../src/lib/registry-record';
import type { PublicationCandidateDraft } from '../src/lib/publication-suggest';
import type { FulltextStatus } from '../src/lib/types';

// Issue #118 チャンク2、PR #122 レビュー指摘2: 「候補探索が取得状態から独立して再実行できない」の修正の
// 回帰テスト。UI（dom/state）に依存しない純粋部分（src/lib/publication-candidate-rerun.ts）と、
// 対象行選定に使う isRegistrationRecord() の fulltext_status 非依存性を検証する。
// features/fulltext/tab.ts の handleBulkSuggest() 自体はdom/state依存のためここではテストしない
// （このリポジトリの既存の流儀。tests/drive-import-suggestion.test.ts 等も同様に切り出した
// 純粋部分だけをテストしている）。

function draft(overrides: Partial<PublicationCandidateDraft> = {}): PublicationCandidateDraft {
    return { refId: 'ref-1', trialId: 'NCT12345678', strategy: 'ctgov_reference', ...overrides };
}

// ---------------------------------------------------------------------------
// 対象行選定: isRegistrationRecord() は fulltext_status を見ない
// （handleBulkSuggest の対象フィルタ `.filter(isRegistrationRecord)` が実際に使う関数そのもの）
// ---------------------------------------------------------------------------

test('対象行選定: registration行はfulltext_statusがcached/retrieved/unavailable/not_retrievedのいずれでも対象になる', () => {
    const statuses: FulltextStatus[] = ['cached', 'retrieved', 'unavailable', 'not_retrieved'];
    for (const fulltext_status of statuses) {
        const ref = { record_type: 'registration' as const, journal: 'ClinicalTrials.gov', source: 'ClinicalTrials.gov', fulltext_status };
        assert.equal(isRegistrationRecord(ref), true, `fulltext_status=${fulltext_status} でも対象になるべき`);
    }
});

test('対象行選定: 非registration行（通常論文）はfulltext_statusによらず対象にならない', () => {
    const statuses: FulltextStatus[] = ['cached', 'retrieved', 'unavailable', 'not_retrieved'];
    for (const fulltext_status of statuses) {
        const ref = { record_type: 'article' as const, journal: 'The Lancet', source: 'PubMed', fulltext_status };
        assert.equal(isRegistrationRecord(ref), false, `通常論文はfulltext_status=${fulltext_status}でも対象にならない`);
    }
});

// ---------------------------------------------------------------------------
// discoverCandidatesForRerun
// ---------------------------------------------------------------------------

test('discoverCandidatesForRerun: kind=nct かつ fetchCtgが pmids を返す -> discoverCandidatesにそのままctgPmidsとして渡る', async () => {
    const trial: RerunTrial = { id: 'NCT12345678', kind: 'nct' };
    let fetchCtgCalledWith: string | null = null;
    let discoverCalledWith: string[] | null = null;

    const result = await discoverCandidatesForRerun(
        trial,
        async (ctgPmids) => { discoverCalledWith = ctgPmids; return [draft({ pmid: '111' })]; },
        async (nctId) => { fetchCtgCalledWith = nctId; return { pmids: ['999', '888'] }; }
    );

    assert.equal(fetchCtgCalledWith, 'NCT12345678');
    assert.deepEqual(discoverCalledWith, ['999', '888']);
    assert.deepEqual(result, [draft({ pmid: '111' })]);
});

test('discoverCandidatesForRerun: kind=nct かつ fetchCtgがnullを返す(CTG API失敗) -> ctgPmids:[]でdiscoverCandidatesは続行する', async () => {
    const trial: RerunTrial = { id: 'NCT12345678', kind: 'nct' };
    let discoverCalledWith: string[] | null = null;
    let discoverWasCalled = false;

    const result = await discoverCandidatesForRerun(
        trial,
        async (ctgPmids) => { discoverWasCalled = true; discoverCalledWith = ctgPmids; return [draft({ pmid: '222' })]; },
        async () => null
    );

    assert.equal(discoverWasCalled, true, 'CTG API失敗でも他戦略の探索(discoverCandidates)は続くこと');
    assert.deepEqual(discoverCalledWith, []);
    assert.deepEqual(result, [draft({ pmid: '222' })]);
});

test('discoverCandidatesForRerun: kind=other（非NCT） -> fetchCtgを呼ばずctgPmids:[]で探索が走る', async () => {
    const trial: RerunTrial = { id: 'jRCT1031210123', kind: 'other' };
    let fetchCtgWasCalled = false;
    let discoverCalledWith: string[] | null = null;

    const result = await discoverCandidatesForRerun(
        trial,
        async (ctgPmids) => { discoverCalledWith = ctgPmids; return [draft({ pmid: '333', trialId: trial.id })]; },
        async () => { fetchCtgWasCalled = true; return { pmids: ['should-not-be-used'] }; }
    );

    assert.equal(fetchCtgWasCalled, false, '非NCTはfetchCtgStudyを呼んではいけない');
    assert.deepEqual(discoverCalledWith, []);
    assert.deepEqual(result, [draft({ pmid: '333', trialId: trial.id })]);
});

test('discoverCandidatesForRerun: discoverCandidatesが例外を投げても空配列を返す（一括ループを止めない）', async () => {
    const trial: RerunTrial = { id: 'NCT12345678', kind: 'nct' };
    const result = await discoverCandidatesForRerun(
        trial,
        async () => { throw new Error('network error'); },
        async () => ({ pmids: [] })
    );
    assert.deepEqual(result, []);
});

test('discoverCandidatesForRerun: fetchCtgが例外を投げても空配列を返す（念のための二重防御）', async () => {
    const trial: RerunTrial = { id: 'NCT12345678', kind: 'nct' };
    const result = await discoverCandidatesForRerun(
        trial,
        async () => [draft({ pmid: 'unreachable' })],
        async () => { throw new Error('CTG API down'); }
    );
    assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// flushCandidateBuffer: 保存失敗でバッファを捨てない（PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点））
// ---------------------------------------------------------------------------

test('flushCandidateBuffer: バッファが空ならsaveを呼ばずtrueを返す', async () => {
    const buffer: PublicationCandidateDraft[] = [];
    let saveCalled = false;
    const ok = await flushCandidateBuffer(buffer, async () => { saveCalled = true; });
    assert.equal(ok, true);
    assert.equal(saveCalled, false);
});

test('flushCandidateBuffer: 保存成功時はバッファを空にしてtrueを返す', async () => {
    const buffer: PublicationCandidateDraft[] = [draft({ pmid: '1' }), draft({ pmid: '2' })];
    const savedBatches: PublicationCandidateDraft[][] = [];
    const ok = await flushCandidateBuffer(buffer, async (items) => { savedBatches.push(items); });
    assert.equal(ok, true);
    assert.deepEqual(buffer, []);
    assert.equal(savedBatches.length, 1);
    assert.equal(savedBatches[0].length, 2);
});

test('flushCandidateBuffer: save()が投げたらバッファを保持し、次回flushで再送されることfalseを返す', async () => {
    const buffer: PublicationCandidateDraft[] = [draft({ pmid: '1' })];
    const ok = await flushCandidateBuffer(buffer, async () => { throw new Error('sheets write failed'); });
    assert.equal(ok, false);
    assert.deepEqual(buffer, [draft({ pmid: '1' })], '保存失敗時にバッファが消えてはいけない');
});

test('flushCandidateBuffer: 失敗後に新しい候補が積まれても、次のflushで先の分と合わせて再送される', async () => {
    const buffer: PublicationCandidateDraft[] = [draft({ pmid: '1' })];
    let attempt = 0;
    const savedBatches: PublicationCandidateDraft[][] = [];
    const save = async (items: PublicationCandidateDraft[]) => {
        attempt++;
        if (attempt === 1) throw new Error('temporary failure');
        savedBatches.push(items);
    };

    const first = await flushCandidateBuffer(buffer, save);
    assert.equal(first, false);
    assert.deepEqual(buffer, [draft({ pmid: '1' })]);

    // 失敗後に新しい候補が積まれる想定（一括ループの次の行で見つかった候補）
    buffer.push(draft({ pmid: '2' }));

    const second = await flushCandidateBuffer(buffer, save);
    assert.equal(second, true);
    assert.deepEqual(buffer, []);
    assert.equal(savedBatches.length, 1);
    assert.deepEqual(savedBatches[0].map(c => c.pmid), ['1', '2'], '先に失敗した分も含めて再送されること');
});

test('flushCandidateBuffer: 保存失敗が続く限りバッファは減らない（複数回の再送シミュレーション）', async () => {
    const buffer: PublicationCandidateDraft[] = [draft({ pmid: 'x' })];
    const save = async () => { throw new Error('still failing'); };

    for (let i = 0; i < 3; i++) {
        const ok = await flushCandidateBuffer(buffer, save);
        assert.equal(ok, false);
    }
    assert.equal(buffer.length, 1, '何度flushしても保存できなければバッファは保持され続ける');
});

// ---------------------------------------------------------------------------
// nextCandidateFlushThreshold: handleBulkSuggest が保存失敗時に毎行リトライしてしまう
// 問題の修正（PR #122 レビュー指摘2）。flushCandidateBuffer() は失敗時にバッファを保持する
// ため、呼び出し側の閾値を固定のままにすると、バッファが一度基準値を超えた後は
// 「バッファ長 >= 基準値」が恒久的に真になり、以降のループが毎行flushを呼び直してしまう。
// ---------------------------------------------------------------------------

test('nextCandidateFlushThreshold: 保存成功時は基準値（5）に戻る', () => {
    assert.equal(nextCandidateFlushThreshold(12, true), 5);
    assert.equal(nextCandidateFlushThreshold(0, true), 5);
});

test('nextCandidateFlushThreshold: 保存失敗時は「現在のバッファ長 + 基準値」になる', () => {
    assert.equal(nextCandidateFlushThreshold(5, false), 10);
    assert.equal(nextCandidateFlushThreshold(8, false), 13);
});

test('nextCandidateFlushThreshold: baseIntervalを変えても反映される', () => {
    assert.equal(nextCandidateFlushThreshold(5, true, 3), 3);
    assert.equal(nextCandidateFlushThreshold(5, false, 3), 8);
});

test('nextCandidateFlushThreshold: 失敗が続いても、行数に対してflush回数が十分少なく抑えられる', () => {
    // handleBulkSuggest のループを模擬: 1行ごとにバッファへ1件積み、閾値を超えたらflushを試みる
    // （保存は常に失敗する想定＝バッファは減らない）。固定閾値5のままだと、バッファが一度5を
    // 超えた後は毎行flushが呼ばれてしまう（修正前の不具合そのもの）。
    let bufferLength = 0;
    let nextFlushAt = 5;
    let flushAttempts = 0;
    const totalRows = 50;

    for (let i = 0; i < totalRows; i++) {
        bufferLength++;
        if (bufferLength >= nextFlushAt) {
            flushAttempts++;
            nextFlushAt = nextCandidateFlushThreshold(bufferLength, false);
        }
    }

    // 固定閾値5のバグでは行5〜50の46回すべてでflushが呼ばれていたのに対し、閾値が
    // 「バッファ長+5」で単調に伸びる本修正では5件たまるごと（行5,10,...,50）の10回で済む。
    assert.equal(flushAttempts, 10);
    assert.ok(flushAttempts < totalRows / 2, 'flush回数は行数より十分少ないこと（毎行flushしていない証拠）');
});
