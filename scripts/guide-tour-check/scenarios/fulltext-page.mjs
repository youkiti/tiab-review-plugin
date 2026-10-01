// ツアー fulltext-page（全文の判定ページ fulltext.html）: 初回の提案の帯 → 実際に押して最後まで →
// 「ツアー」ボタンから押さずに次へだけで最後まで → 再読み込みでの再開 → サイドパネルのツアーとの置き換え
//
// 全文の判定ページは、サイドパネルの接続フローを通さず、デモのサインイン済みフラグとプロジェクト ID を書いて直接開く
// （run.openFulltextPage）。デモの既定データでは demo-ref-001・demo-ref-002 が候補（自分の TiAb Include）になり、
// demo-ref-001 には PDF のフィクスチャがある。実際に押す経路では、demo-ref-001 を Exclude して理由を選ぶ
// （保存して demo-ref-002 へ進む。デモのシート（メモリ上）にだけ書かれる）。

import path from 'node:path';
import { OUT_DIR, sleep, STEP_TIMEOUT } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectDialogWaitingEnded } from '../lib/checks.mjs';

const T = 'fulltext-page';
const FIRST_REF = 'demo-ref-001';
const SECOND_REF = 'demo-ref-002';

/** カードが画面内に収まり、「次へ」「ツアーを終える」が画面内にあること（幅・高さの確認）。 */
async function expectCardInViewport(run, stepLabel) {
    await sleep(500);
    const check = await run.page.evaluate(() => {
        const card = document.getElementById('guide-tour-card');
        if (!card) return { ok: false, reason: 'カードが無い' };
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const c = card.getBoundingClientRect();
        const horizontalScroll = document.documentElement.scrollWidth > vw || document.body.scrollWidth > vw;
        return {
            ok: c.left >= 0 && c.top >= 0 && c.right <= vw && c.bottom <= vh && !horizontalScroll,
            reason: `card=${JSON.stringify(c)} viewport=${vw}x${vh} 横スクロール=${horizontalScroll}`,
        };
    });
    if (!check.ok) await run.fail(stepLabel, `カードが画面内に収まり、横スクロールが出ないこと（${check.reason}）`);
}

/** カードが対象の強調枠と重ならないこと（対象が画面内に見えているときだけ）。 */
async function expectCardClearOfHighlight(run, stepLabel) {
    await sleep(300);
    const check = await run.page.evaluate(() => {
        const card = document.getElementById('guide-tour-card');
        const highlight = document.getElementById('guide-tour-highlight');
        if (!card || !highlight || highlight.classList.contains('hidden')) return { ok: true, skipped: true };
        const c = card.getBoundingClientRect();
        const h = highlight.getBoundingClientRect();
        const overlap = c.left < h.right && c.right > h.left && c.top < h.bottom && c.bottom > h.top;
        return { ok: !overlap, reason: `card=${JSON.stringify(c)} highlight=${JSON.stringify(h)}` };
    });
    if (check.skipped) return run.log(`${stepLabel}: 強調枠が画面外のため、カードとの重なりの確認を省略`);
    if (!check.ok) await run.fail(stepLabel, `カードが強調された対象に重ならないこと（${check.reason}）`);
}

/** カードが期待の手順になるのを待ち、カードが画面内に収まり対象に重ならないことを確かめる。 */
async function walk(run, stepId) {
    await run.waitStep(T, stepId);
    await expectCardInViewport(run, stepId);
    await expectCardClearOfHighlight(run, stepId);
}

