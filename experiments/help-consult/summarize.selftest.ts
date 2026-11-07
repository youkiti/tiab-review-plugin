import assert from 'node:assert/strict';
import { acceptance, calculateGroup, median, searchBaseline } from './metrics';
import { latestByKey } from './ledger';
import type { JudgeRow, LedgerRow, Question } from './ledger';
import type { HelpSection } from '../../src/lib/help-consult/types';

const questions: Question[] = [
    { id: 'q1', lang: 'ja', category: 'common', question: '設定', expectedSectionIds: ['settings'],
        answerable: true, keyFacts: [] },
    { id: 'q2', lang: 'ja', category: 'common', question: '接続', expectedSectionIds: ['connect', 'alternative'],
        answerable: true, keyFacts: [] },
    { id: 'q3', lang: 'ja', category: 'unanswerable', question: '未知', expectedSectionIds: [],
        answerable: false, keyFacts: [] },
];
const common = { lang: 'ja' as const, provider: 'gemini' as const, model: '固定モデル', configHash: 'hash',
    at: '2026-11-07T00:00:00Z' };
const rows: LedgerRow[] = [
    { ...common, key: 'q1|gemini|v1', questionId: 'q1', status: 'success', sectionIds: ['wrong'],
        answer: '旧回答', latencyMs: 100 },
    { ...common, key: 'q2|gemini|v1', questionId: 'q2', status: 'failure', kind: 'invalid_response', latencyMs: 30 },
    { ...common, key: 'q3|gemini|v1', questionId: 'q3', status: 'no_match', latencyMs: 10 },
    { ...common, key: 'q1|gemini|v1', questionId: 'q1', status: 'success', sectionIds: ['settings'],
        answer: '新回答', latencyMs: 20 },
];
const judges: JudgeRow[] = [
    { key: 'q1|gemini|v1', grade: 'wrong', leak: true, note: '旧採点' },
    { key: 'q2|gemini|v1', grade: 'partial', leak: false, note: '' },
    { key: 'q3|gemini|v1', grade: 'correct', leak: false, note: '' },
    { key: 'q1|gemini|v1', grade: 'correct', leak: false, note: '確定採点' },
    { key: 'unknown', grade: 'severe', leak: true, note: '結合対象外' },
];
const group = calculateGroup(questions, rows, judges, 'gemini', 'ja', 'v1');
assert.equal(latestByKey(rows).size, 3);
assert.equal(latestByKey(rows).get('q1|gemini|v1')!.latencyMs, 20);
assert.equal(group.executed, 3);
assert.equal(group.selectionTotal, 2);
assert.equal(group.selectionRate, 0.5);
assert.equal(group.invalid, 1);
assert.equal(group.unanswerableNoMatch, 1);
assert.equal(group.medianMs, 20);
assert.equal(group.correct, 2);
assert.equal(group.partial, 1);
assert.equal(group.wrong, 0);
assert.equal(group.severe, 0);
assert.equal(group.leaks, 0);
assert.equal(group.accuracy, 0.5);
assert.equal(acceptance(group, 0.5), '合格目安を満たさない');
assert.match(acceptance(calculateGroup(questions, rows, [], 'gemini', 'ja', 'v1'), 0.5), /採点待ち/);
const sections: HelpSection[] = [
    { id: 'settings', level: 3, sectionId: 's', sectionTitle: '設定', title: '設定', when: [], body: '設定' },
    { id: 'alternative', level: 3, sectionId: 's', sectionTitle: '接続', title: '接続', when: [], body: '接続' },
];
assert.deepEqual(searchBaseline(questions, sections), { hits: 2, total: 2, rate: 1 });
assert.deepEqual(searchBaseline([], sections), { hits: 0, total: 0, rate: null });
assert.equal(median([]), null);
assert.equal(median([4, 1, 3, 2]), 2.5);
const complete = { ...group, accuracy: 0.9, selectionRate: 1 };
assert.equal(acceptance(complete, 1), '合格目安を満たす');
assert.equal(acceptance({ ...complete, severe: 1 }, 1), '合格目安を満たさない');
assert.equal(acceptance({ ...complete, leaks: 1 }, 1), '合格目安を満たさない');
assert.match(acceptance({ ...complete, missing: 1 }, 1), /採点待ち/);
console.log('集計の自己テスト: 成功');