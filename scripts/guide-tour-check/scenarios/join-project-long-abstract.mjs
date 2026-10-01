// 長い抄録の文献で、ツアー2（join-project）の read・decide の配置を確かめる

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget } from '../lib/checks.mjs';

export default defineScenario({
    name: 'join-project-long-abstract',
    title: '長い抄録でのツアー2（read・decide の配置）',
    defaultRun: true,
    async run(run) {
        const T = 'join-project';
        await run.openAndLogin();
        // 新規作成の取り込み（抄録なし）ではなく、デモの既定データ（抄録つきの文献を含む）に接続する
        await run.connectToDemoSheet('setup');

        // 抄録がいちばん長い文献を探して、そこへ移る
        const lengths = [];
        for (let i = 0; i < 10; i += 1) {
            lengths.push(await run.page.evaluate(() => document.getElementById('ref-abstract').textContent.length));
            const next = run.page.locator('#btn-next');
            if (await next.isDisabled().catch(() => true)) break;
            await next.click();
            await sleep(300);
        }
        const longest = lengths.indexOf(Math.max(...lengths));
        run.log(`抄録の文字数: ${lengths.join(', ')}（最大は ${longest + 1} 件目）`);
        if (lengths[longest] < 1500) throw new Error('抄録が1500字以上の文献が見つかりません（検証の前提が崩れている）');
        // 一周して戻ってくることもあるので、位置を数えず、抄録の長さが最大に一致するまで進める
        const maxLength = lengths[longest];
        for (let i = 0; i < lengths.length + 2; i += 1) {
            const now = await run.page.evaluate(() => document.getElementById('ref-abstract').textContent.length);
            if (now === maxLength) break;
            await run.page.locator('#btn-next').click();
            await sleep(300);
        }
        await run.page.evaluate(() => window.scrollTo(0, 0));

        // ❓ → 操作ツアーの一覧 → 「参加」ツアーを始める（接続の手順は画面がスクリーニングなので飛ばされる）
        await run.click('[data-tour="tour-list"]:visible', 'start', '❓ ボタン');
        await run.click('.guide-popover [data-guide-action="tour-list"]', 'start', '吹き出しの「操作ツアーの一覧」ボタン');
        await run.waitVisible('#guide-tour-list', 'start', 'ツアー一覧パネル');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ツアー2の開始ボタン');

        const reached = await run.waitStep(T, ['assignment', 'read']);
        if (reached === 'assignment') {
            await run.clickNext('assignment');
            await run.waitStep(T, 'read');
        }
        await expectCardClearOfTarget(run, 'read', '#ref-title', '文献のタイトル');
        await run.clickNext('read');
        await run.waitStep(T, 'decide');
        await expectCardClearOfTarget(run, 'decide', '.decision-buttons', '判定ボタン');
        // 抄録が画面に残っていること（カードが抄録の本文を丸ごと覆わない）は、保存したスクリーンショットで目視する
        await run.click('#btn-include', 'decide', '判定ボタン（Include）');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');

        // スクリーニング画面のツールバーの ❓ の吹き出しにも「操作ツアーの一覧」がある
        await run.click('[data-tour="tour-list"]:visible', 'toolbar-popover', 'ツールバーの ❓ ボタン');
        await run.waitVisible('.guide-popover [data-guide-action="tour-list"]', 'toolbar-popover', '吹き出しの「操作ツアーの一覧」ボタン');
        await run.shot('toolbar-popover');
    },
});
