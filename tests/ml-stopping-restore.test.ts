import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMlStoppingSetup,
    advanceStoppingRule,
    LEGACY_CMH_SAVED_THRESHOLD,
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
import { isCmhStoppingReached } from '../src/lib/ml/stopping-rules';

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

test('基準の種類: 旧形式でしきい値が旧保存値（500）なら CMH として復元する', () => {
    assert.equal(CMH_DEFAULTS.warmupSize, 500);
    assert.equal(LEGACY_CMH_SAVED_THRESHOLD, 500);
    assert.equal(resolveStoppingRuleKind({ threshold: 500 }, CMH_OK), 'cmh');
    assert.equal(resolveStoppingRuleKind({ threshold: 500 }, CMH_DEFAULTS.minRecords), 'cmh');
});

test('CMH の更新: ウォームアップ中は以前の停止可否と確率をリセットする', () => {
    const previous = { ...createCmhStoppingRule(), canStop: true, probUnderTarget: 0.01 };
    const rule = advanceStoppingRule(previous, { decision: 'exclude', rejudged: false }, decisions(100, 10), CMH_OK);
    assert.ok(isCmhStoppingRule(rule));
    assert.equal(rule.screened, 100);
    assert.equal(rule.warmupComplete, false);
    assert.equal(rule.canStop, false);
    assert.equal(rule.probUnderTarget, 1);
});

test('CMH の更新: 境界の間では続行後の canStop と確率を引き継ぐ', () => {
    const list = decisions(1051, 100);
    const calculated = rebuildCmhRule(list, CMH_OK);
    assert.equal(calculated.canStop, true);
    const previous = { ...rebuildCmhRule(list.slice(0, -1), CMH_OK), canStop: false, probUnderTarget: 0.42 };
    const rule = advanceStoppingRule(previous, { decision: 'exclude', rejudged: false }, list, CMH_OK);
    assert.ok(isCmhStoppingRule(rule));
    assert.equal(rule.screened, 1051);
    assert.equal(rule.canStop, false);
    assert.equal(rule.probUnderTarget, 0.42);
});

for (const [before, after] of [[599, 600], [598, 602]]) {
    test(`CMH の更新: ${before} 件から ${after} 件への境界越えで計算する`, () => {
        const list = decisions(after, 30);
        const expected = rebuildCmhRule(list, CMH_OK);
        const previous = { ...rebuildCmhRule(list.slice(0, before), CMH_OK), canStop: !expected.canStop, probUnderTarget: -1 };
        const rule = advanceStoppingRule(previous, { decision: 'exclude', rejudged: false }, list, CMH_OK);
        assert.deepEqual(rule, expected);
    });
}

test('CMH の更新: 同じ文献を何度判定し直しても件数は増えず、最新のラベル列で計算する', () => {
    let list = decisions(601, 30);
    let previous = rebuildCmhRule(list, CMH_OK);
    for (let i = 0; i < 4; i++) {
        const kind = i % 2 === 0 ? 'exclude' : 'include';
        list = [decision(700 + i, kind), ...list.slice(1)];
        const expected = rebuildCmhRule(list, CMH_OK);
        previous = { ...previous, canStop: !expected.canStop, probUnderTarget: -1 };
        const rule = advanceStoppingRule(previous, { decision: kind, rejudged: true }, list, CMH_OK);
        assert.ok(isCmhStoppingRule(rule));
        assert.equal(rule.screened, 601);
        assert.equal(rule.included, kind === 'include' ? 30 : 29);
        assert.equal(rule.recentDecisions[rule.recentDecisions.length - 1], kind === 'include' ? 1 : 0);
        assert.deepEqual(rule, expected);
        previous = rule;
    }
});

test('CMH の更新: 件数が減ったときも記録から再計算し、自動判定と pending は除外する', () => {
    const previous = { ...rebuildCmhRule(decisions(610, 30), CMH_OK), probUnderTarget: -1 };
    const list = [...decisions(601, 29), decision(800, 'exclude', { auto: true }), { decision: 'pending', decidedAt: '' }];
    const rule = advanceStoppingRule(previous, { decision: 'exclude', rejudged: true }, list, CMH_OK);
    assert.deepEqual(rule, rebuildCmhRule(list, CMH_OK));
});

