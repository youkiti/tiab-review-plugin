import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSmartRegex,
    createSmartMatcher,
} from '../src/sidepanel/utils/text';
import {
    buildReferenceSearchText,
    compileSearchMatchers,
    compileTermFilterMatchers,
    matchesSearchTerms,
    applyTextFilters,
} from '../src/sidepanel/utils/search';
import type { ReferenceWithStatus } from '../src/lib/types';
import { getFilteredReferences, getFilterCounts } from '../src/sidepanel/store/selectors';
import type { AppState } from '../src/sidepanel/store/types';

// Issue #152（#150 工程1）:
// タームフィルターAND経路は、g付き正規表現（createSmartRegex）を1本だけ作って
// 全文献で使い回し、lastIndexをリセットしていなかった。RegExp.prototype.test() は
// g付きだとマッチのたびに lastIndex を進めるため、直前の文献でマッチした位置より
// 前を探索できなくなり、本来マッチするはずの文献が偽陰性で落ちていた。
// このファイルは、g無しマッチャー（createSmartMatcher）への差し替えでこの偽陰性が
// 解消されたこと、および正規表現の生成回数が文献数に比例しなくなったことを検証する。

function makeRef(overrides: Partial<ReferenceWithStatus> & { ref_id: string; title: string }): ReferenceWithStatus {
    return {
        status: 'pending',
        abstract: '',
        ...overrides,
    } as ReferenceWithStatus;
}

/**
 * 現行実装（バグ修正前）の AND 経路をそのまま再現したもの。
 * コマンダーの再現データとの一致確認、および「修正後は正しい挙動に一致する」ことの
 * 比較基準として使う。実装本体（filters.ts / selectors.ts）はこの再現とは独立に、
 * createSmartMatcher 経由の新しい絞り込みロジックを使う。
 */
function legacyBuggyAndFilter(refs: ReferenceWithStatus[], terms: string[]): ReferenceWithStatus[] {
    let filtered = refs;
    for (const term of terms) {
        const regex = createSmartRegex(term); // g付き。全文献で使い回す（バグの再現）。
        filtered = filtered.filter(r => {
            const text = buildReferenceSearchText(r);
            return regex.test(text);
        });
    }
    return filtered;
}

test('偽陰性の回帰（Issue #152（#150 工程1））: g付き正規表現のlastIndex未リセットにより、全件がタームを含むのに現行のAND経路では中間の文献が落ちる', () => {
    // コマンダーが現行ロジックを抜き出して実測した再現データ（3件すべてcancerを含む）。
    const refs = [
        makeRef({
            ref_id: '1',
            title: 'A study of cancer in adults',
            abstract: 'cancer is discussed at length here for many words to push lastIndex forward',
        }),
        makeRef({ ref_id: '2', title: 'cancer overview' }),
        makeRef({ ref_id: '3', title: 'cancer basics' }),
    ];

    // 現行（バグあり）実装の再現: 2件しか残らず、'cancer overview' が落ちる。
    const buggyResult = legacyBuggyAndFilter(refs, ['cancer']);
    assert.equal(buggyResult.length, 2, 'コマンダーの再現データと不一致: バグ再現の結果件数が2件ではない');
    assert.deepEqual(buggyResult.map(r => r.ref_id), ['1', '3']);

    // 修正後: g無しマッチャーを使うため、3件すべてが残る（本番と同じ applyTextFilters() を使用）。
    const fixedResult = applyTextFilters(refs, '', [{ term: 'cancer' }], true);
    assert.equal(fixedResult.length, 3);
    assert.deepEqual(fixedResult.map(r => r.ref_id), ['1', '2', '3']);
});

test('createSmartMatcher: 同じマッチャーインスタンスを複数テキストに繰り返し適用しても結果が安定する', () => {
    const matcher = createSmartMatcher('cancer');
    const texts = [
        'cancer is discussed at length here for many words to push lastIndex forward',
        'cancer overview',
        'cancer basics',
        'nothing relevant here',
        'cancer again',
    ];
    const results = texts.map(t => matcher.test(t));
    assert.deepEqual(results, [true, true, true, false, true]);

    // 順序を変えても（先頭に false を挟んでも）結果が変わらないことも確認する。
    const shuffled = ['nothing relevant here', 'cancer overview', 'cancer basics'];
    assert.deepEqual(shuffled.map(t => matcher.test(t)), [false, true, true]);
});

