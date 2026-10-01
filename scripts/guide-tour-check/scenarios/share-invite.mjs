// ツアー share-invite（共有と招待）: 実際に追加・コピーして進む経路と、全部「押さずに次へ」で進む経路の両方

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, expectTourListDone, openTourList } from '../lib/checks.mjs';

const T = 'share-invite';
const NEW_MEMBER = 'newmember@example.com';
const COLLEAGUE = 'colleague@example.com';

/** ❓ の一覧からこのツアーを（もう一度）始める。 */
async function startFromList(run) {
    await openTourList(run, 'start');
    await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');
}

/** 共有済み一覧を覆う手順で、✕ を押そうとしても解除されないこと（覆いに遮られて押せない場合も合格）。 */
async function expectRemoveBlocked(run) {
    const row = run.page.locator('.shared-user-item', { hasText: COLLEAGUE });
    await row.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => run.fail('shared-users', `${COLLEAGUE} の行が見えること`));
    let verdict;
    try {
        await row.locator('.shared-user-remove-btn').click({ timeout: 3000 });
        verdict = 'クリックは通ったが一覧を確かめる';
    } catch {
        verdict = 'クリックが覆い・inert に遮られて押せなかった';
    }
    await sleep(1500);
    const remaining = await run.page.locator('.shared-user-item', { hasText: COLLEAGUE }).count();
    if (remaining === 0) await run.fail('shared-users', `✕ を押しても ${COLLEAGUE} が解除されないこと（解除されてしまった）`);
    run.log(`共有済みユーザーの ✕ は効かず（${verdict}）`);
    await run.shot('remove-blocked');
}

export default defineScenario({
    name: 'share-invite',
    title: 'ツアー share-invite',
    defaultRun: true,
    async run(run) {
        await run.openAndLogin();
        await run.connectToDemoSheet();

        // ---- 経路1: 実際に追加し、招待文をコピーして進む ----
        await startFromList(run);
        await run.waitStep(T, 'open-share');
        await run.click('#share-btn', 'open-share', '「共有」ボタン');

        await run.waitStep(T, 'add');
        await expectCardClearOfTarget(run, 'add', '#share-submit-btn', '追加ボタン');
        await run.page.locator('#share-email-input').fill(NEW_MEMBER);
        await run.click('#share-submit-btn', 'add', '追加ボタン');

        // 追加するとパネルが閉じるので、開き直す手順が出る
        await run.waitStep(T, 'reopen-share');
        await run.click('#share-btn', 'reopen-share', '「共有」ボタン');

        // リンク共有の警告はデモの権限には無いので、飛ばされて共有済みの一覧へ進む
        const reached = await run.waitStep(T, ['link-warning', 'shared-users']);
        if (reached === 'link-warning') {
            run.log('link-warning の手順が出ました（「次へ」で進めます）');
            await run.clickNext('link-warning');
            await run.waitStep(T, 'shared-users');
        } else {
            run.log('link-warning の手順は飛ばされました（リンク共有の警告が出ていない）');
        }
        await run.waitVisible(`.shared-user-item:has-text("${NEW_MEMBER}")`, 'shared-users', '追加した相手の行');
        await expectRemoveBlocked(run);
        await run.clickNext('shared-users');

        // 招待文のコピー: クリップボードが使えればイベントで進み、使えなければトーストが出るので「押さずに次へ」で進む
        await run.waitStep(T, 'copy-invite');
        await run.click('#share-copy-invite-btn', 'copy-invite', '「招待文をコピー」ボタン');
        const afterCopy = await run.waitStep(T, ['copy-invite', 'team-progress', 'team-progress-later'], 5000).catch(() => null);
        await sleep(1500);
        const stillOnCopy = await run.page.locator('#guide-tour-card').getAttribute('data-guide-step');
        if (stillOnCopy === 'copy-invite') {
            run.log(`クリップボードへ書けなかったとみられる（afterCopy=${afterCopy}）。「押さずに次へ」で進めます`);
            await run.shot('copy-failed-toast');
            await run.clickNext('copy-invite');
        } else {
            run.log(`コピー成功のイベントで ${stillOnCopy} へ進みました`);
        }

        // 共有パネルを閉じる手順（チップがパネルの下に隠れないように）。閉じると team-progress へ進む
        await run.waitStep(T, 'close-share');
        await run.click('#share-btn', 'close-share', '「共有」ボタン（パネルを閉じる）');
        await run.waitStep(T, ['team-progress', 'team-progress-later']);
        await run.clickNext(await run.page.locator('#guide-tour-card').getAttribute('data-guide-step'));
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: share-invite が done（経路1）');

        // ---- 経路2: 何も押さず、「押さずに次へ」だけで最後まで進む ----
        await startFromList(run);
        await run.waitStep(T, 'open-share');
        await run.click('#share-btn', 'open-share-2', '「共有」ボタン');
        await run.waitStep(T, 'add');
        await run.clickNext('add'); // 「押さずに次へ」: 何も追加しない
        // パネルは開いたままなので、開き直す手順は飛ばされる
        const reached2 = await run.waitStep(T, ['reopen-share', 'link-warning', 'shared-users']);
        if (reached2 === 'reopen-share') await run.fail('add', 'パネルが開いたままなら reopen-share は飛ばされること');
        if (reached2 === 'link-warning') {
            await run.clickNext('link-warning');
            await run.waitStep(T, 'shared-users');
        }
        await run.clickNext('shared-users');
        await run.waitStep(T, 'copy-invite');
        // クリップボードが使えない環境を再現する（writeText の拒否と execCommand の失敗）。トーストが出て、手順は進まない
        await run.page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: () => Promise.reject(new Error('denied')) },
            });
            document.execCommand = () => { throw new Error('execCommand unavailable'); };
        });
        await run.click('#share-copy-invite-btn', 'copy-invite', '「招待文をコピー」ボタン');
        try {
            await run.page.locator('#toast.show').waitFor({ state: 'visible', timeout: 3000 });
        } catch (err) {
            await run.fail('copy-invite', 'コピー失敗のトースト（#toast.show）が出ること', err);
        }
        const failToast = await run.page.locator('#toast').textContent();
        run.log(`コピー失敗のトースト: ${failToast}`);
        await run.shot('copy-failed-toast');
        const stepAfterFail = await run.page.locator('#guide-tour-card').getAttribute('data-guide-step');
        if (stepAfterFail !== 'copy-invite') await run.fail('copy-invite', 'コピーに失敗したら手順は進まないこと');
        await run.clickNext('copy-invite');
        await run.waitStep(T, 'close-share');
        await run.click('#share-cancel-btn', 'close-share', '共有パネルの閉じる（✕）ボタン'); // 別の閉じ方でも進む
        const team = await run.waitStep(T, ['team-progress', 'team-progress-later']);
        await run.clickNext(team);
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        run.log('「押さずに次へ」だけで最後まで進めた（経路2）');

        await expectTourListDone(run, T);
    },
});
