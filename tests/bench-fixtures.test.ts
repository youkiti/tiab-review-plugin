import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildBenchReferences,
    buildBenchDecisionSeeds,
    buildBenchLlmRound,
    BENCH_FULLTEXT_CACHED_REF_ID,
} from '../src/demo/bench-fixtures';
import { isHumanDecision, isLlmDecision } from '../src/lib/client-version';
import {
    DEMO_PDF_FIXTURES,
    DEMO_FULLTEXT_DRIVE_FILE_ID,
    DEMO_FULLTEXT_PDF_RESOURCE_PATH,
    type DemoPdfFixtureId,
} from '../src/demo/constants';

/**
 * buildBenchDecisionSeeds(size) が追加する「フルテキストAI判定（根拠ジャンプ計測用、
 * BENCH_FULLTEXT_CACHED_REF_ID 宛）」の件数（0 または 1）。この判定も screening_phase='fulltext'
 * かつ client_version に '-llm' を含むため isLlmDecision() で true になり、LLM判定の総数に
 * 混じる（Issue #151（#150 工程0）チャンク3b）。target_count ベースのAI一括判定件数との
 * 比較には、この分を差し引く必要がある。
 */
function countBenchFulltextAiExtraSeed(seeds: ReturnType<typeof buildBenchDecisionSeeds>): number {
    return seeds.filter((s) =>
        s.refId === BENCH_FULLTEXT_CACHED_REF_ID
        && s.screeningPhase === 'fulltext'
        && isLlmDecision(s.clientVersion)
    ).length;
}

// Issue #151（#150 工程0）チャンク2: ベンチマーク用合成データ生成のテスト。
// src/demo/seed.ts は sample/*.nbib を raw-text import しているため tsc + node --test の
// 経路から import できない（AGENTS.md「テスト・作業ツリーの落とし穴」参照）。
// bench-fixtures.ts はその制約を避けるため src/lib/types と src/demo/constants.ts にしか
// 依存しておらず、ここから直接 import してテストできる。

test('決定論: buildBenchReferences(1000) は2回呼んでも完全に同じ結果になる', () => {
    const first = buildBenchReferences(1000);
    const second = buildBenchReferences(1000);
    assert.deepEqual(first, second);
});

test('決定論: buildBenchDecisionSeeds(1000) は2回呼んでも完全に同じ結果になる', () => {
    const first = buildBenchDecisionSeeds(1000);
    const second = buildBenchDecisionSeeds(1000);
    assert.deepEqual(first, second);
});

test('件数: buildBenchReferences(n) の件数は複数サイズで常に n', () => {
    for (const size of [0, 1, 37, 1000, 12345]) {
        assert.equal(buildBenchReferences(size).length, size, `size=${size}`);
    }
});

test('構成: 登録情報レコードが全体の約2%（floor）だけ存在し、record_type="registration"を持つ', () => {
    const refs = buildBenchReferences(1000);
    const registrationRefs = refs.filter((ref) => ref.record_type === 'registration');
    // REGISTRATION_FRACTION=0.02 の floor(1000*0.02)=20（bench-fixtures.ts の定義と一致させる）
    assert.equal(registrationRefs.length, 20);
});

test('構成: related_ref_id が非空の行は、実在する登録情報行（record_type="registration"）を指す', () => {
    const refs = buildBenchReferences(1000);
    const byId = new Map(refs.map((ref) => [ref.ref_id, ref]));
    const withRelated = refs.filter((ref) => (ref.related_ref_id || '') !== '');

    assert.ok(withRelated.length > 0, '取り込んだ論文行が1件も無い');
    for (const ref of withRelated) {
        const target = byId.get(ref.related_ref_id as string);
        assert.ok(target, `related_ref_id=${ref.related_ref_id} が References に存在しない`);
        assert.equal(target?.record_type, 'registration', `related_ref_id=${ref.related_ref_id} は registration 行ではない`);
    }
});

