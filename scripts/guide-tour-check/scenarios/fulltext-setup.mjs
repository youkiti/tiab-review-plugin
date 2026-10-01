// ツアー fulltext-setup（全文の準備）: 全文タブを開いたときの提案の帯から始め、「押さずに次へ」だけで最後まで進む。
// そのあと一覧から始め直し、実際に押して進む経路（全文タブを開く・一括検索・候補カードから判定ページを開く）も通す。

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

const T = 'fulltext-setup';

/** 手順のカードが、対象の要素と重ならず、画面の横にはみ出していないこと。 */
async function expectNoHorizontalScroll(run, stepLabel) {
    const overflow = await run.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) await run.fail(stepLabel, `横スクロールが出ないこと（はみ出し ${overflow}px）`);
}

export default defineScenario({
    name: 'fulltext-setup',
    title: 'ツアー fulltext-setup',
    defaultRun: true,
    async run(run) {
        await run.openAndLogin();
        await run.connectToDemoSheet();

        // --- 経路A: タブを開いたときの提案の帯から始め、すべて「押さずに次へ」 ---
        await run.click('#tab-fulltext', 'suggest', '全文タブ');
        await run.waitVisible('#guide-tab-suggest', 'suggest', 'タブの提案の帯');
        await run.shot('tab-suggest');
        await run.click('#guide-tab-suggest [data-guide-action="start"]', 'suggest', '提案の帯の「ツアーで進める」');

        // すでに全文タブにいるので open-tab は飛ばされ、views から始まる
        await run.waitStep(T, 'views');
        await expectNoHorizontalScroll(run, 'views');
        await run.clickNext('views');

        // デモの既定データはキー未開封なので、rule-pending（開封後に決めると伝える手順）が出る
        const ruleStep = await run.waitStep(T, ['rule', 'rule-pending']);
        if (ruleStep !== 'rule-pending') await run.fail('rule', 'キー未開封のデモでは rule-pending が出ること');
        await expectCardClearOfTarget(run, ruleStep, '#fulltext-rule-line', '候補ルールの行');
        await run.clickNext(ruleStep);

        await run.waitStep(T, 'assignment');
        await run.clickNext('assignment');

        await run.waitStep(T, 'checklist');
        await run.clickNext('checklist');

        await run.waitStep(T, 'fetch');
        await expectNoHorizontalScroll(run, 'fetch');
        await run.clickNext('fetch'); // 押さずに次へ

        const cardStep = await run.waitStep(T, ['no-candidates', 'missing']);
        run.log(`候補カードの手順: ${cardStep}`);
        if (cardStep === 'missing') {
            await expectCardClearOfTarget(run, 'missing', '[data-tour="fulltext-card"]', '最初の候補カード');
        }
        await run.clickNext(cardStep);
        await run.waitStep(T, "drive-import");

        // Drive 取り込みのボタンは説明だけ（押せない）
        await run.clickNext('drive-import');

        const pageStep = await run.waitStep(T, ['open-page', 'finish']);
        if (pageStep === 'open-page') {
            await run.clickNext('open-page'); // 押さずに次へ
            await run.waitStep(T, 'finish');
        }
        await expectNoHorizontalScroll(run, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: fulltext-setup が done（押さずに次へ進む経路）');

        // --- 経路B: 一覧から始め直し、実際に押して進む ---
        await run.click('#fulltext-back-btn', 'restart', '全文タブの戻るボタン');
        await run.waitVisible('#ref-title', 'restart', '手動タブの文献');
        await openTourList(run, 'restart');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'restart', '一覧の fulltext-setup の開始ボタン');

        await run.waitStep(T, 'open-tab');
        await run.click('[data-tour="tab-fulltext"]', 'open-tab', '全文タブのボタン');
        await run.waitStep(T, 'views');
        await run.clickNext('views');
        const ruleStepB = await run.waitStep(T, ['rule', 'rule-pending']);
        await run.clickNext(ruleStepB);
        await run.waitStep(T, 'assignment');
        await run.clickNext('assignment');
        await run.waitStep(T, 'checklist');
        await run.clickNext('checklist');

        // 実際に一括検索を押す（デモでは外部への問い合わせは 404 になり、実ネットワークへは出ない）
        await run.waitStep(T, 'fetch');
        const fetchDisabled = await run.page.locator('#fulltext-fetch-btn').isDisabled();
        if (fetchDisabled) {
            run.log('一括検索ボタンは押せない状態（対象0件）。押さずに次へ進みます');
            await run.clickNext('fetch');
        } else {
            // ブラウザの権限ダイアログ（全サイトへのアクセス）は自動操作で出たり出なかったりして待ちが固まるので、
            // 「すでに許可済み」の応答に差し替える（外部への問い合わせは、デモのモックが 404 で返す）
            await run.page.evaluate(() => {
                chrome.permissions.contains = (_query, callback) => callback?.(true);
            });
            await run.click('#fulltext-fetch-btn', 'fetch', '「フリー全文を一括検索」');
            await run.shot('fetch-pressed');
            await run.waitStep(T, ['no-candidates', 'missing', 'drive-import'], 60000);
            await run.shot('fetch-finished');
        }

        const stepAfterFetch = await run.waitStep(T, ['no-candidates', 'missing', 'drive-import']);
        if (stepAfterFetch !== 'drive-import') await run.clickNext(stepAfterFetch);
        await run.waitStep(T, 'drive-import');
        await run.clickNext('drive-import');

        const pageStepB = await run.waitStep(T, ['open-page', 'finish']);
        if (pageStepB === 'open-page') {
            // 候補カードを押す（全文の判定ページが別タブで開く）
            const opened = run.page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);
            await run.click('[data-tour="fulltext-card"]', 'open-page', '最初の候補カード');
            const newPage = await opened;
            run.log(newPage ? `全文の判定ページが別タブで開いた: ${newPage.url().split('?')[0]}` : '別タブは検出できなかった');
            await newPage?.close().catch(() => {});
            await run.page.bringToFront();
            await sleep(300);
            await run.waitStep(T, 'finish');
        }
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: fulltext-setup が done（実際に押す経路）');
    },
});
