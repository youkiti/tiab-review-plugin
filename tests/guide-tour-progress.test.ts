import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GUIDE_PROGRESS_STORAGE_KEY,
    availableTours,
    completeTour,
    createEmptyGuideProgress,
    dismissTour,
    nextStepIndex,
    parseGuideProgress,
    serializeGuideProgress,
    setActiveStep,
    shouldAdvance,
    shouldSuggest,
    startTour,
    suppressSuggestions,
    tourToSuggestOnEvent,
    visibleStepPosition,
    type GuideSuggestContext,
} from '../src/lib/guide/tour-progress';
import { GUIDE_TOURS } from '../src/lib/guide/tours';
import type { GuideCondition, TourDefinition } from '../src/lib/guide/tours';

const NOW = '2026-10-01T00:00:00.000Z';
const ctx = (over: Partial<GuideSuggestContext> = {}): GuideSuggestContext => ({
    screen: 'project',
    platform: 'extension',
    capabilities: { createProject: true },
    ...over,
});

test('保存キー', () => {
    assert.equal(GUIDE_PROGRESS_STORAGE_KEY, 'guide_progress');
});

test('parse: 壊れた入力は既定値に戻る', () => {
    const empty = createEmptyGuideProgress();
    for (const raw of [undefined, null, 'x', 3, [], { tours: 'x', active: 5 }]) {
        assert.deepEqual(parseGuideProgress(raw), empty);
    }
});

test('parse: 未知のツアー・不正な状態は読み飛ばし、正しいものは残す', () => {
    const p = parseGuideProgress({
        tours: {
            'first-project': { status: 'done', at: NOW },
            'join-project': { status: 'weird', at: NOW },
            unknown: { status: 'done', at: NOW },
        },
        suppressSuggestions: true,
        extra: 1,
    });
    assert.deepEqual(p.tours, { 'first-project': { status: 'done', at: NOW } });
    assert.equal(p.suppressSuggestions, true);
    assert.equal(p.active, null);
});

const stepIdOf = (tourId: 'first-project' | 'join-project', index: number): string => GUIDE_TOURS[tourId].steps[index].id;

test('parse: stepId つきの保存値は、添字が食い違っていても ID の手順の今の添字に解決する', () => {
    const joinSteps = GUIDE_TOURS['join-project'].steps;
    const finish = joinSteps.findIndex(step => step.id === 'finish');
    const active = parseGuideProgress({ active: { tourId: 'join-project', stepId: 'finish', stepIndex: 5 } }).active;
    assert.deepEqual(active, { tourId: 'join-project', stepId: 'finish', stepIndex: finish });
    // 保存時の添字が範囲外でも、ID が実在すれば採用する
    const outOfRange = parseGuideProgress({ active: { tourId: 'join-project', stepId: 'read', stepIndex: 99 } }).active;
    assert.equal(outOfRange?.stepIndex, joinSteps.findIndex(step => step.id === 'read'));
});

test('parse: 実在しない stepId は active を捨て、済み・却下の記録は残す', () => {
    const p = parseGuideProgress({
        tours: { 'first-project': { status: 'done', at: NOW } },
        active: { tourId: 'join-project', stepId: 'renamed-away', stepIndex: 1 },
    });
    assert.equal(p.active, null);
    assert.deepEqual(p.tours, { 'first-project': { status: 'done', at: NOW } });
});

test('parse: stepId の無い旧形式は、添字が範囲内なら採用して stepId を補い、範囲外なら捨てる', () => {
    assert.deepEqual(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 1 } }).active, {
        tourId: 'join-project',
        stepId: stepIdOf('join-project', 1),
        stepIndex: 1,
    });
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 99 } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepId: 5, stepIndex: 99 } }).active, null);
});

test('parse: 実行中ツアーの位置が範囲外・非整数・未知ツアーなら捨てる', () => {
    const n = GUIDE_TOURS['join-project'].steps.length;
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: n } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: -1 } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 1.5 } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'nope', stepIndex: 0 } }).active, null);
    assert.deepEqual(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 2 } }).active, {
        tourId: 'join-project',
        stepId: stepIdOf('join-project', 2),
        stepIndex: 2,
    });
});

