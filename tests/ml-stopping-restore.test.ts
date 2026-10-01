import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMlStoppingSetup,
    nextScreeningPhase,
    parseSavedStoppingRule,
    planMlStoppingRule,
    rebuildCmhRule,
    resolveStoppingRuleKind,
    type SavedStoppingRule,
    type ScreenedDecision,
} from '../src/lib/ml/stopping-restore';
import { createCmhStoppingRule, createStoppingRule, isCmhStoppingRule } from '../src/lib/ml/types';
import { calculateCmhStopping } from '../src/lib/ml/cmh';
import { CMH_DEFAULTS } from '../src/lib/ml/cmh-defaults';
import { updateStoppingProgress } from '../src/lib/ml/stopping-rules';

const CMH_OK = 1100;   // CMH が使える件数
const CMH_NG = 800;    // CMH が使えない件数

/** i 件目の判定（時刻は i 秒ずつ進む）。 */
function decision(i: number, kind: 'include' | 'exclude', extra: Partial<ScreenedDecision> = {}): ScreenedDecision {
    return { decision: kind, decidedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...extra };
}

/** 先頭の includeCount 件が include、残りが exclude の判定列を n 件作る。 */
function decisions(n: number, includeCount: number): ScreenedDecision[] {
    return Array.from({ length: n }, (_, i) => decision(i, i < includeCount ? 'include' : 'exclude'));
}

// ---- parseSavedStoppingRule ----

test('保存値の正規化: 未保存・未確定・壊れた値は confirmed:false', () => {
    for (const raw of [undefined, null, 'x', 5, {}, { threshold: 500 }, { confirmed: false, threshold: 500 }]) {
        assert.equal(parseSavedStoppingRule(raw).confirmed, false);
    }
});

test('保存値の正規化: 旧形式（threshold と confirmed だけ）は ruleType 無しで読む', () => {
    assert.deepEqual(parseSavedStoppingRule({ confirmed: true, threshold: 500 }), {
        confirmed: true, threshold: 500, ruleType: undefined,
    });
});

test('保存値の正規化: 不正な threshold は 50、不正な ruleType は無しとして扱う', () => {
    assert.equal(parseSavedStoppingRule({ confirmed: true, threshold: 0 }).threshold, 50);
    assert.equal(parseSavedStoppingRule({ confirmed: true, threshold: 'abc' }).threshold, 50);
    assert.equal(parseSavedStoppingRule({ confirmed: true, threshold: -3 }).threshold, 50);
    assert.equal(parseSavedStoppingRule({ confirmed: true, threshold: 80, ruleType: 'cmh' }).ruleType, 'cmh');
    assert.equal(parseSavedStoppingRule({ confirmed: true, threshold: 80, ruleType: 'other' }).ruleType, undefined);
});

// ---- resolveStoppingRuleKind: 保存値の各形 x CMH が使える／使えない ----

test('基準の種類: ruleType があればそれに従う（CMH が使える件数）', () => {
    assert.equal(resolveStoppingRuleKind({ threshold: 500, ruleType: 'cmh' }, CMH_OK), 'cmh');
    assert.equal(resolveStoppingRuleKind({ threshold: 500, ruleType: 'consecutive' }, CMH_OK), 'consecutive');
    assert.equal(resolveStoppingRuleKind({ threshold: 50, ruleType: 'cmh' }, CMH_OK), 'cmh');
});

test('基準の種類: CMH が使えない件数では ruleType が cmh でも連続 Exclude', () => {
    assert.equal(resolveStoppingRuleKind({ threshold: 500, ruleType: 'cmh' }, CMH_NG), 'consecutive');
    assert.equal(resolveStoppingRuleKind({ threshold: 500 }, CMH_NG), 'consecutive');
    assert.equal(resolveStoppingRuleKind({ threshold: 50 }, CMH_NG), 'consecutive');
});

test('基準の種類: 旧形式でしきい値が初期ランダム件数（500）なら CMH として復元する', () => {
    assert.equal(CMH_DEFAULTS.initialRandomSize, 500);
    assert.equal(resolveStoppingRuleKind({ threshold: 500 }, CMH_OK), 'cmh');
    assert.equal(resolveStoppingRuleKind({ threshold: 500 }, CMH_DEFAULTS.minRecords), 'cmh');
});