test('構成: duplicate_of が非空の行は、生きている(duplicate_of が空の)別の行を指す（自己参照・登録情報行を指さない）', () => {
    const refs = buildBenchReferences(1000);
    const byId = new Map(refs.map((ref) => [ref.ref_id, ref]));
    const duplicates = refs.filter((ref) => (ref.duplicate_of || '') !== '');

    assert.ok(duplicates.length > 0, '重複として論理削除された行が1件も無い');
    for (const ref of duplicates) {
        const survivorId = ref.duplicate_of as string;
        assert.notEqual(survivorId, ref.ref_id, `${ref.ref_id} が自分自身を指している`);
        const survivor = byId.get(survivorId);
        assert.ok(survivor, `duplicate_of=${survivorId} が References に存在しない`);
        assert.equal((survivor?.duplicate_of || ''), '', `duplicate_of=${survivorId} 自体も論理削除されている（生存側ではない）`);
        assert.notEqual(survivor?.record_type, 'registration', `duplicate_of=${survivorId} が登録情報行を指している`);
    }
});

test('判定履歴: 同一 refId+reviewerId+screeningPhase に複数行を持つ ref が存在し、decisionId が互いに異なり、decidedAt で最新行が一意に決まる', () => {
    const seeds = buildBenchDecisionSeeds(1000);
    const groups = new Map<string, typeof seeds>();
    for (const seed of seeds) {
        const key = `${seed.refId}::${seed.reviewerId}::${seed.screeningPhase}`;
        const list = groups.get(key) ?? [];
        list.push(seed);
        groups.set(key, list);
    }

    const multiRowGroups = [...groups.values()].filter((list) => list.length > 1);
    assert.ok(multiRowGroups.length > 0, '判定変更履歴（同一グループに複数行）を持つ ref が1件も無い');

    for (const group of multiRowGroups) {
        const decisionIds = new Set(group.map((s) => s.decisionId));
        assert.equal(decisionIds.size, group.length, 'decisionId が重複している');

        const decidedAts = group.map((s) => s.decidedAt);
        const uniqueDecidedAts = new Set(decidedAts);
        assert.equal(uniqueDecidedAts.size, decidedAts.length, 'decidedAt が重複しており最新行を一意に決められない');
    }
});

test('判定種別: isHumanDecision() / isLlmDecision() で分類すると human 判定と LLM 判定の両方が存在する', () => {
    const seeds = buildBenchDecisionSeeds(1000);
    const humanSeeds = seeds.filter((s) => isHumanDecision(s.clientVersion));
    const llmSeeds = seeds.filter((s) => isLlmDecision(s.clientVersion));

    assert.ok(humanSeeds.length > 0, 'human 判定が1件も無い');
    assert.ok(llmSeeds.length > 0, 'LLM 判定が1件も無い');
    // human と LLM が同時に true になる行が無いこと（サフィックスの取り違えがないこと）の確認も兼ねる
    for (const seed of seeds) {
        assert.notEqual(isHumanDecision(seed.clientVersion) && isLlmDecision(seed.clientVersion), true);
    }
});

test('フルテキスト判定: screeningPhase==="fulltext" の行が存在する', () => {
    const seeds = buildBenchDecisionSeeds(1000);
    const fulltextSeeds = seeds.filter((s) => s.screeningPhase === 'fulltext');
    assert.ok(fulltextSeeds.length > 0, 'フルテキスト判定が1件も無い');
});

test('AIラウンド: buildBenchLlmRound(size) の run/execution が採用済み（is_active && status="confirmed"）で、run_id/execution_idが判定行と整合する', () => {
    const { run, execution } = buildBenchLlmRound(1000);
    assert.equal(run.is_active, true);
    assert.equal(run.status, 'confirmed');
    assert.equal(execution.is_active, true);
    assert.equal(execution.status, 'confirmed');
    assert.equal(execution.run_id, run.run_id);

    const seeds = buildBenchDecisionSeeds(1000);
    const llmSeeds = seeds.filter((s) => isLlmDecision(s.clientVersion));
    assert.ok(llmSeeds.length > 0);
    for (const seed of llmSeeds) {
        assert.equal(seed.reviewerId, execution.execution_id, 'LLM判定のreviewer_idがexecution_idと一致しない');
    }
});

test('AIラウンド: LLM判定行の件数は複数サイズで buildBenchLlmRound(size).execution.target_count と一致する（根拠ジャンプ計測用のフルテキストAI判定1件を除く）', () => {
    for (const size of [37, 1000, 10000, 50000]) {
        const { execution } = buildBenchLlmRound(size);
        const seeds = buildBenchDecisionSeeds(size);
        const llmSeeds = seeds.filter((s) => isLlmDecision(s.clientVersion));
        // size=37,1000 では BENCH_FULLTEXT_CACHED_REF_ID 宛のフルテキストAI判定
        // （screening_phase='fulltext'）が1件追加されるため、その分を差し引いて比較する
        // （countBenchFulltextAiExtraSeed() のコメント参照。Issue #151（#150 工程0）チャンク3b）。
        const extra = countBenchFulltextAiExtraSeed(seeds);
        assert.equal(llmSeeds.length - extra, execution.target_count, `size=${size}`);
    }
});

