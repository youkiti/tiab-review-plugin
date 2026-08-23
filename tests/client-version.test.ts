import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isHumanDecision,
    isMlDecision,
    isConfirmedMlDecision,
    isMlAutoDecision,
    isLlmDecision,
} from '../src/lib/client-version';

// 合議モード（-human-consensus、AGENTS.md「合議判定の構造化マーク」）の client_version が
// 既存の判定種別ヘルパーからどう見えるかを検証する。
// isHumanDecision() は部分一致（includes）で判定するため、-human-consensus も human 判定として
// 扱われる（＝合議判定は saveDecision の追記専用経路に乗る）ことを確認する。
// 一方 ml/llm 系のヘルパーは false のままで、他の判定種別と誤認されないことも確認する。

test('isHumanDecision: -human-consensus は human 判定として扱われる', () => {
    assert.equal(isHumanDecision('1.2.3-human-consensus'), true);
});

test('isMlDecision: -human-consensus は ML 判定ではない', () => {
    assert.equal(isMlDecision('1.2.3-human-consensus'), false);
});

test('isConfirmedMlDecision: -human-consensus は ML手動確認判定ではない', () => {
    assert.equal(isConfirmedMlDecision('1.2.3-human-consensus'), false);
});

test('isMlAutoDecision: -human-consensus は ML自動判定ではない', () => {
    assert.equal(isMlAutoDecision('1.2.3-human-consensus'), false);
});

test('isLlmDecision: -human-consensus は LLM判定ではない', () => {
    assert.equal(isLlmDecision('1.2.3-human-consensus'), false);
});

test('isHumanDecision: 通常の -human も従来どおり human 判定', () => {
    assert.equal(isHumanDecision('1.2.3-human'), true);
});
