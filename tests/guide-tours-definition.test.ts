import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_TOURS, GUIDE_TOUR_IDS, isGuideTourId } from '../src/lib/guide/tours';

const tours = Object.values(GUIDE_TOURS);
const underscore = (s: string): string => s.replace(/-/g, '_');

test('ツアー定義: キーと id が一致し、2本ある', () => {
    assert.deepEqual([...GUIDE_TOUR_IDS].sort(), ['first-project', 'join-project']);
    for (const [key, tour] of Object.entries(GUIDE_TOURS)) {
        assert.equal(tour.id, key);
        assert.ok(isGuideTourId(key));
    }
    assert.equal(isGuideTourId('nope'), false);
});

test('ツアー定義: 手順 id がツアー内で重複しない', () => {
    for (const tour of tours) {
        const ids = tour.steps.map((s) => s.id);
        assert.equal(new Set(ids).size, ids.length, tour.id);
    }
});

test('ツアー定義: i18n キーの規則と platforms の接頭辞の対応', () => {
    for (const tour of tours) {
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
    const keys = tours.flatMap((t) => [t.titleKey, t.descriptionKey, ...t.steps.map((s) => s.textKey)]);
    assert.equal(new Set(keys).size, keys.length);
});

test('ツアー定義: dynamicTarget は picker-open だけ', () => {
    for (const tour of tours) {
        for (const step of tour.steps) {
            assert.equal(step.dynamicTarget === true, step.target === 'picker-open', `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: target は固定名の集合に収まる', () => {
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
    for (const tour of tours) {
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

test('ツアー定義: blockTarget は blind 手順だけ', () => {
    for (const tour of tours) {
        for (const step of tour.steps) {
            assert.equal(step.blockTarget === true, step.id === 'blind', `${tour.id}/${step.id}`);
        }
    }
});

test('ツアー定義: 担当セットの手順は no-assignment-sets で飛ばす', () => {
    const step = GUIDE_TOURS['join-project'].steps.find((s) => s.id === 'assignment');
    assert.equal(step?.skipIf, 'no-assignment-sets');
});