test('createSmartRegex は gi のまま（ハイライトの全置換用途を壊さない）', () => {
    const regex = createSmartRegex('cancer');
    assert.equal(regex.flags, 'gi');
    assert.equal(regex.global, true);
    assert.equal(regex.ignoreCase, true);
});

test('createSmartMatcher は g を含まず i のみ（絞り込み専用）', () => {
    const matcher = createSmartMatcher('cancer');
    assert.equal(matcher.flags, 'i');
    assert.equal(matcher.global, false);
    assert.equal(matcher.ignoreCase, true);
});

test('createSmartRegex と createSmartMatcher は同じパターン文字列を使う（source が一致）', () => {
    for (const keyword of ['cancer', '高血圧', 'pre-cancer', 'COVID-19']) {
        assert.equal(createSmartRegex(keyword).source, createSmartMatcher(keyword).source);
    }
});

test('大文字小文字を無視する', () => {
    const matcher = createSmartMatcher('Cancer');
    assert.equal(matcher.test('a CANCER study'), true);
    assert.equal(matcher.test('a cancer study'), true);
});

test('英単語は語境界（\\b）で完全一致し、部分文字列にはマッチしない', () => {
    const matcher = createSmartMatcher('cancer');
    assert.equal(matcher.test('cancers'), false, 'cancer は cancers（複数形）にマッチしてはならない');
    assert.equal(matcher.test('cancer'), true);
});

test('英単語のハイフン境界の実測: ハイフンは非英数字として単語境界扱いになり、pre-cancer 系にはマッチする（現行の実測どおり）', () => {
    // \b は「英数字とそれ以外の境界」で成立するため、ハイフンは単語境界として扱われる。
    // これは既存の createSmartRegex の挙動をそのまま踏襲したもので、今回の修正で変えていない。
    const matcher = createSmartMatcher('cancer');
    assert.equal(matcher.test('pre-cancer'), true);
    assert.equal(matcher.test('cancer-related'), true);
});

test('日本語タームは部分一致（語境界を使わない）', () => {
    const matcher = createSmartMatcher('高血圧');
    assert.equal(matcher.test('高血圧症の患者'), true);
    assert.equal(matcher.test('血圧'), false, '「血圧」だけでは「高血圧」にマッチしない');
});

test('matchesSearchTerms: AND / OR 両モード、複数ターム', () => {
    const matchers = compileSearchMatchers(['cancer', 'therapy']);
    assert.equal(matchesSearchTerms('cancer therapy trial', matchers, 'and'), true);
    assert.equal(matchesSearchTerms('cancer trial only', matchers, 'and'), false);
    assert.equal(matchesSearchTerms('cancer trial only', matchers, 'or'), true);
    assert.equal(matchesSearchTerms('unrelated trial', matchers, 'or'), false);
});

test('matchesSearchTerms: ターム0件のとき、ANDは真（空配列のevery）、ORは偽（空配列のsome）', () => {
    const matchers = compileSearchMatchers([]);
    assert.equal(matchesSearchTerms('any text', matchers, 'and'), true);
    assert.equal(matchesSearchTerms('any text', matchers, 'or'), false);
});

test('compileSearchMatchers: 返り値の長さがターム数と一致する', () => {
    assert.equal(compileSearchMatchers([]).length, 0);
    assert.equal(compileSearchMatchers(['a']).length, 1);
    assert.equal(compileSearchMatchers(['a', 'b', 'c']).length, 3);
});