test('基準の種類: 旧形式でしきい値が 500 以外なら利用者が選んだ連続 Exclude のまま', () => {
    for (const threshold of [30, 50, 100, 200, 11, 499, 501]) {
        assert.equal(resolveStoppingRuleKind({ threshold }, CMH_OK), 'consecutive', String(threshold));
    }
});

// ---- rebuildCmhRule ----

test('CMH の復元: 判定が無ければ新規の CMH 基準と同じ', () => {
    assert.deepEqual(rebuildCmhRule([], CMH_OK), createCmhStoppingRule());
});

test('CMH の復元: 件数・include 数・直近のラベル列を判定順に作る（入力順に依らない）', () => {
    const ordered = [decision(1, 'exclude'), decision(2, 'include'), decision(3, 'exclude')];
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    const rule = rebuildCmhRule(shuffled, CMH_OK);
    assert.equal(rule.screened, 3);
    assert.equal(rule.included, 1);
    assert.deepEqual(rule.recentDecisions, [0, 1, 0]);
    assert.equal(rule.initialPhaseComplete, false);
    assert.equal(rule.canStop, false);
    assert.equal(rule.probUnderTarget, 1.0);
});

test('CMH の復元: pending・一括 Exclude（auto）の判定は数えない', () => {
    const rule = rebuildCmhRule([
        decision(1, 'include'),
        { decision: 'pending', decidedAt: '2026-01-01T00:00:10Z' },
        { decision: 'exclude', decidedAt: '2026-01-01T00:00:11Z', auto: true },
        decision(2, 'exclude'),
    ], CMH_OK);
    assert.equal(rule.screened, 2);
    assert.equal(rule.included, 1);
});

test('CMH の復元: 初期ランダム区間（500件）に届くまで初期フェーズは未完了、届いたら完了', () => {
    assert.equal(rebuildCmhRule(decisions(499, 20), CMH_OK).initialPhaseComplete, false);
    assert.equal(rebuildCmhRule(decisions(499, 20), CMH_OK).probUnderTarget, 1.0);
    const rule = rebuildCmhRule(decisions(500, 20), CMH_OK);
    assert.equal(rule.initialPhaseComplete, true);
    assert.equal(rule.screened, 500);
});

test('CMH の復元: 初期フェーズ完了後は calculateCmhStopping と同じ停止可否・確率を持つ', () => {
    const list = decisions(700, 25);
    const rule = rebuildCmhRule(list, CMH_OK);
    const expected = calculateCmhStopping(
        CMH_OK, 700, 25, list.map(d => (d.decision === 'include' ? 1 : 0)), rule.targetRecall, rule.confidence
    );
    assert.equal(rule.canStop, expected.canStop);
    assert.equal(rule.probUnderTarget, expected.minProbTarget);
    assert.ok(rule.probUnderTarget < 1);
});

test('CMH の復元: 復元したあとの更新が、最初から数えた場合と同じ結果になる', () => {
    // 判定 600 件を一度に復元してから 1 件足す = 601 件を順に数えた結果の件数部分と一致する
    const list = decisions(600, 30);
    let live = createCmhStoppingRule();
    for (const d of list) live = updateStoppingProgress(live, d.decision as 'include' | 'exclude', CMH_OK) as typeof live;
    const restored = rebuildCmhRule(list, CMH_OK);
    assert.equal(restored.screened, live.screened);
    assert.equal(restored.included, live.included);
    assert.deepEqual(restored.recentDecisions, live.recentDecisions);
    assert.equal(restored.initialPhaseComplete, live.initialPhaseComplete);
});

// ---- buildMlStoppingSetup ----

test('停止基準の組み立て: CMH は初期ランダム段階（判定 0 件）', () => {
    const setup = buildMlStoppingSetup('cmh', 500, CMH_OK, []);
    assert.ok(isCmhStoppingRule(setup.stoppingRule));
    assert.equal(setup.screeningPhase, 'initial_random');
});

test('停止基準の組み立て: CMH で判定が 500 件を超えていれば優先順位づけの段階', () => {
    const setup = buildMlStoppingSetup('cmh', 500, CMH_OK, decisions(520, 15));
    assert.equal(setup.screeningPhase, 'prioritized');
    assert.equal((setup.stoppingRule as ReturnType<typeof createCmhStoppingRule>).screened, 520);
});

