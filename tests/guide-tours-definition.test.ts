import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_TOURS, GUIDE_TOUR_IDS, isGuideTourId } from '../src/lib/guide/tours';

/** 全ツアー（draft の枠を含む） */
const allTours = Object.values(GUIDE_TOURS);
/** 中身のあるツアー（draft を除く）。手順の中身の検査はこちらだけ。 */
const tours = allTours.filter((t) => !t.draft);
/** 最初の2本。手順の形を固定名で縛る検査（対象の集合・dynamicTarget・blockTarget）はこの2本だけに掛ける。
 *  以降のツアーの対象は、tests/guide-tours.test.ts が画面の HTML との照合で見る（固定の一覧を共有しないため）。 */
const original = [GUIDE_TOURS['first-project'], GUIDE_TOURS['join-project']];
const underscore = (s: string): string => s.replace(/-/g, '_');

test('ツアー定義: キーと id が一致し、11本ある', () => {
    assert.deepEqual([...GUIDE_TOUR_IDS].sort(), [
        'ai-first-run',
        'assignment-setup',
        'duplicate-review',
        'first-project',
        'fulltext-page',
        'fulltext-results',
        'fulltext-setup',
        'join-project',
        'ml-start',
        'resolve-conflicts',
        'share-invite',
    ]);
    for (const [key, tour] of Object.entries(GUIDE_TOURS)) {
        assert.equal(tour.id, key);
        assert.ok(isGuideTourId(key));
    }
    assert.equal(isGuideTourId('nope'), false);
});

test('ツアー定義: 手順 id がツアー内で重複しない', () => {
    for (const tour of allTours) {
        const ids = tour.steps.map((s) => s.id);
        assert.equal(new Set(ids).size, ids.length, tour.id);
    }
});

test('ツアー定義: i18n キーの規則と platforms の接頭辞の対応', () => {
    for (const tour of allTours) {
        const extensionOnly = tour.platforms.length === 1 && tour.platforms[0] === 'extension';
        const prefix = extensionOnly ? 'guideExt_tour_' : 'guide_tour_';
        const base = `${prefix}${underscore(tour.id)}`;
        assert.equal(tour.titleKey, `${base}_title`);
        assert.equal(tour.descriptionKey, `${base}_desc`);
        for (const step of tour.steps) {
            assert.equal(step.textKey, `${base}_${underscore(step.id)}`);
        }
        if (!extensionOnly) {
            assert.ok(tour.platforms.includes('web'));
            assert.ok(!base.startsWith('guideExt_'));
        }
    }
    assert.deepEqual(GUIDE_TOURS['first-project'].platforms, ['extension']);
    assert.deepEqual([...GUIDE_TOURS['join-project'].platforms].sort(), ['extension', 'web']);
});

test('ツアー定義: i18n キーが全体で重複しない', () => {
    const keys = allTours.flatMap((t) => [t.titleKey, t.descriptionKey, ...t.steps.map((s) => s.textKey)]);
    assert.equal(new Set(keys).size, keys.length);
});

test('ツアー定義: page は sidepanel か fulltext。既存の2本は sidepanel', () => {
    for (const tour of allTours) {
        assert.ok(tour.page === 'sidepanel' || tour.page === 'fulltext', tour.id);
    }
    for (const tour of original) assert.equal(tour.page, 'sidepanel', tour.id);
    assert.equal(GUIDE_TOURS['fulltext-page'].page, 'fulltext');
});

test('ツアー定義: 8本の枠は draft（draft は true だけ）。既存の2本は draft でない', () => {
    for (const tour of allTours) assert.ok(tour.draft === undefined || tour.draft === true, tour.id);
    for (const tour of original) assert.equal(tour.draft, undefined, tour.id);
});

test('ツアー定義: dynamicTarget は picker-open だけ（最初の2本）', () => {
    for (const tour of original) {
        for (const step of tour.steps) {
            assert.equal(step.dynamicTarget === true, step.target === 'picker-open', `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: target は固定名の集合に収まる（最初の2本）', () => {
    const allowed = new Set([
        'create-project',
        'import',
        'reference-card',
        'decision-buttons',
        'prev',
        'blind',
        'tour-list',
        'sheet-url',
        'connect',
        'picker-open',
        'assignment-sets',
    ]);
    for (const tour of original) {
        for (const step of tour.steps) {
            assert.ok(allowed.has(step.target), `${tour.id}/${step.id}: ${step.target}`);
        }
    }
});

test('ツアー定義: 最後の手順は next で終わり、events 手順はイベントを持つ', () => {
    for (const tour of tours) {
        assert.equal(tour.steps[tour.steps.length - 1].advance.type, 'next', tour.id);
        for (const step of tour.steps) {
            if (step.advance.type === 'events') {
                assert.ok(step.advance.events.length > 0, `${tour.id}/${step.id}`);
            }
        }
    }
});

test('ツアー定義: optional は events の手順にだけ付き、true だけを取る', () => {
    for (const tour of tours) {
        for (const step of tour.steps) {
            const advance = step.advance as { type: string; optional?: unknown };
            if (advance.optional === undefined) continue;
            assert.equal(advance.type, 'events', `${tour.id}/${step.id}: optional は events の手順だけ`);
            assert.equal(advance.optional, true, `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: blockTarget は blind 手順だけ（最初の2本）', () => {
    for (const tour of original) {
        for (const step of tour.steps) {
            assert.equal(step.blockTarget === true, step.id === 'blind', `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: scroll は start / if-hidden のどちらか', () => {
    for (const tour of tours) {
        for (const step of tour.steps) {
            assert.ok(step.scroll === undefined || step.scroll === 'start' || step.scroll === 'if-hidden', `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: 担当セットの手順は no-assignment-sets で飛ばす', () => {
    const step = GUIDE_TOURS['join-project'].steps.find((s) => s.id === 'assignment');
    assert.equal(step?.skipIf, 'no-assignment-sets');
});