test('AIラウンド: LLM判定の include/exclude 内訳が複数サイズで execution.include_count/exclude_count と一致する（根拠ジャンプ計測用のフルテキストAI判定1件を除く）', () => {
    for (const size of [37, 1000, 10000, 50000]) {
        const { execution } = buildBenchLlmRound(size);
        assert.equal(execution.include_count + execution.exclude_count, execution.target_count, `size=${size}: include_count+exclude_count が target_count と一致しない`);

        const seeds = buildBenchDecisionSeeds(size);
        // BENCH_FULLTEXT_CACHED_REF_ID 宛のフルテキストAI判定は screening_phase='fulltext' の
        // AI一括判定（TiAb, screening_phase=''）とは別枠なので、比較対象から除外する。
        const llmSeeds = seeds.filter((s) => isLlmDecision(s.clientVersion) && s.screeningPhase !== 'fulltext');
        const includeSeeds = llmSeeds.filter((s) => s.decision === 'include');
        const excludeSeeds = llmSeeds.filter((s) => s.decision === 'exclude');
        assert.equal(includeSeeds.length, execution.include_count, `size=${size}: includeの件数`);
        assert.equal(excludeSeeds.length, execution.exclude_count, `size=${size}: excludeの件数`);
    }
});

test('根拠ジャンプ計測用フィクスチャ: フルテキスト取得済みのrefがちょうど1件あり、フルテキストAI判定（LLM）のnoteがFulltextLlmDecisionNoteとしてパースでき、evidenceが1件以上ある（Issue #151（#150 工程0）チャンク3b）', () => {
    const refs = buildBenchReferences(1000);
    const cachedRefs = refs.filter((ref) => ref.fulltext_status === 'cached');
    assert.equal(cachedRefs.length, 1, 'フルテキスト取得済みの ref がちょうど1件ではない');
    assert.equal(cachedRefs[0].ref_id, BENCH_FULLTEXT_CACHED_REF_ID);
    assert.ok(cachedRefs[0].fulltext_url, 'fulltext_url が設定されていない');
    assert.ok(cachedRefs[0].fulltext_drive_copy_id, 'fulltext_drive_copy_id が設定されていない');

    const seeds = buildBenchDecisionSeeds(1000);
    const fulltextAiSeeds = seeds.filter((s) =>
        s.refId === BENCH_FULLTEXT_CACHED_REF_ID
        && s.screeningPhase === 'fulltext'
        && isLlmDecision(s.clientVersion)
    );
    assert.equal(fulltextAiSeeds.length, 1, 'フルテキストAI判定（LLM）がちょうど1件ではない');

    const note: { type?: string; evidence?: unknown } = JSON.parse(fulltextAiSeeds[0].note ?? '');
    assert.equal(note.type, 'llm_fulltext', 'noteがFulltextLlmDecisionNote(type=llm_fulltext)としてパースできない');
    assert.ok(Array.isArray(note.evidence) && note.evidence.length > 0, 'evidenceが1件も無い');
});

// ---------------------------------------------------------------------------
// Issue #156（#150 工程5）着手前の準備: ?benchPdf= で選べるPDFフィクスチャ（DEMO_PDF_FIXTURES）。
// PDFバイナリそのものは開かない。テスト対象は「識別子 → Drive ID・evidence」の組み立てロジック。
// ---------------------------------------------------------------------------

test('DEMO_PDF_FIXTURES: "demo" エントリは DEMO_FULLTEXT_DRIVE_FILE_ID / DEMO_FULLTEXT_PDF_RESOURCE_PATH と一致する', () => {
    assert.equal(DEMO_PDF_FIXTURES.demo.driveFileId, DEMO_FULLTEXT_DRIVE_FILE_ID);
    assert.equal(DEMO_PDF_FIXTURES.demo.resourcePath, DEMO_FULLTEXT_PDF_RESOURCE_PATH);
});