test('正規表現の生成回数は文献数に比例しない（文献数3件と300件で生成本数が変わらない）', () => {
    function countGeneratedMatchers(refCount: number, terms: string[]): number {
        const refs: ReferenceWithStatus[] = Array.from({ length: refCount }, (_, i) =>
            makeRef({ ref_id: String(i), title: `cancer study ${i}` })
        );

        let generatedCount = 0;
        const originalMatcher = createSmartMatcher;
        // compileSearchMatchers の内部で createSmartMatcher が何回呼ばれるかを数える。
        // filter() の外（ループの前）で1回だけ呼ばれていれば、文献数を増やしても回数は
        // ターム数のままで変わらないはずである。
        const spy = (kw: string) => {
            generatedCount += 1;
            return originalMatcher(kw);
        };

        const matchers = terms.map(spy);
        refs.filter(r => matchesSearchTerms(buildReferenceSearchText(r), matchers, 'and'));
        return generatedCount;
    }

    const terms = ['cancer', 'study'];
    const countFor3 = countGeneratedMatchers(3, terms);
    const countFor300 = countGeneratedMatchers(300, terms);

    assert.equal(countFor3, terms.length);
    assert.equal(countFor300, terms.length);
    assert.equal(countFor3, countFor300, '生成本数が文献数に比例してはならない');
});

test('g付き（現行のcreateSmartRegex、都度lastIndexリセット）と g無し（createSmartMatcher）で検索フィルターの結果が一致する', () => {
    const refs = [
        makeRef({ ref_id: '1', title: 'cancer trial in adults', abstract: 'long text '.repeat(20) + 'therapy included' }),
        makeRef({ ref_id: '2', title: 'cancer overview' }),
        makeRef({ ref_id: '3', title: 'unrelated diabetes study' }),
        makeRef({ ref_id: '4', title: 'cancer and therapy combined' }),
    ];
    const terms = ['cancer', 'therapy'];

    // g付き経路: ml/search.ts / getMlFilteredRanking と同じ「都度 lastIndex = 0」の形。
    function filterWithGlobalRegex(mode: 'and' | 'or'): string[] {
        const regexes = terms.map(t => createSmartRegex(t));
        return refs
            .filter(r => {
                const text = buildReferenceSearchText(r);
                const test = (re: RegExp) => {
                    re.lastIndex = 0;
                    return re.test(text);
                };
                return mode === 'and' ? regexes.every(test) : regexes.some(test);
            })
            .map(r => r.ref_id);
    }

    // g無し経路: 今回の修正後の実装が使う compileSearchMatchers + matchesSearchTerms。
    function filterWithMatcher(mode: 'and' | 'or'): string[] {
        const matchers = compileSearchMatchers(terms);
        return refs
            .filter(r => matchesSearchTerms(buildReferenceSearchText(r), matchers, mode))
            .map(r => r.ref_id);
    }

    assert.deepEqual(filterWithMatcher('and'), filterWithGlobalRegex('and'));
    assert.deepEqual(filterWithMatcher('or'), filterWithGlobalRegex('or'));
});

// ========== applyTextFilters: 検索フィルター＋タームフィルターの統合純関数 ==========
// filters.ts / selectors.ts が二重に持っていた「検索フィルター→タームフィルター」の
// 2ブロックを1本に集約した関数（Issue #152（#150 工程1））。DOM / state に依存しないため
// ここで直接テストできる。

test('applyTextFilters: タームフィルター0件でも文献が全件残る（早期リターンガードの回帰）', () => {
    // termFilters を空配列のまま matchesSearchTerms(..., [], 'or') に通すと、
    // 空配列の some() は false になり全文献が消える。ガードが効いていることの確認。
    const refs = [
        makeRef({ ref_id: '1', title: 'cancer trial' }),
        makeRef({ ref_id: '2', title: 'diabetes study' }),
    ];
    const resultOr = applyTextFilters(refs, '', [], false);
    assert.deepEqual(resultOr.map(r => r.ref_id), ['1', '2']);

    const resultAnd = applyTextFilters(refs, '', [], true);
    assert.deepEqual(resultAnd.map(r => r.ref_id), ['1', '2']);
});