test('serialize → parse で往復できる', () => {
    let p = startTour(createEmptyGuideProgress(), 'first-project', 3);
    p = completeTour(p, 'join-project', NOW);
    p = suppressSuggestions(p);
    assert.deepEqual(parseGuideProgress(JSON.parse(JSON.stringify(serializeGuideProgress(p)))), p);
});

test('serialize → parse: 手順を更新しても同じ手順に戻る', () => {
    const p = setActiveStep(startTour(createEmptyGuideProgress(), 'join-project'), 4);
    assert.equal(p.active?.stepId, stepIdOf('join-project', 4));
    const back = parseGuideProgress(JSON.parse(JSON.stringify(serializeGuideProgress(p))));
    assert.deepEqual(back.active, { tourId: 'join-project', stepId: stepIdOf('join-project', 4), stepIndex: 4 });
});

test('nextStepIndex: 条件なしなら次の手順', () => {
    const tour = GUIDE_TOURS['first-project'];
    assert.equal(nextStepIndex(tour, 0, {}), 0);
    assert.equal(nextStepIndex(tour, 2, new Set<GuideCondition>()), 2);
});

test('nextStepIndex: skipIf が連続すると続けて飛ばす', () => {
    const tour = GUIDE_TOURS['first-project'];
    // 手順1(on-screening-screen)と手順2(has-references)が連続して飛ばされる
    assert.equal(nextStepIndex(tour, 0, { 'on-screening-screen': true, 'has-references': true }), 2);
    assert.equal(nextStepIndex(tour, 0, new Set<GuideCondition>(['on-screening-screen'])), 1);
    assert.equal(nextStepIndex(tour, 1, { 'has-references': true }), 2);
});

test('nextStepIndex: join-project は接続済みなら3手順を飛ばし、担当セットが無ければ4手順目も飛ばす', () => {
    const tour = GUIDE_TOURS['join-project'];
    assert.equal(nextStepIndex(tour, 0, { 'on-screening-screen': true }), 3);
    assert.equal(nextStepIndex(tour, 0, { 'on-screening-screen': true, 'no-assignment-sets': true }), 4);
});

test('nextStepIndex: 最後を過ぎる・残り全部飛ぶと null', () => {
    const tour = GUIDE_TOURS['join-project'];
    assert.equal(nextStepIndex(tour, tour.steps.length, {}), null);
    assert.equal(nextStepIndex(tour, tour.steps.length - 1, {}), tour.steps.length - 1);
    const custom = {
        steps: [
            { id: 'a', target: 't', textKey: 'k', advance: { type: 'next' as const }, skipIf: 'is-admin' as const },
            { id: 'b', target: 't', textKey: 'k', advance: { type: 'next' as const }, skipIf: 'is-admin' as const },
        ],
    };
    assert.equal(nextStepIndex(custom, 0, { 'is-admin': true }), null);
});

test('shouldAdvance: events の手順だけが該当イベントで進む', () => {
    const [create, , read] = GUIDE_TOURS['first-project'].steps;
    assert.equal(shouldAdvance(create, 'project-created'), true);
    assert.equal(shouldAdvance(create, 'decision-saved'), false);
    assert.equal(shouldAdvance(read, 'decision-saved'), false);
    const connect = GUIDE_TOURS['join-project'].steps[1];
    assert.equal(shouldAdvance(connect, 'project-connected'), true);
    assert.equal(shouldAdvance(connect, 'picker-guidance-shown'), true);
    assert.equal(shouldAdvance(connect, 'navigated-prev'), false);
});

test('shouldSuggest: 初回のプロジェクト選択画面では出す', () => {
    assert.equal(shouldSuggest(createEmptyGuideProgress(), ctx()), true);
});

test('shouldSuggest: 画面が違う・延期・今後表示しない・実行中なら出さない', () => {
    const empty = createEmptyGuideProgress();
    assert.equal(shouldSuggest(empty, ctx({ screen: 'screening' })), false);
    assert.equal(shouldSuggest(empty, ctx({ postponedThisSession: true })), false);
    assert.equal(shouldSuggest(suppressSuggestions(empty), ctx()), false);
    assert.equal(shouldSuggest(startTour(empty, 'join-project'), ctx()), false);
});

test('shouldSuggest: 使えるツアーのどれかが済・却下なら出さない', () => {
    const empty = createEmptyGuideProgress();
    assert.equal(shouldSuggest(completeTour(empty, 'first-project', NOW), ctx()), false);
    assert.equal(shouldSuggest(dismissTour(empty, 'join-project', NOW), ctx()), false);
});

