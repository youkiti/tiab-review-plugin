// ツアー fulltext-page の動画用: 理由を選ばずに進み、PDF のある文献のまま最後まで撮る。

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';

const T = 'fulltext-page';
const FIRST_REF = 'demo-ref-001';

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

/** 保存して次の候補へ進んでいないことを確かめる。 */
async function expectFirstRef(run, stepLabel) {
    const refId = new URL(run.page.url()).searchParams.get('ref_id');
    if (refId !== FIRST_REF) {
        await run.fail(stepLabel, `文献が ${FIRST_REF} のままであること（実際: ${refId}）`);
    }
}

export default defineScenario({
    name: 'fulltext-page-video',
    title: 'ツアー fulltext-page（全文の判定ページ・動画用）',
    defaultRun: true,
    async run(run) {
        // サイドパネル向けの縦長画面では窄すぎるので、幅の広い画面にする。
        const size = run.page.viewportSize();
        if (size && size.width < 800) await run.page.setViewportSize({ width: 1400, height: 900 });

        await run.openFulltextPage(FIRST_REF);
        await run.waitVisible('#guide-page-suggest', 'band', '初回の提案の帯');
        await run.click('#guide-page-suggest [data-guide-action="start"]', 'band', '帯の「ツアーで進める」');

        // 基準のモーダルは開かず、カードの「次へ」で進む。
        for (const stepId of ['biblio', 'pdf', 'criteria']) {
            await walk(run, stepId);
            await run.clickNext(stepId);
        }
        await walk(run, 'decision');
        await run.click('#ft-btn-exclude', 'decision', '判定ボタン（Exclude）');
        await walk(run, 'reason');
        await run.waitVisible('#ft-reason-select', 'reason', '除外理由の選択肢');
        // 理由を選ぶと保存されるので、「押さずに次へ」で同じ文献を保つ。
        await run.clickNext('reason');

        await walk(run, 'context');
        await expectFirstRef(run, 'context');
        // PDF.js の表示領域に、描画完了したページの canvas が見えることを確かめる。
        // プレースホルダや iframe の表示では、この領域は隠される。
        await run.waitVisible('#ft-pdf-canvas-container:not(.hidden) .ft-page[data-render-state="rendered"] canvas', 'context', '描画された PDF のページ');
        await run.clickNext('context');
        for (const stepId of ['evidence', 'navigate', 'finish']) {
            await walk(run, stepId);
            await run.clickNext(stepId);
        }
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        await expectFirstRef(run, 'finish');
        run.log('同じ文献のまま fulltext-page の動画用撮影が完了');
    },
});