test('applyTextFilters: 検索文字列が空文字・空白のみのとき全件残る', () => {
    const refs = [
        makeRef({ ref_id: '1', title: 'cancer trial' }),
        makeRef({ ref_id: '2', title: 'diabetes study' }),
    ];
    assert.deepEqual(applyTextFilters(refs, '', [], false).map(r => r.ref_id), ['1', '2']);
    assert.deepEqual(applyTextFilters(refs, '   ', [], false).map(r => r.ref_id), ['1', '2']);
});

test('applyTextFilters: 検索フィルターとタームフィルターが両方指定されたときAND的に重ねて適用される', () => {
    const refs = [
        makeRef({ ref_id: '1', title: 'cancer trial', abstract: 'includes therapy discussion' }),
        makeRef({ ref_id: '2', title: 'cancer overview', abstract: 'no relevant word here' }),
        makeRef({ ref_id: '3', title: 'diabetes therapy', abstract: 'unrelated topic here' }),
    ];
    // 検索文字列 'cancer' で ref_id 1,2 に絞られたのち、タームフィルター 'therapy' で
    // さらに ref_id 1 だけに絞られる（ref_id 3 は 'therapy' を含むが検索フィルターの
    // 時点で既に除外されているため残らない。順序を入れ替えると異なる結果になる）。
    const result = applyTextFilters(refs, 'cancer', [{ term: 'therapy' }], false);
    assert.deepEqual(result.map(r => r.ref_id), ['1']);
});

test('applyTextFilters: ANDタームフィルターで偽陰性が出ない（3件データで3件残る）', () => {
    const refs = [
        makeRef({
            ref_id: '1',
            title: 'A study of cancer in adults',
            abstract: 'cancer is discussed at length here for many words to push lastIndex forward',
        }),
        makeRef({ ref_id: '2', title: 'cancer overview' }),
        makeRef({ ref_id: '3', title: 'cancer basics' }),
    ];
    const result = applyTextFilters(refs, '', [{ term: 'cancer' }], true);
    assert.deepEqual(result.map(r => r.ref_id), ['1', '2', '3']);
});

test('applyTextFilters: ORタームフィルターで偽陰性が出ない', () => {
    const refs = [
        makeRef({ ref_id: '1', title: 'cancer study' }),
        makeRef({ ref_id: '2', title: 'diabetes study' }),
        makeRef({ ref_id: '3', title: 'unrelated topic' }),
    ];
    const result = applyTextFilters(refs, '', [{ term: 'cancer' }, { term: 'diabetes' }], false);
    assert.deepEqual(result.map(r => r.ref_id), ['1', '2']);
});

test('applyTextFilters: 返り値の要素は入力と同一のオブジェクト参照（ジェネリックが潰れていない）', () => {
    const ref1 = makeRef({ ref_id: '1', title: 'cancer study' });
    const ref2 = makeRef({ ref_id: '2', title: 'diabetes study' });
    const refs = [ref1, ref2];
    const result = applyTextFilters(refs, '', [{ term: 'cancer' }], false);
    assert.equal(result.length, 1);
    assert.equal(result[0], ref1, '同一オブジェクト参照であること');
});

// ========== selectors.ts 統合テスト ==========
// selectors.ts は state を引数で受ける純関数設計のため、Node の node:test から
// import して直接呼び出せるかを確認したうえで追加する（src/lib/i18n.ts の t() は
// 非拡張環境で platform() が例外を投げても空文字にフォールバックするため、
// getFilteredReferences / getFilterCounts の呼び出し経路では問題にならない）。
// 実際に import できたため、AND タームフィルターの偽陰性解消と、1パス化後の
// 件数集計を state 経由で検証する。

