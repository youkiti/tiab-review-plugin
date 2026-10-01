import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOURS, type TourDefinition } from '../src/lib/guide/tours';
import { FULLTEXT_PAGE_TOUR } from '../src/lib/guide/tours/fulltext-page';
import { computeTourCardPosition } from '../src/guide-ui/placement';
import {
    GUIDE_PROGRESS_STORAGE_KEY,
    availableTours,
    completeTour,
    createEmptyGuideProgress,
    decideProgressSync,
    nextStepIndex,
    shouldSuggest,
    tourToSuggestOnEvent,
    tourToSuggestOnPage,
    type GuideConditionValues,
} from '../src/lib/guide/tour-progress';

/**
 * 全文の判定ページのツアー（fulltext-page）に固有の検査。定義と画面の照合は tests/guide-tours.test.ts が行う。
 * ここでは、このページの入口が初期バンドルを増やさない構成であること、サイドパネルと保存値を共有する前提、
 * ページごとの提案の判定、除外理由の手順の飛ばし方を固定する。
 */
const ROOT = process.cwd();
const read = (...segments: string[]): string => readFileSync(join(ROOT, ...segments), 'utf8');
const context = { platform: 'extension', capabilities: { createProject: true } } as const;

test('入口 guide.ts は、保存キーとツアー ID を値として持ち、本体（tours・tour-progress・guide-ui）を静的 import しない', () => {
    const entry = read('src', 'fulltext', 'guide.ts');
    assert.equal(/const GUIDE_PROGRESS_KEY = '([^']+)'/.exec(entry)?.[1], GUIDE_PROGRESS_STORAGE_KEY);
    assert.equal(/const TOUR_ID = '([^']+)'/.exec(entry)?.[1], FULLTEXT_PAGE_TOUR.id);
    for (const match of entry.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)) {
        assert.doesNotMatch(match[1], /lib\/guide\/|guide-ui|guide-feature/, `guide.ts が ${match[1]} を値として import している（初期バンドルに入る）`);
    }
    // 本体は専用のチャンク名で動的 import する（サイドパネルの guide-feature とは別のエントリなので別名にする）
    assert.match(entry, /webpackChunkName: "fulltext-guide"\s*\*\/\s*'\.\/guide-feature'/);
});

test('guide-ui は画面（sidepanel・fulltext）を import しない。lib は guide-ui を import しない', () => {
    const dir = join(ROOT, 'src', 'guide-ui');
    const files = readdirSync(dir).filter(name => name.endsWith('.ts'));
    assert.ok(files.length >= 4, 'guide-ui の TypeScript が少なすぎる（検索が壊れている）');
    for (const file of files) {
        const source = readFileSync(join(dir, file), 'utf8');
        for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
            assert.doesNotMatch(match[1], /\/(sidepanel|fulltext|popup|webapp|background|demo)(\/|$)/, `guide-ui/${file} が画面 ${match[1]} を import している`);
        }
    }
});

test('fulltext.html は、ツアーを始めるボタン（data-guide-action="start-tour"）を「?」リンクの隣に持ち、リンク自体は変えない', () => {
    const html = read('src', 'fulltext', 'fulltext.html');
    assert.match(html, /<button[^>]*id="ft-tour-btn"[^>]*data-guide-action="start-tour"/);
    assert.match(html, /<a id="ft-help-link"[^>]*href="https:\/\/youkiti\.github\.io\/tiab-review-plugin\/help\.html#fulltext-decisions"[^>]*target="_blank"/);
    assert.match(html, /href="\.\.\/sidepanel\/styles\/guide\.css"/, 'ツアーの見た目（guide.css）を読み込む');
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(read('src', '_locales', lang, 'messages.json')) as Record<string, { message: string }>;
        for (const key of ['guideExt_fulltextTourBtn', 'guideExt_fulltextTourBtnTitle']) {
            assert.ok(messages[key]?.message, `${lang} に ${key} が無い`);
        }
    }
});

test('このツアーは draft でなく、拡張版だけ・全文の判定ページ向けで、suggestOn を持たない（提案はページ側が出す）', () => {
    assert.equal(GUIDE_TOURS['fulltext-page'], FULLTEXT_PAGE_TOUR);
    assert.equal(FULLTEXT_PAGE_TOUR.draft, undefined);
    assert.equal(FULLTEXT_PAGE_TOUR.page, 'fulltext');
    assert.deepEqual([...FULLTEXT_PAGE_TOUR.platforms], ['extension']);
    assert.equal(FULLTEXT_PAGE_TOUR.suggestOn, undefined);
    const steps = FULLTEXT_PAGE_TOUR.steps;
    assert.ok(steps.length >= 6 && steps.length <= 10, `手順は6〜10個に収める（今 ${steps.length}）`);
    assert.equal(steps[steps.length - 1].id, 'finish');
    assert.equal(steps[steps.length - 1].target, 'ft-help');
    assert.equal(steps[steps.length - 1].advance.type, 'next');
});