export default defineScenario({
    name: 'fulltext-page',
    title: 'ツアー fulltext-page（全文の判定ページ）',
    defaultRun: true,
    async run(run) {
        // 既定の縦長（500x1000。サイドパネル向け）ではこのページは窄すぎるので、幅の広い画面にする
        // （--size で 900x700 などを指定したときは、その大きさのまま）
        const size = run.page.viewportSize();
        if (size && size.width < 800) await run.page.setViewportSize({ width: 1400, height: 900 });

        // ---------- 1. 初めて開いたときの提案の帯 → 開始 ----------
        await run.openFulltextPage(FIRST_REF);
        await run.waitVisible('#guide-page-suggest', 'band', '初回の提案の帯');
        const bandActions = await run.page.locator('#guide-page-suggest [data-guide-action]')
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-guide-action')));
        if (bandActions.sort().join(',') !== 'dismiss,start') {
            await run.fail('band', `帯のボタンの data-guide-action が dismiss と start であること（実際: ${bandActions.join(',')}）`);
        }
        await run.shot('band');
        await run.click('#guide-page-suggest [data-guide-action="start"]', 'band', '帯の「ツアーで進める」');
        await run.expectAbsent('#guide-page-suggest', 'band', '開始後の提案の帯', 1500);

        // ---------- 2. 実際に押して進む経路 ----------
        await walk(run, 'biblio');
        await run.clickNext('biblio');
        await walk(run, 'pdf');
        await run.clickNext('pdf');

        // レビュー基準のモーダル: 開くと「ダイアログ待ち」になり、閉じると元の手順に戻る
        await walk(run, 'criteria');
        await run.click('#ft-criteria-btn', 'criteria', '「基準」ボタン');
        try {
            await run.page.waitForFunction(() => {
                const card = document.getElementById('guide-tour-card');
                const next = card?.querySelector('[data-guide-action="next"]');
                return card?.getAttribute('data-guide-waiting-reason') === 'modal'
                    && next !== null && getComputedStyle(next).display === 'none';
            }, null, { timeout: 5000 });
        } catch (err) {
            await run.fail('criteria', 'レビュー基準のモーダルが開いている間、カードが data-guide-waiting-reason="modal" で「次へ」が隠れていること', err);
        }
        await sleep(300);
        await run.shot('criteria-modal');
        await run.page.locator('#ft-criteria-close-btn').click();
        await expectDialogWaitingEnded(run, 'criteria');
        await run.waitStep(T, 'criteria');
        await run.clickNext('criteria');

        // 判定: Exclude を押すと理由の欄が出て、理由の手順へ進む
        await walk(run, 'decision');
        await run.click('#ft-btn-exclude', 'decision', '判定ボタン（Exclude）');
        await walk(run, 'reason');
        await run.waitVisible('#ft-reason-select', 'reason', '除外理由の選択肢');
        // 理由を選ぶ（クリックで確定。保存して次の候補へ進む）
        await run.page.locator('#ft-reason-select option').first().click({ timeout: 10000 });
        await run.waitStep(T, 'context');
        await run.page.waitForFunction((ref) => new URL(location.href).searchParams.get('ref_id') === ref, SECOND_REF, { timeout: STEP_TIMEOUT })
            .catch((err) => run.fail('reason', `理由の確定で次の候補（${SECOND_REF}）へ進むこと`, err));
        run.log('除外の判定が保存され、次の候補へ進んだ');

        await walk(run, 'context');
        await run.clickNext('context');
        await walk(run, 'evidence');
        await run.clickNext('evidence');
        await walk(run, 'navigate');
        await run.clickNext('navigate');
        await walk(run, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: fulltext-page が done');

        // ---------- 3. 「ツアー」ボタンから、押さずに次へだけで最後まで ----------
        await run.click('[data-guide-action="start-tour"]', 'restart', '「ツアー」ボタン');
        await run.waitStep(T, 'biblio');
        await run.clickNext('biblio');
        await run.waitStep(T, 'pdf');
        await run.clickNext('pdf');
        await run.waitStep(T, 'criteria');
        await run.clickNext('criteria');
        await run.waitStep(T, 'decision');

        // 手順の途中でページを開き直すと、同じ手順から再開する（提案の帯は出ない）
        run.log('手順 decision でページを再読み込みします');
        await run.page.reload();
        await run.waitStep(T, 'decision');
        await run.closeCriteriaModal();
        await run.expectAbsent('#guide-page-suggest', 'resume', '再開中の提案の帯', 1500);
        run.log('再読み込み後も手順 decision から再開しました');

        // 判定を押さずに次へ。理由の欄は出ていないので、説明の手順（reason-info）になる
        await run.clickNext('decision');
        await run.waitStep(T, 'reason-info');
        await run.clickNext('reason-info');
        await run.waitStep(T, 'context');
        await run.clickNext('context');
        await run.waitStep(T, 'evidence');
        await run.clickNext('evidence');
        await run.waitStep(T, 'navigate');
        await run.clickNext('navigate');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');

        // ---------- 4. サイドパネルのツアーとの置き換え（同時に走るのは1本だけ。置き換えられた側のカードは消える） ----------
        const sidepanel = await run.page.context().newPage();
        await sidepanel.goto(run.sidepanelUrl());
        // サインイン済みフラグは全文の判定ページを開くときに書いてあるので、ログイン画面を経ずにプロジェクト選択画面が出る
        await sidepanel.locator('[data-tour="tour-list"]:visible').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
        // ❓ → 操作ツアーの一覧 → join-project を始める
        let listChecked = false;
        const startSidepanelTour = async () => {
            await sidepanel.locator('[data-tour="tour-list"]:visible').first().click({ timeout: STEP_TIMEOUT });
            await sidepanel.locator('.guide-popover [data-guide-action="tour-list"]').click({ timeout: STEP_TIMEOUT });
            if (!listChecked) {
                // ツアー一覧に、このツアーの行が「全文タブで文献を開くと始められます」の案内つき（開始ボタンなし）で出る
                listChecked = true;
                const item = sidepanel.locator('[data-guide-tour-item="fulltext-page"]');
                await item.waitFor({ state: 'visible', timeout: STEP_TIMEOUT })
                    .catch((err) => run.fail('tour-list', 'サイドパネルのツアー一覧に fulltext-page の行が出ること', err));
                const hints = await item.locator('[data-guide-tour-hint="fulltext"]').count();
                const starts = await item.locator('[data-guide-action="start"]').count();
                if (hints !== 1 || starts !== 0) {
                    await run.fail('tour-list', `fulltext-page の行に案内（1つ）があり、開始ボタンが無いこと（案内 ${hints}・開始ボタン ${starts}）`);
                }
                await item.scrollIntoViewIfNeeded();
                await sidepanel.screenshot({ path: path.join(OUT_DIR, `${run.name}-tour-list-sidepanel.png`) });
                run.log('サイドパネルのツアー一覧に fulltext-page の行（案内つき・開始ボタンなし）を確認');
            }
            const row = sidepanel.locator('[data-guide-tour-item="join-project"] [data-guide-action="start"]');
            await row.click({ timeout: STEP_TIMEOUT });
        };
        const cardTour = (page) => page.evaluate(() => document.getElementById('guide-tour-card')?.getAttribute('data-guide-tour') ?? null);
        const waitCard = async (page, expected, label) => {
            try {
                await page.waitForFunction(
                    (tour) => (document.getElementById('guide-tour-card')?.getAttribute('data-guide-tour') ?? null) === tour,
                    expected, { timeout: STEP_TIMEOUT },
                );
            } catch (err) {
                await run.fail('replace', `${label}（カードのツアー: ${expected ?? 'なし'}）になること（実際: ${await cardTour(page)}）`, err);
            }
        };

        await startSidepanelTour();
        await waitCard(sidepanel, 'join-project', 'サイドパネルで join-project のカードが出ている');

        // 全文の判定ページで fulltext-page を始めると、サイドパネルのカードは消える
        await run.page.bringToFront();
        await run.click('[data-guide-action="start-tour"]', 'replace', '「ツアー」ボタン');
        await run.waitStep(T, 'biblio');
        await waitCard(sidepanel, null, 'サイドパネルの join-project のカードが消えている');
        run.log('全文の判定ページでツアーを始めると、サイドパネルのカードが消えた');

        // 逆: サイドパネルで join-project を始めると、全文の判定ページのカードは消える
        await sidepanel.bringToFront();
        await startSidepanelTour();
        await waitCard(sidepanel, 'join-project', 'サイドパネルで join-project のカードが再び出ている');
        await waitCard(run.page, null, '全文の判定ページの fulltext-page のカードが消えている');
        run.log('サイドパネルでツアーを始めると、全文の判定ページのカードが消えた');
        const progress = await run.readProgress();
        if (progress?.active?.tourId !== 'join-project') {
            await run.fail('replace', `保存値の active が join-project になること（実際: ${JSON.stringify(progress?.active)}）`);
        }
        await sidepanel.close();
    },
});
