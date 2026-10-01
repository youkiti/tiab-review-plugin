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
    type GuideSuggestContext,
} from '../src/lib/guide/tour-progress';
import { GUIDE_TOURS } from '../src/lib/guide/tours';
import type { GuideCondition } from '../src/lib/guide/tours';

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

test('parse: 実行中ツアーの位置が範囲外・非整数・未知ツアーなら捨てる', () => {
    const n = GUIDE_TOURS['join-project'].steps.length;
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: n } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: -1 } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 1.5 } }).active, null);
    assert.equal(parseGuideProgress({ active: { tourId: 'nope', stepIndex: 0 } }).active, null);
    assert.deepEqual(parseGuideProgress({ active: { tourId: 'join-project', stepIndex: 2 } }).active, {
        tourId: 'join-project',
        stepIndex: 2,
    });
});

test('serialize → parse で往復できる', () => {
    let p = startTour(createEmptyGuideProgress(), 'first-project', 3);
    p = completeTour(p, 'join-project', NOW);
    p = suppressSuggestions(p);
    assert.deepEqual(parseGuideProgress(JSON.parse(JSON.stringify(serializeGuideProgress(p)))), p);
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
    assert.deepEqual(availableTours(ctx({ platform: 'web' })).map((t) => t.id), ['join-project']);
    assert.equal(shouldSuggest(doneFirst, ctx({ platform: 'web' })), true);
    assert.equal(shouldSuggest(doneFirst, ctx({ capabilities: { createProject: false } })), true);
    const doneJoin = completeTour(createEmptyGuideProgress(), 'join-project', NOW);
    assert.equal(shouldSuggest(doneJoin, ctx({ platform: 'web' })), false);
});

test('遷移: 開始・手順更新・完了・却下', () => {
    let p = startTour(createEmptyGuideProgress(), 'first-project');
    assert.deepEqual(p.active, { tourId: 'first-project', stepIndex: 0 });
    p = setActiveStep(p, 4);
    assert.deepEqual(p.active, { tourId: 'first-project', stepIndex: 4 });
    // 別ツアーを始めると置き換わる
    p = startTour(p, 'join-project', 2);
    assert.deepEqual(p.active, { tourId: 'join-project', stepIndex: 2 });
    // 実行中でないツアーの完了は実行中の状態を消さない
    p = completeTour(p, 'first-project', NOW);
    assert.deepEqual(p.active, { tourId: 'join-project', stepIndex: 2 });
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