test('tourToSuggestOnPage: そのページのツアーが未着手のときだけ返し、実行中・済・却下・全体停止では返さない', () => {
    const fresh = createEmptyGuideProgress();
    assert.equal(tourToSuggestOnPage(fresh, 'fulltext', context)?.id, 'fulltext-page');
    assert.equal(tourToSuggestOnPage(fresh, 'sidepanel', context)?.page, 'sidepanel');
    assert.equal(tourToSuggestOnPage({ ...fresh, suppressSuggestions: true }, 'fulltext', context), null);
    assert.equal(
        tourToSuggestOnPage({ ...fresh, active: { tourId: 'join-project', stepId: 'read', stepIndex: 0 } }, 'fulltext', context),
        null,
    );
    for (const status of ['done', 'dismissed'] as const) {
        const progress = { ...fresh, tours: { 'fulltext-page': { status, at: '2026-10-01T00:00:00.000Z' } } as const };
        assert.equal(tourToSuggestOnPage(progress, 'fulltext', context), null, `${status} のあとは出さない`);
    }
    // Web 版では拡張版だけのツアーは出さない
    assert.equal(tourToSuggestOnPage(fresh, 'fulltext', { platform: 'web', capabilities: { createProject: false } }), null);
});

test('除外理由の手順: 理由の選択肢が出ていないときは説明の手順、出ているときは理由の手順になる（どちらかだけ）', () => {
    const shown = { 'reason-select-shown': true, 'reason-select-hidden': false } as const;
    const hidden = { 'reason-select-shown': false, 'reason-select-hidden': true } as const;
    const stepIds = (conditions: typeof shown | typeof hidden): string[] => {
        const ids: string[] = [];
        let index = nextStepIndex(FULLTEXT_PAGE_TOUR, 0, conditions);
        while (index !== null) {
            ids.push(FULLTEXT_PAGE_TOUR.steps[index].id);
            index = nextStepIndex(FULLTEXT_PAGE_TOUR, index + 1, conditions);
        }
        return ids;
    };
    const whenHidden = stepIds(hidden);
    const whenShown = stepIds(shown);
    assert.ok(whenHidden.includes('reason-info') && !whenHidden.includes('reason'));
    assert.ok(whenShown.includes('reason') && !whenShown.includes('reason-info'));
    // 押さずに「次へ」だけで最後まで進むと、除外理由についての手順をどちらか1つは必ず見る
    for (const ids of [whenHidden, whenShown]) assert.equal(ids[ids.length - 1], 'finish');
});

test('判定の保存・理由の欄を出す操作は optional（押さずに次へも進める）で、判定ボタンの手順がこのページのイベントを待つ', () => {
    const byId = new Map(FULLTEXT_PAGE_TOUR.steps.map(step => [step.id, step]));
    for (const id of ['decision', 'reason']) {
        const step = byId.get(id);
        assert.ok(step && step.advance.type === 'events' && step.advance.optional === true, `${id} は optional な events の手順`);
    }
    const decision = byId.get('decision');
    assert.ok(decision && decision.advance.type === 'events');
    assert.deepEqual([...decision.advance.events].sort(), ['fulltext-decision-saved', 'fulltext-exclude-chosen']);
    // イベントの送出元は、判定の保存・Exclude の選択を処理するコントローラー
    const controller = read('src', 'fulltext', 'decision-controller.ts');
    assert.match(controller, /emitGuideEvent\('fulltext-decision-saved'\)/);
    assert.match(controller, /emitGuideEvent\('fulltext-exclude-chosen'\)/);
});

test('カードの配置: allowSide が偽（既定）なら従来どおり。真なら、下にも上にも収まらない縦長の対象の横に置く', () => {
    const viewport = { width: 900, height: 700 };
    const card = { width: 320, height: 200 };
    // 右ペインの縦に長い対象（下にも上にも収まらない）
    const target = { top: 144, bottom: 530, left: 594, right: 891 };
    const base = { viewport, card, target, margin: 8, gap: 8, pad: 3 };
    // 従来: 画面下端へ固定（対象に重なる）
    assert.deepEqual(computeTourCardPosition(base), { left: 572, top: 492 });
    // 横に置く: 対象の左（対象の上端にそろえる）。対象と横方向で重ならない
    const side = computeTourCardPosition({ ...base, allowSide: true });
    assert.ok(side.left + card.width <= target.left, `カードの右端 ${side.left + card.width} が対象の左 ${target.left} に重なる`);
    assert.equal(side.top, 141);
    // 左に収まらなければ右。右にも収まらなければ従来どおり
    const narrowLeft = computeTourCardPosition({ ...base, target: { top: 144, bottom: 530, left: 100, right: 500 }, allowSide: true });
    assert.equal(narrowLeft.left, 500 + 3 + 8, '左に収まらないときは対象の右（右端 + pad + gap）に置く');
    const nowhere = computeTourCardPosition({ ...base, target: { top: 144, bottom: 530, left: 100, right: 800 }, allowSide: true });
    assert.deepEqual(nowhere, computeTourCardPosition({ ...base, target: { top: 144, bottom: 530, left: 100, right: 800 } }));
    // 下に収まるなら、allowSide でも下（従来と同じ）
    const small = { top: 100, bottom: 140, left: 594, right: 891 };
    assert.deepEqual(computeTourCardPosition({ ...base, target: small, allowSide: true }), computeTourCardPosition({ ...base, target: small }));
});

