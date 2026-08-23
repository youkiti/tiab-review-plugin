import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isHumanDecision,
    isMlDecision,
    isConfirmedMlDecision,
    isMlAutoDecision,
    isLlmDecision,
    humanDecisionSuffix,
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

// humanDecisionSuffix() の回帰テスト（PR #113 のレビュー指摘）。
// プロジェクト切替（Back）で state.consensusMode が残ったまま、キー未開封（ブラインド）の
// プロジェクトに接続すると、合議トグル・バッジは非表示なのに判定は '-human-consensus' として
// 保存され続けてしまう不具合があった。合議はブラインド中に成立しないため、
// keyOpened=false のときは consensusMode の値によらず必ず '-human' を返すことを固定する。
test('humanDecisionSuffix: keyOpened=false なら consensusMode=true でも -human', () => {
    assert.equal(humanDecisionSuffix(false, true), '-human');
});

test('humanDecisionSuffix: keyOpened=false かつ consensusMode=false は -human', () => {
    assert.equal(humanDecisionSuffix(false, false), '-human');
});

test('humanDecisionSuffix: keyOpened=true かつ consensusMode=true のときだけ -human-consensus', () => {
    assert.equal(humanDecisionSuffix(true, true), '-human-consensus');
});

test('humanDecisionSuffix: keyOpened=true かつ consensusMode=false は -human', () => {
    assert.equal(humanDecisionSuffix(true, false), '-human');
});