test('shouldSuggest: Web 版・作成権限なしではツアー1を数えない', () => {
    const doneFirst = completeTour(createEmptyGuideProgress(), 'first-project', NOW);
    const webIds = availableTours(ctx({ platform: 'web' })).map((t) => t.id);
    assert.equal(webIds.includes('first-project'), false);
    assert.equal(webIds.includes('join-project'), true);
    assert.equal(shouldSuggest(doneFirst, ctx({ platform: 'web' })), true);
    assert.equal(shouldSuggest(doneFirst, ctx({ capabilities: { createProject: false } })), true);
    const doneJoin = completeTour(createEmptyGuideProgress(), 'join-project', NOW);
    assert.equal(shouldSuggest(doneJoin, ctx({ platform: 'web' })), false);
});

test('遷移: 開始・手順更新・完了・却下', () => {
    let p = startTour(createEmptyGuideProgress(), 'first-project');
    assert.deepEqual(p.active, { tourId: 'first-project', stepId: stepIdOf('first-project', 0), stepIndex: 0 });
    p = setActiveStep(p, 4);
    assert.deepEqual(p.active, { tourId: 'first-project', stepId: stepIdOf('first-project', 4), stepIndex: 4 });
    // 別ツアーを始めると置き換わる
    p = startTour(p, 'join-project', 2);
    assert.deepEqual(p.active, { tourId: 'join-project', stepId: stepIdOf('join-project', 2), stepIndex: 2 });
    // 実行中でないツアーの完了は実行中の状態を消さない
    p = completeTour(p, 'first-project', NOW);
    assert.deepEqual(p.active, { tourId: 'join-project', stepId: stepIdOf('join-project', 2), stepIndex: 2 });
    p = dismissTour(p, 'join-project', NOW);
    assert.equal(p.active, null);
    assert.deepEqual(p.tours, {
        'first-project': { status: 'done', at: NOW },
        'join-project': { status: 'dismissed', at: NOW },
    });
    assert.equal(setActiveStep(createEmptyGuideProgress(), 3).active, null);
});

test('遷移: 元の状態を書き換えない', () => {
    const base = createEmptyGuideProgress();
    startTour(base, 'first-project');
    completeTour(base, 'first-project', NOW);
    suppressSuggestions(base);
    assert.deepEqual(base, createEmptyGuideProgress());
});

test('shouldAdvance: optional な events の手順も、該当イベントで進む（「押さずに次へ」は画面側の追加の出口）', () => {
    const optional = { advance: { type: 'events' as const, events: ['decision-saved' as const], optional: true as const } };
    assert.equal(shouldAdvance(optional, 'decision-saved'), true);
    assert.equal(shouldAdvance(optional, 'navigated-prev'), false);
});

test('availableTours: draft の枠は含めず、渡した定義の中から選ぶ', () => {
    const base = GUIDE_TOURS['join-project'];
    const draft: TourDefinition = { ...base, id: 'ml-start', draft: true, steps: [] };
    assert.deepEqual(availableTours(ctx(), [base, draft]).map((t) => t.id), ['join-project']);
    assert.deepEqual(availableTours(ctx(), [draft]), []);
});

test('availableTours: 実在の定義では、draft が1本も返らず、draft でない拡張版のツアーは全部返る', () => {
    const real = availableTours(ctx());
    for (const tour of real) assert.equal(tour.draft, undefined, tour.id);
    const expected = Object.values(GUIDE_TOURS)
        .filter((tour) => !tour.draft && tour.platforms.includes('extension'))
        .map((tour) => tour.id);
    assert.deepEqual(real.map((t) => t.id).sort(), expected.sort());
});

/** 仕組みの確認用の架空のツアー（実際のツアーは draft のため、提案の純関数はこの定義で検査する）。 */
const fakeTour = (over: Partial<TourDefinition> = {}): TourDefinition => ({
    ...GUIDE_TOURS['first-project'],
    id: 'ml-start',
    suggestOn: 'tab-opened-ml',
    ...over,
});