function makeState(overrides: {
    references: ReferenceWithStatus[];
    activeTermFilters: { term: string; type: 'include' | 'exclude' }[];
    termFilterUseAnd: boolean;
}): AppState {
    return {
        data: {
            references: overrides.references,
            spreadsheetId: 'test-sheet',
            userEmail: 'tester@example.com',
            highlightKeywords: { include: [], exclude: [] },
            llmConfig: {
                llm_enabled: false,
                llm_model: '',
                llm_temperature: 0,
                llm_thinking: 'low',
                llm_protocol_text: '',
                llm_criteria: null,
                llm_screening_prompt: '',
                llm_include_threshold: 0,
                llm_max_output_tokens: 0,
                llm_output_language: 'ja',
                llm_target_mode: 'all',
                llm_target_ref_ids: '',
            },
            mlState: {
                status: 'idle',
                labeledCount: { include: 0, exclude: 0 },
                stoppingRule: null,
                ranking: [],
                currentIndex: 0,
                lastUpdated: 0,
            },
            recentSheets: [],
            isAdmin: false,
            fulltextPoolRule: null,
            fulltextAssignment: { status: 'none', groupCount: 2, reviewerMap: {} },
            sourceFiles: new Set<string>(),
            selectedSourceFiles: new Set<string>(),
            availableReviewers: new Set<string>(),
            enabledReviewers: new Set<string>(),
            activeLlmExecutionIds: new Set<string>(),
            currentBatchDecisions: [],
            failedRefIds: [],
        },
        ui: {
            view: 'screening',
            currentTab: 'screening',
            screening: {
                currentIndex: 0,
                currentFilter: 'all',
                searchQuery: '',
                isKeyOpened: false,
                activeTermFilters: overrides.activeTermFilters,
            },
            ml: { currentIndex: 0, searchQuery: '' },
            llm: { batchRunning: false, currentExecutionId: '' },
            flags: { loading: false, exportMenuOpen: false, shareInputOpen: false, settingsOpen: false },
            settings: {
                autoNavigateAfterDecision: false,
                showRecordCountBelow: false,
                termFilterUseAnd: overrides.termFilterUseAnd,
                treatMlAsManual: false,
                showAiHighlights: false,
                aiDecisionFilter: {},
                abstractSubsectionBreakEnabled: false,
                abstractSubsectionHeadings: [],
            },
            toast: null,
        },
    };
}

test('[selectors.ts統合] getFilteredReferences: ANDタームフィルターの偽陰性が解消している（Issue #152（#150 工程1））', () => {
    const refs = [
        makeRef({
            ref_id: '1',
            title: 'A study of cancer in adults',
            abstract: 'cancer is discussed at length here for many words to push lastIndex forward',
        }),
        makeRef({ ref_id: '2', title: 'cancer overview' }),
        makeRef({ ref_id: '3', title: 'cancer basics' }),
    ];
    const state = makeState({
        references: refs,
        activeTermFilters: [{ term: 'cancer', type: 'include' }],
        termFilterUseAnd: true,
    });

    const filtered = getFilteredReferences(state);
    assert.deepEqual(filtered.map(r => r.ref_id), ['1', '2', '3']);
});

test('[selectors.ts統合] getFilterCounts: 1パス化後も件数が現行仕様どおりの形・値になる', () => {
    const refs = [
        makeRef({ ref_id: '1', title: 'pending one' }),
        makeRef({
            ref_id: '2',
            title: 'included one',
            myDecision: {
                decision_id: 'd2',
                ref_id: '2',
                reviewer_id: 'tester@example.com',
                decision: 'include',
                decided_at: '2026-01-01T00:00:00.000Z',
                client_version: '0.1.0',
            },
        }),
        makeRef({
            ref_id: '3',
            title: 'excluded one',
            myDecision: {
                decision_id: 'd3',
                ref_id: '3',
                reviewer_id: 'tester@example.com',
                decision: 'exclude',
                decided_at: '2026-01-01T00:00:00.000Z',
                client_version: '0.1.0',
            },
        }),
    ];
    const state = makeState({ references: refs, activeTermFilters: [], termFilterUseAnd: true });

    const counts = getFilterCounts(state);
    assert.deepEqual(counts, {
        pending: 1,
        all: 3,
        include: 1,
        exclude: 1,
        maybe: 0,
        conflict: 0,
        fulltextCandidates: 1, // ref_id '2' は自分のIncludeがあるため、ルール未設定時の候補判定に該当する
    });
});