test('停止基準の組み立て: 連続 Exclude はしきい値どおり、段階は持たない', () => {
    const setup = buildMlStoppingSetup('consecutive', 80, CMH_OK, decisions(520, 15));
    assert.deepEqual(setup.stoppingRule, createStoppingRule(80));
    assert.equal(setup.screeningPhase, undefined);
});

// ---- planMlStoppingRule: 保存値の各形 x CMH が使える／使えない x 初回／再訪 ----

const NEW_VISIT: SavedStoppingRule = { confirmed: false, threshold: 50 };

test('計画: 未確定（初回）はダイアログを出す。件数に依らない', () => {
    assert.deepEqual(planMlStoppingRule(NEW_VISIT, CMH_OK, []), { action: 'ask' });
    assert.deepEqual(planMlStoppingRule(NEW_VISIT, CMH_NG, []), { action: 'ask' });
});

test('計画: 再訪・旧形式 500・CMH が使える → CMH で復元（判定済みの進み具合つき）', () => {
    const plan = planMlStoppingRule({ confirmed: true, threshold: 500 }, CMH_OK, decisions(120, 6));
    assert.equal(plan.action, 'restore');
    if (plan.action !== 'restore') return;
    assert.equal(plan.kind, 'cmh');
    assert.ok(isCmhStoppingRule(plan.setup.stoppingRule));
    assert.equal((plan.setup.stoppingRule as ReturnType<typeof createCmhStoppingRule>).screened, 120);
    assert.equal(plan.setup.screeningPhase, 'initial_random');
});

test('計画: 再訪・旧形式 500・CMH が使えない → 連続 Exclude 500 件', () => {
    const plan = planMlStoppingRule({ confirmed: true, threshold: 500 }, CMH_NG, decisions(120, 6));
    assert.equal(plan.action, 'restore');
    if (plan.action !== 'restore') return;
    assert.equal(plan.kind, 'consecutive');
    assert.deepEqual(plan.setup.stoppingRule, createStoppingRule(500));
});

test('計画: 再訪・旧形式 50・CMH が使える → 連続 Exclude 50 件のまま', () => {
    const plan = planMlStoppingRule({ confirmed: true, threshold: 50 }, CMH_OK, decisions(120, 6));
    assert.equal(plan.action, 'restore');
    if (plan.action !== 'restore') return;
    assert.equal(plan.kind, 'consecutive');
    assert.deepEqual(plan.setup.stoppingRule, createStoppingRule(50));
});

test('計画: 再訪・ruleType あり（連続 Exclude 500 件を明示）→ 連続 Exclude のまま', () => {
    const plan = planMlStoppingRule({ confirmed: true, threshold: 500, ruleType: 'consecutive' }, CMH_OK, []);
    assert.equal(plan.action, 'restore');
    if (plan.action !== 'restore') return;
    assert.equal(plan.kind, 'consecutive');
});

test('計画: 再訪・ruleType が cmh → CMH で復元', () => {
    const plan = planMlStoppingRule({ confirmed: true, threshold: 500, ruleType: 'cmh' }, CMH_OK, decisions(510, 12));
    assert.equal(plan.action, 'restore');
    if (plan.action !== 'restore') return;
    assert.equal(plan.kind, 'cmh');
    assert.equal(plan.setup.screeningPhase, 'prioritized');
});

// ---- nextScreeningPhase ----

test('段階の遷移: 初期ランダム区間を終えた判定で優先順位づけへ移る', () => {
    let rule = createCmhStoppingRule();
    let phase: ReturnType<typeof nextScreeningPhase> = 'initial_random';
    for (let i = 0; i < 499; i++) {
        rule = updateStoppingProgress(rule, i % 25 === 0 ? 'include' : 'exclude', CMH_OK) as typeof rule;
        phase = nextScreeningPhase(rule, phase);
    }
    assert.equal(phase, 'initial_random');
    rule = updateStoppingProgress(rule, 'exclude', CMH_OK) as typeof rule;
    phase = nextScreeningPhase(rule, phase);
    assert.equal(phase, 'prioritized');
});

test('段階の遷移: 連続 Exclude・基準なし・段階なしでは今の値のまま', () => {
    assert.equal(nextScreeningPhase(createStoppingRule(50), undefined), undefined);
    assert.equal(nextScreeningPhase(null, 'initial_random'), 'initial_random');
    assert.equal(nextScreeningPhase(createCmhStoppingRule(), 'prioritized'), 'prioritized');
});