test('tourToSuggestOnEvent: suggestOn が一致し、まだ済・却下でなければ返す', () => {
    const tour = fakeTour();
    const empty = createEmptyGuideProgress();
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx(), [tour]), tour);
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-llm', ctx(), [tour]), null);
    // suggestOn の無いツアーは対象外
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx(), [fakeTour({ suggestOn: undefined })]), null);
    // 既定では実在のツアーから選ぶ（draft でなく、拡張版の suggestOn が一致するもの。実在のツアーが増えても変わらない書き方）
    const expectedReal = Object.values(GUIDE_TOURS)
        .find((t) => !t.draft && t.platforms.includes('extension') && t.suggestOn === 'tab-opened-ml');
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx())?.id ?? null, expectedReal?.id ?? null);
});

test('tourToSuggestOnEvent: 済・却下・実行中・今後表示しない・draft・プラットフォーム外・権限なしでは返さない', () => {
    const tour = fakeTour();
    const empty = createEmptyGuideProgress();
    assert.equal(tourToSuggestOnEvent(completeTour(empty, 'ml-start', NOW), 'tab-opened-ml', ctx(), [tour]), null);
    assert.equal(tourToSuggestOnEvent(dismissTour(empty, 'ml-start', NOW), 'tab-opened-ml', ctx(), [tour]), null);
    assert.equal(tourToSuggestOnEvent(startTour(empty, 'join-project'), 'tab-opened-ml', ctx(), [tour]), null);
    assert.equal(tourToSuggestOnEvent(suppressSuggestions(empty), 'tab-opened-ml', ctx(), [tour]), null);
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx(), [fakeTour({ draft: true })]), null);
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx({ platform: 'web' }), [tour]), null);
    assert.equal(tourToSuggestOnEvent(empty, 'tab-opened-ml', ctx({ capabilities: { createProject: false } }), [tour]), null);
    // 別のツアーの済・却下は影響しない
    assert.equal(tourToSuggestOnEvent(completeTour(empty, 'first-project', NOW), 'tab-opened-ml', ctx(), [tour]), tour);
});

const fakeSteps = (skips: Array<GuideCondition | undefined>) => ({
    steps: skips.map((skipIf, i) => ({ id: `s${i}`, target: 't', textKey: 'k', advance: { type: 'next' as const }, skipIf })),
});

test('visibleStepPosition: 飛ばす手順が無ければ「添字 + 1 / 全部」', () => {
    const tour = fakeSteps([undefined, undefined, undefined]);
    assert.deepEqual(visibleStepPosition(tour, 0, {}), { position: 1, total: 3 });
    assert.deepEqual(visibleStepPosition(tour, 2, {}), { position: 3, total: 3 });
});

test('visibleStepPosition: 前・後ろ・連続して飛ばされる手順は数えない', () => {
    const tour = fakeSteps(['is-admin', undefined, 'no-assignment-sets', 'no-assignment-sets', undefined, 'is-admin']);
    const cond = { 'is-admin': true, 'no-assignment-sets': true } as const;
    assert.deepEqual(visibleStepPosition(tour, 1, cond), { position: 1, total: 2 });
    assert.deepEqual(visibleStepPosition(tour, 4, cond), { position: 2, total: 2 });
});

test('visibleStepPosition: 条件が変わると分母が変わる', () => {
    const tour = fakeSteps([undefined, 'is-admin', undefined, undefined]);
    assert.deepEqual(visibleStepPosition(tour, 2, {}), { position: 3, total: 4 });
    assert.deepEqual(visibleStepPosition(tour, 2, { 'is-admin': true }), { position: 2, total: 3 });
    assert.deepEqual(visibleStepPosition(tour, 2, new Set<GuideCondition>(['is-admin'])), { position: 2, total: 3 });
});

test('visibleStepPosition: 飛ばされる手順そのものを渡すと、そこまでに出る手順の数（最低 1）。全部飛ぶなら 0 / 0', () => {
    const tour = fakeSteps([undefined, 'is-admin', undefined]);
    assert.deepEqual(visibleStepPosition(tour, 1, { 'is-admin': true }), { position: 1, total: 2 });
    const leading = fakeSteps(['is-admin', undefined]);
    assert.deepEqual(visibleStepPosition(leading, 0, { 'is-admin': true }), { position: 1, total: 1 });
    const all = fakeSteps(['is-admin', 'is-admin']);
    assert.deepEqual(visibleStepPosition(all, 0, { 'is-admin': true }), { position: 0, total: 0 });
});
