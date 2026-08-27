import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeTeamProgress,
    shortNameOf,
    percentOf,
    toTeamProgressRef,
    type TeamProgressRef,
} from '../src/lib/team-progress';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';
import type { Decision, AssignmentConfig, Reference } from '../src/lib/types';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';

let seq = 0;
function makeDecision(overrides: Partial<Decision>): Decision {
    seq++;
    return {
        decision_id: `d${seq}`,
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
        client_version: '0.1.0',
        ...overrides,
    };
}

function makeRefs(count: number, setOf?: (i: number) => string): TeamProgressRef[] {
    return Array.from({ length: count }, (_, i) => ({
        ref_id: `ref${i + 1}`,
        screening_set: setOf ? setOf(i) : undefined,
    }));
}

const NO_ASSIGNMENT: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

test('割り振り未設定: 分母は全文献数、判定した文献数がカウントされる', () => {
    const refs = makeRefs(10);
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', decision: 'exclude' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'bob@example.com', decision: 'maybe' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    assert.equal(result.length, 2);
    // 自分が先頭
    assert.equal(result[0].email, 'alice@example.com');
    assert.equal(result[0].isSelf, true);
    assert.equal(result[0].tiabDone, 2);
    assert.equal(result[0].tiabTotal, 10);
    assert.equal(result[1].email, 'bob@example.com');
    assert.equal(result[1].tiabDone, 1);
    assert.equal(result[1].tiabTotal, 10);
});

test('LLM判定・ML自動判定・pending行は進捗にカウントしない', () => {
    const refs = makeRefs(5);
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'llm:gemini@2026-01-01' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', client_version: '0.20.0-ml-auto' }),
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com', decision: 'pending' }),
        // 確定ML判定はカウントする
        makeDecision({ ref_id: 'ref4', reviewer_id: 'alice@example.com', client_version: '0.7.0-ml' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].tiabDone, 1);
});

test('割り振り設定済み: 分母は担当セット（calibration + 割当グループ）内の文献数', () => {
    // ref1-2: calibration, ref3-6: group-1, ref7-10: group-2
    const refs = makeRefs(10, (i) => (i < 2 ? 'calibration' : i < 6 ? 'group-1' : 'group-2'));
    const config: AssignmentConfig = {
        status: 'configured',
        calibrationSize: 2,
        groupCount: 2,
        reviewerMap: {
            'group-1': ['alice@example.com'],
            'group-2': ['bob@example.com'],
        },
    };
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com' }),  // calibration → 分子に入る
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com' }),  // group-1 → 分子に入る
        makeDecision({ ref_id: 'ref7', reviewer_id: 'alice@example.com' }),  // group-2 → 担当外なので分子に入らない
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: config,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(alice.tiabTotal, 6); // calibration 2 + group-1 4
    assert.equal(alice.tiabDone, 2);

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.tiabTotal, 6); // calibration 2 + group-2 4
    assert.equal(bob.tiabDone, 0);
});