test('CMH の更新: 既定値と異なる設定を引き継いで計算する', () => {
    const options = { targetRecall: 0.9, confidence: 0.8, minRecords: 1200, warmupSize: 50, updateInterval: 7 };
    const previous = createCmhStoppingRule(options);
    const list = decisions(56, 15);
    const rule = advanceStoppingRule(previous, { decision: 'exclude', rejudged: false }, list, CMH_OK);
    assert.ok(isCmhStoppingRule(rule));
    for (const key of Object.keys(options) as (keyof typeof options)[]) assert.equal(rule[key], options[key]);
    assert.equal(rule.warmupComplete, true);
    const expected = calculateCmhStopping(CMH_OK, 56, 15, rule.recentDecisions, options.targetRecall, options.confidence);
    assert.equal(rule.canStop, expected.canStop);
    assert.equal(rule.probUnderTarget, expected.minProbTarget);
    assert.equal(previous.screened, 0);
});

for (const rejudged of [false, true]) {
    for (const kind of ['include', 'exclude'] as const) {
        test(`連続 Exclude の更新: 再判定=${rejudged}、判定=${kind}`, () => {
            const previous = { ...createStoppingRule(50), current: 12 };
            const rule = advanceStoppingRule(previous, { decision: kind, rejudged }, decisions(100, 20), CMH_OK);
            assert.deepEqual(rule, { ...previous, current: kind === 'include' ? 0 : rejudged ? 12 : 13 });
            assert.equal(previous.current, 12);
        });
    }
}

test('CMH の到達: Include と既読件数の下限を両方満たす必要がある', () => {
    const rule = {
        ...createCmhStoppingRule(), warmupComplete: true, canStop: true,
        included: CMH_DEFAULTS.minIncludedForStop,
        screened: CMH_DEFAULTS.warmupSize + CMH_DEFAULTS.minAdditionalScreened,
    };
    assert.equal(isCmhStoppingReached({ ...rule, included: rule.included - 1 }), false);
    assert.equal(isCmhStoppingReached({ ...rule, screened: rule.screened - 1 }), false);
    assert.equal(isCmhStoppingReached(rule), true);
    assert.equal(isCmhStoppingReached({ ...rule, warmupComplete: false }), false);
    assert.equal(isCmhStoppingReached({ ...rule, canStop: false }), false);
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
    assert.equal(rule.warmupComplete, false);
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

test('CMH の復元: ウォームアップ（500件）に届くまでウォームアップは未完了、届いたら完了', () => {
    assert.equal(rebuildCmhRule(decisions(499, 20), CMH_OK).warmupComplete, false);
    assert.equal(rebuildCmhRule(decisions(499, 20), CMH_OK).probUnderTarget, 1.0);
    const rule = rebuildCmhRule(decisions(500, 20), CMH_OK);
    assert.equal(rule.warmupComplete, true);
    assert.equal(rule.screened, 500);
});

test('CMH の復元: ウォームアップ完了後は calculateCmhStopping と同じ停止可否・確率を持つ', () => {
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
    // 判定 600 件の一括復元と、各判定のあとに記録から更新した結果を比較する。
    const list = decisions(600, 30);
    let live = createCmhStoppingRule();
    for (let i = 0; i < list.length; i++) {
        live = advanceStoppingRule(
            live, { decision: list[i].decision as 'include' | 'exclude', rejudged: false },
            list.slice(0, i + 1), CMH_OK
        ) as typeof live;
    }
    const restored = rebuildCmhRule(list, CMH_OK);
    assert.equal(restored.screened, live.screened);
    assert.equal(restored.included, live.included);
    assert.deepEqual(restored.recentDecisions, live.recentDecisions);
    assert.equal(restored.warmupComplete, live.warmupComplete);
});

// ---- buildMlStoppingSetup ----

test('停止基準の組み立て: CMH は判定 0 件から作成する', () => {
    const setup = buildMlStoppingSetup('cmh', 500, CMH_OK, []);
    assert.ok(isCmhStoppingRule(setup.stoppingRule));
});

test('停止基準の組み立て: CMH の判定件数を復元する', () => {
    const setup = buildMlStoppingSetup('cmh', 500, CMH_OK, decisions(520, 15));
    assert.equal((setup.stoppingRule as ReturnType<typeof createCmhStoppingRule>).screened, 520);
});

test('停止基準の組み立て: 連続 Exclude はしきい値どおりに復元する', () => {
    const setup = buildMlStoppingSetup('consecutive', 80, CMH_OK, decisions(520, 15));
    assert.deepEqual(setup.stoppingRule, createStoppingRule(80));
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
});