test('unavailableIf: 条件の値を渡されたときだけ、真なら一覧・提案から外し、偽なら出す。渡さなければ今のまま', () => {
    const tour: TourDefinition = { ...GUIDE_TOURS['join-project'], id: 'ml-start', suggestOn: 'tab-opened-ml', page: 'sidepanel', unavailableIf: 'is-admin' };
    const ids = (conditions?: GuideConditionValues) => availableTours(context, [tour], conditions).map(candidate => candidate.id);
    assert.deepEqual(ids(), ['ml-start'], '条件を渡さなければ unavailableIf は見ない');
    assert.deepEqual(ids({ 'is-admin': true }), [], '真なら外れる');
    assert.deepEqual(ids({ 'is-admin': false }), ['ml-start'], '偽なら出る');
    assert.deepEqual(ids(new Set(['is-admin'] as const)), [], 'Set でも同じ');
    const fresh = createEmptyGuideProgress();
    assert.equal(tourToSuggestOnEvent(fresh, 'tab-opened-ml', context, [tour], { 'is-admin': true }), null);
    assert.equal(tourToSuggestOnEvent(fresh, 'tab-opened-ml', context, [tour], { 'is-admin': false })?.id, 'ml-start');
    assert.equal(tourToSuggestOnEvent(fresh, 'tab-opened-ml', context, [tour])?.id, 'ml-start');
    assert.equal(tourToSuggestOnPage(fresh, 'sidepanel', context, [tour], { 'is-admin': true }), null);
    assert.equal(tourToSuggestOnPage(fresh, 'sidepanel', context, [tour], {})?.id, 'ml-start');
});

test('unavailableIf: 初回のバナーの判定（shouldSuggest）には影響しない（条件を渡さない availableTours を使う）', () => {
    // 条件を渡さない availableTours は unavailableIf を見ないので、unavailableIf を持つ実在のツアーも一覧に残る。
    // 実在のツアーが unavailableIf を持つかどうかには依存しない書き方（持たなければ後半は空の繰り返しになる）
    const listed = availableTours(context).map(tour => tour.id);
    for (const tour of Object.values(GUIDE_TOURS)) {
        if (tour.unavailableIf === undefined || tour.draft) continue;
        const applicable = tour.platforms.includes(context.platform)
            && !(tour.audience === 'admin' && !context.capabilities.createProject);
        assert.equal(listed.includes(tour.id), applicable, `${tour.id}: 条件を渡さなければ unavailableIf で外れない`);
    }
    // 初回のバナーは、使えるツアーのどれも済・却下でないときに出る（unavailableIf があっても同じ）
    const fresh = createEmptyGuideProgress();
    assert.equal(shouldSuggest(fresh, { screen: 'project', ...context }), listed.length > 0);
    // 使えるツアーのどれかを済にすると出なくなる
    if (listed.length > 0) {
        const done = completeTour(fresh, availableTours(context)[0].id, '2026-01-01T00:00:00.000Z');
        assert.equal(shouldSuggest(done, { screen: 'project', ...context }), false);
    }
});

test('decideProgressSync: 保存値を正として、表示していなければ何もせず、終わった・置き換わったら片づけ、手順が違えば切り替える', () => {
    const active = (tourId: 'fulltext-page' | 'join-project', stepIndex: number) => ({ tourId, stepId: 'x', stepIndex });
    const shown = { tourId: 'fulltext-page', stepIndex: 2 } as const;
    assert.deepEqual(decideProgressSync(active('fulltext-page', 4), null), { type: 'none' }, '表示していない画面は何もしない');
    assert.deepEqual(decideProgressSync(null, shown), { type: 'close' }, 'ツアーが終わった・やめた');
    assert.deepEqual(decideProgressSync(active('join-project', 0), shown), { type: 'close' }, '別のツアーに置き換わった');
    assert.deepEqual(decideProgressSync(active('fulltext-page', 2), shown), { type: 'none' }, '同じ手順なら何もしない（通知が往復しない）');
    assert.deepEqual(decideProgressSync(active('fulltext-page', 4), shown), { type: 'switch', stepIndex: 4 }, '進んだ手順へ追従する');
    assert.deepEqual(decideProgressSync(active('fulltext-page', 1), shown), { type: 'switch', stepIndex: 1 }, '保存値が正なので、戻っていてもそれに合わせる');
});

test('別の画面の保存値に追従するランナーは、追従で保存しない（通知が往復しない）', () => {
    const runner = read('src', 'guide-ui', 'tour-runner.ts');
    const body = /subscribeGuideProgressChange\(\(\) => \{([\s\S]*?)\n {8}\}\);/.exec(runner)?.[1] ?? '';
    assert.ok(body.includes('decideProgressSync'), '購読の中で decideProgressSync を使う');
    assert.doesNotMatch(body, /updateGuideProgress/, '購読の中で保存しない');
});