test('メンバー発見: 判定がなくても reviewerMap に載っていれば表示される', () => {
    const config: AssignmentConfig = {
        status: 'configured',
        calibrationSize: 0,
        groupCount: 1,
        reviewerMap: { 'group-1': ['Alice@Example.com', 'carol@example.com'] },
    };
    const result = computeTeamProgress({
        refs: makeRefs(3, () => 'group-1'),
        decisions: [],
        assignmentConfig: config,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    // 大文字小文字は正規化され alice と重複しない
    assert.deepEqual(result.map((m) => m.email), ['alice@example.com', 'carol@example.com']);
    assert.equal(result[1].lastDecidedAt, null);
});

test('フルテキスト: ルール設定済みなら共通プールを分母にフェーズ別カウント', () => {
    const refs = makeRefs(5);
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const decisions = [
        // alice が ref1, ref2 を TiAb Include → プールは2件
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', decision: 'include' }),
        // フルテキスト判定: alice は ref1 のみ、bob は ref1, ref2
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', screening_phase: 'fulltext' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'bob@example.com', screening_phase: 'fulltext', decision: 'exclude' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'bob@example.com', screening_phase: 'fulltext', decision: 'exclude' }),
        // プール外のフルテキスト判定はカウントされない
        makeDecision({ ref_id: 'ref5', reviewer_id: 'bob@example.com', screening_phase: 'fulltext' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: rule,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(alice.fulltextTotal, 2);
    assert.equal(alice.fulltextDone, 1);

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.fulltextTotal, 2);
    assert.equal(bob.fulltextDone, 2);
});

test('フルテキスト: 担当割り振り済みでも未割り当て流入分（fulltext_set空+ルール成立）が全員の分母に入る', () => {
    const refs: TeamProgressRef[] = [
        { ref_id: 'ref1', fulltext_set: 'ft-group-1' },
        { ref_id: 'ref2', fulltext_set: 'ft-group-2' },
        // 割り振り後にプールへ新規流入した未割り当て文献（fulltext_set 空）
        { ref_id: 'ref3', fulltext_set: '' },
        // fulltext_set 空だがプールルールも満たさない → 分母に入らない
        { ref_id: 'ref4', fulltext_set: '' },
    ];
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:carol@example.com'],
        threshold: 1,
    };
    const ftAssignment: FulltextAssignmentConfig = {
        status: 'configured',
        groupCount: 2,
        reviewerMap: {
            'ft-group-1': ['alice@example.com'],
            'ft-group-2': ['bob@example.com'],
        },
    };
    const decisions = [
        // carol の TiAb Include により ref3 がプールルールを満たす（未割り当て流入分）
        makeDecision({ ref_id: 'ref3', reviewer_id: 'carol@example.com', decision: 'include' }),
    ];

    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: rule,
        fulltextAssignment: ftAssignment,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(alice.fulltextTotal, 2, 'ref1(担当) + ref3(未割り当て流入) が分母に入る');

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.fulltextTotal, 2, 'ref2(担当) + ref3(未割り当て流入) が分母に入る');
});

// ---------------------------------------------------------------------------
// 回帰テスト（Issue #118 チャンク3）: 取り込んだ論文行（related_ref_id 非空）は
// TiAb票を一切持たないため、poolRule評価だけでは共有プール（fulltextTotal/fulltextDone）から
// 落ちてしまう。isSharedFulltextPoolMember() 自体は related_ref_id を見て候補扱いするが、
// TeamProgressRef（sidepanel側で ReferenceWithStatus から絞り込んで生成する最小形）が
// related_ref_id を運ばないと、型は Pick<Reference, ...> に構造的に適合するため typecheck
// では検出できないまま、配線だけがこの分岐を落としてしまう（実際に一度見落とした）。
//
// 【PR #124 レビュー指摘7】下のテストは computeTeamProgress() の仕様（related_ref_id 非空行を
// TiAb票ゼロでも分母/分子に入れる）を検証する価値はあるが、`TeamProgressRef[]` の
// オブジェクトリテラルを直接手書きしているため、実際に ReferenceWithStatus から
// TeamProgressRef を組み立てる配線（sidepanel/features/team-progress.ts）側で
// related_ref_id を落とす欠陥は再現できない（AGENTS.md「テスト・作業ツリーの落とし穴」参照）。
// その配線を toTeamProgressRef()（src/lib/team-progress.ts）へ切り出し、この下の
// 「toTeamProgressRef」ブロックでその関数自体の入出力を検証することで、実際に絞り込み型を
// 組み立てている場所＝配線の境界でフィールド欠落を検出できるようにしている。
// 以下の手書きリテラルのテストは computeTeamProgress() 自体の仕様テストとして残す。
// ---------------------------------------------------------------------------

test('フルテキスト回帰: 取り込んだ論文行(related_ref_id非空)はTiAb票ゼロでもfulltextTotal/Doneに入る', () => {
    const refs: TeamProgressRef[] = [
        { ref_id: 'ref1' }, // 通常行。alice の TiAb Include により poolRule 成立で分母に入る
        { ref_id: 'ref2', related_ref_id: 'reg-1' }, // 取り込んだ論文行。TiAb判定は一件も無い
        { ref_id: 'ref3' }, // 通常行だが TiAb Include が無く poolRule も不成立 → 分母に入らない
    ];
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const decisions = [
        // ref1 のみ alice が TiAb Include（poolRule成立の唯一の経路）。ref2/ref3 にTiAb判定は無い
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'include' }),
        // alice が ref1・ref2 の両方をフルテキスト判定済み（ref2はTiAb票が無くても判定はできる）
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', screening_phase: 'fulltext' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', screening_phase: 'fulltext' }),
    ];

    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: rule,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(
        alice.fulltextTotal, 2,
        'ref1(poolRule成立) + ref2(取り込み行、TiAb票ゼロでも無条件で分母に入る)。ref3はどちらも満たさないので入らない'
    );
    assert.equal(
        alice.fulltextDone, 2,
        '取り込み行(ref2)をフルテキスト判定すればTiAb票が無くても分子にカウントされる'
    );
});