test('DEMO_PDF_FIXTURES: driveFileId・resourcePath がそれぞれ3件とも重複しない', () => {
    const fixtures = Object.values(DEMO_PDF_FIXTURES);
    assert.equal(new Set(fixtures.map((f) => f.driveFileId)).size, fixtures.length, 'driveFileId が重複している');
    assert.equal(new Set(fixtures.map((f) => f.resourcePath)).size, fixtures.length, 'resourcePath が重複している');
});

test('buildBenchReferences: pdf 引数でフルテキスト取得済み行の Drive ID が切り替わる（省略時は demo）', () => {
    for (const pdf of ['20p', '57p'] as DemoPdfFixtureId[]) {
        const refs = buildBenchReferences(1000, pdf);
        const cachedRefs = refs.filter((ref) => ref.ref_id === BENCH_FULLTEXT_CACHED_REF_ID);
        assert.equal(cachedRefs.length, 1, `pdf=${pdf}: フルテキスト取得済み行がちょうど1件ではない`);
        const expectedDriveFileId = DEMO_PDF_FIXTURES[pdf].driveFileId;
        assert.equal(cachedRefs[0].fulltext_drive_copy_id, expectedDriveFileId, `pdf=${pdf}: fulltext_drive_copy_id`);
        assert.ok(cachedRefs[0].fulltext_url?.includes(expectedDriveFileId), `pdf=${pdf}: fulltext_url に driveFileId が含まれない`);
    }

    const defaultRefs = buildBenchReferences(1000);
    const defaultCachedRefs = defaultRefs.filter((ref) => ref.ref_id === BENCH_FULLTEXT_CACHED_REF_ID);
    assert.equal(defaultCachedRefs[0].fulltext_drive_copy_id, DEMO_PDF_FIXTURES.demo.driveFileId, '引数省略時は demo の driveFileId になる');
});

/** BENCH_FULLTEXT_CACHED_REF_ID 宛のフルテキストAI判定の note を JSON.parse し、evidence の page 一覧を返す。 */
function fulltextAiEvidencePages(size: number, pdf?: DemoPdfFixtureId): number[] {
    const seeds = pdf === undefined ? buildBenchDecisionSeeds(size) : buildBenchDecisionSeeds(size, pdf);
    const fulltextAiSeeds = seeds.filter((s) =>
        s.refId === BENCH_FULLTEXT_CACHED_REF_ID
        && s.screeningPhase === 'fulltext'
        && isLlmDecision(s.clientVersion));
    assert.equal(fulltextAiSeeds.length, 1, `pdf=${pdf ?? '(省略)'}: フルテキストAI判定がちょうど1件ではない`);
    const note: { evidence?: { page: number }[] } = JSON.parse(fulltextAiSeeds[0].note ?? '');
    assert.ok(Array.isArray(note.evidence));
    return (note.evidence ?? []).map((e) => e.page);
}

test('buildBenchDecisionSeeds: pdf 引数でフルテキストAI判定の根拠(evidence)のpageが切り替わる（省略時は demo）', () => {
    assert.deepEqual(fulltextAiEvidencePages(1000, '20p'), [1, 9, 16]);
    assert.deepEqual(fulltextAiEvidencePages(1000, '57p'), [1, 22, 53]);
    assert.deepEqual(fulltextAiEvidencePages(1000), [1, 2, 3]);
});

test('buildBenchDecisionSeeds: フルテキストAI判定のevidenceのpageは、そのPDFのpageCount以内である（3プロファイルすべて）', () => {
    const profiles: DemoPdfFixtureId[] = ['demo', '20p', '57p'];
    for (const pdf of profiles) {
        const pages = fulltextAiEvidencePages(1000, pdf);
        const pageCount = DEMO_PDF_FIXTURES[pdf].pageCount;
        for (const page of pages) {
            assert.ok(page <= pageCount, `pdf=${pdf}: page=${page} が pageCount=${pageCount} を超えている`);
        }
    }
});

test('決定論: buildBenchReferences(1000, pdf) / buildBenchDecisionSeeds(1000, pdf) は pdf を指定しても2回呼べば同じ結果になる', () => {
    for (const pdf of ['20p', '57p'] as DemoPdfFixtureId[]) {
        assert.deepEqual(buildBenchReferences(1000, pdf), buildBenchReferences(1000, pdf));
        assert.deepEqual(buildBenchDecisionSeeds(1000, pdf), buildBenchDecisionSeeds(1000, pdf));
    }
});
