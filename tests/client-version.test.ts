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

// Web版の版文字列は web-<版>+<短縮SHA>（Issue #306）。SHA は16進（または unknown）なので、
// 接尾辞の判定は +<sha> の有無で変わらない。
const WEB_SUFFIXES = ['', '-human', '-human-consensus', '-human-adjudication', '-ml', '-ml-auto', '-llm'];
const WEB_SHAS = ['abc1234', 'deadbee', '1234567', 'unknown'];

for (const sha of WEB_SHAS) {
    for (const suffix of WEB_SUFFIXES) {
        test(`Web版の +${sha} 付き client_version は付かない場合と判定が同じ (${suffix || '接尾辞なし'})`, () => {
            const plain = `web-0.57.2${suffix}`;
            const withSha = `web-0.57.2+${sha}${suffix}`;
            assert.equal(isHumanDecision(withSha), isHumanDecision(plain));
            assert.equal(isMlDecision(withSha), isMlDecision(plain));
            assert.equal(isConfirmedMlDecision(withSha), isConfirmedMlDecision(plain));
            assert.equal(isMlAutoDecision(withSha), isMlAutoDecision(plain));
            assert.equal(isLlmDecision(withSha), isLlmDecision(plain));
        });
    }
}

test('Web版の +<sha>-human と -human-consensus は human 判定', () => {
    assert.equal(isHumanDecision('web-0.57.2+abc1234-human'), true);
    assert.equal(isHumanDecision('web-0.57.2+abc1234-human-consensus'), true);
    assert.equal(isHumanDecision('web-0.57.2+unknown-human'), true);
    assert.equal(isMlDecision('web-0.57.2+deadbee-human'), false);
    assert.equal(isLlmDecision('web-0.57.2+1234567-human'), false);
});