// ---------------------------------------------------------------------------
// toTeamProgressRef（PR #124 レビュー指摘7）: ReferenceWithStatus → TeamProgressRef の
// 絞り込みを行う唯一の関数（initTeamProgress() / buildFooter() の🔄ボタンの両方がこれを呼ぶ）。
// TeamProgressRef の各フィールドが optional のため、このマッピングからフィールドを1つ
// 落としてもTypeScriptの構造的部分型では検出できない。フィールドごとに個別assertし、
// どれか1つを消してもこのテストが落ちる形にする（＝配線の境界でのテスト）。
// ---------------------------------------------------------------------------

test('toTeamProgressRef: screening_set / fulltext_set / related_ref_id を個別に運ぶ', () => {
    const ref: Reference = {
        ref_id: 'ref1',
        title: 'Some Title',
        screening_set: 'group-a',
        fulltext_set: 'ft-group-1',
        related_ref_id: 'reg-1',
    };
    const result = toTeamProgressRef(ref);
    assert.equal(result.ref_id, 'ref1');
    assert.equal(result.screening_set, 'group-a', 'screening_set が運ばれること');
    assert.equal(result.fulltext_set, 'ft-group-1', 'fulltext_set が運ばれること');
    assert.equal(
        result.related_ref_id, 'reg-1',
        'related_ref_id が運ばれること（isSharedFulltextPoolMember() の無条件候補判定に必須。落とすと本番で一度発火しなくなった実績あり）'
    );
});

test('toTeamProgressRef: 未設定フィールドは値を捏造せず undefined のまま運ぶ', () => {
    const ref: Reference = {
        ref_id: 'ref2',
        title: 'No optional fields',
    };
    const result = toTeamProgressRef(ref);
    assert.equal(result.ref_id, 'ref2');
    assert.equal(result.screening_set, undefined);
    assert.equal(result.fulltext_set, undefined);
    assert.equal(result.related_ref_id, undefined);
});

test('フルテキスト: ルール未設定なら fulltextDone/Total は null', () => {
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions: [makeDecision({ reviewer_id: 'alice@example.com' })],
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].fulltextDone, null);
    assert.equal(result[0].fulltextTotal, null);
});

test('フルテキスト: 担当割り振り済み + poolRule=null でも分母は fulltext_set 非空件数になる（AGENTS.md 仕様: 割り振り or ルールのどちらか設定済みで分母が出る）', () => {
    const refs: TeamProgressRef[] = [
        { ref_id: 'ref1', fulltext_set: 'ft-group-1' },
        { ref_id: 'ref2', fulltext_set: 'ft-group-2' },
        // fulltext_set 空 かつ poolRule も無いので流入分にはならない（誰の分母にも入らない）
        { ref_id: 'ref3', fulltext_set: '' },
    ];
    const ftAssignment: FulltextAssignmentConfig = {
        status: 'configured',
        groupCount: 2,
        reviewerMap: {
            'ft-group-1': ['alice@example.com'],
            'ft-group-2': ['bob@example.com'],
        },
    };

    const result = computeTeamProgress({
        refs,
        decisions: [],
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        fulltextAssignment: ftAssignment,
        userEmail: 'alice@example.com',
    });

    // poolRule が無くても、担当割り振り済みなら fulltext_set 非空件数（自分の担当セット分）が分母になる
    // （修正前は poolRule が無いと常に null で非表示だった）
    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.notEqual(alice.fulltextTotal, null, 'poolRule未設定でも担当割り振り済みなら分母がnullにならない');
    assert.equal(alice.fulltextTotal, 1, '自分の担当セット(ft-group-1=ref1)のみが分母。ref3(未割り当て)はルール不成立なので流入しない');

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.fulltextTotal, 1, '自分の担当セット(ft-group-2=ref2)のみが分母');
});

test('lastDecidedAt: フェーズを問わず最新の判定日時を返す', () => {
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decided_at: '2026-01-01T00:00:00Z' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', screening_phase: 'fulltext', decided_at: '2026-02-01T00:00:00Z' }),
        // pending 行（メモのみ）は最終判定として扱わない
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com', decision: 'pending', decided_at: '2026-03-01T00:00:00Z' }),
    ];
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].lastDecidedAt, '2026-02-01T00:00:00Z');
});

test('同一文献への複数判定行は1件として数える', () => {
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'maybe' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'include' }),
    ];
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].tiabDone, 1);
});

test('shortNameOf / percentOf', () => {
    assert.equal(shortNameOf('alice@example.com'), 'alice');
    assert.equal(shortNameOf('very-long-local-part@example.com'), 'very-long-…');
    assert.equal(percentOf(1, 3), 33);
    assert.equal(percentOf(0, 0), 0);
});
