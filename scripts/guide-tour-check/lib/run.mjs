// シナリオ1回ぶんの実行状態（ページ・拡張機能 ID・スクリーンショット連番）と、シナリオが使う操作・待ちの道具。

import path from 'node:path';
import { OUT_DIR, REPO_ROOT, STEP_TIMEOUT, ACTION_TIMEOUT, NEGATIVE_WAIT, DEMO_SHEET_URL, sleep } from './constants.mjs';

export class Run {
    constructor(name, page, extId, lang) {
        this.name = name;
        this.page = page;
        this.extId = extId;
        this.lang = lang;
        this.shotCount = 0;
        this.shots = [];
    }

    log(message) {
        console.log(`  [${this.name}] ${message}`);
    }

    async shot(label) {
        this.shotCount += 1;
        const file = path.join(OUT_DIR, `${this.name}-${String(this.shotCount).padStart(2, '0')}-${label}.png`);
        await this.page.screenshot({ path: file }).catch(() => {});
        this.shots.push(path.relative(REPO_ROOT, file));
        return file;
    }

    /** 待ちが切れたとき、シナリオ名・手順・待っていたもの・カードの属性・スクリーンショットを出して例外にする。 */
    async fail(stepLabel, waiting, cause) {
        const card = await this.cardAttrs();
        const file = await this.shot(`FAIL-${stepLabel}`);
        const detail = cause ? `\n    原因: ${cause instanceof Error ? cause.message.split('\n')[0] : cause}` : '';
        throw new Error(
            `シナリオ ${this.name} / 手順 ${stepLabel} で待ちが切れました: ${waiting}\n` +
            `    カードの属性: ${card}\n    スクリーンショット: ${path.relative(REPO_ROOT, file)}${detail}`,
        );
    }

    async cardAttrs() {
        try {
            return await this.page.evaluate(() => {
                const card = document.getElementById('guide-tour-card');
                if (!card) return '(#guide-tour-card なし)';
                return JSON.stringify(Object.fromEntries(Array.from(card.attributes).map((a) => [a.name, a.value])));
            });
        } catch {
            return '(取得失敗)';
        }
    }

    /** 開いているアプリ内モーダルがあれば閉じる（取り込み後の確認や案内など）。 */
    async closeModal() {
        const open = await this.page.locator('#modal-backdrop:not(.hidden)').count().catch(() => 0);
        if (open > 0) {
            await this.page.locator('#modal-close-btn').click({ timeout: 3000 }).catch(() => {});
            await sleep(200);
        }
    }

    /** カードの手順 ID が expected（文字列または配列）のどれかになるのを待ち、実際の ID を返す。 */
    async waitStep(tourId, expected, timeout = STEP_TIMEOUT) {
        const ids = Array.isArray(expected) ? expected : [expected];
        const label = ids.join('|');
        try {
            await this.page.waitForFunction(
                ({ tour, steps }) => {
                    const card = document.getElementById('guide-tour-card');
                    if (!card) return false;
                    return card.getAttribute('data-guide-tour') === tour && steps.includes(card.getAttribute('data-guide-step'));
                },
                { tour: tourId, steps: ids },
                { timeout },
            );
        } catch (err) {
            await this.fail(label, `#guide-tour-card が data-guide-tour="${tourId}" data-guide-step="${label}" になること`, err);
        }
        const actual = await this.page.locator('#guide-tour-card').getAttribute('data-guide-step');
        this.log(`手順 ${actual} に到達`);
        await sleep(300); // 吹き出しの描画と強調枠の位置合わせを待つ
        await this.shot(actual);
        return actual;
    }

    /** 要素が押せる状態になるのを待って押す。押せなければ失敗。 */
    async click(selector, stepLabel, what) {
        await this.closeModal();
        try {
            await this.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
        } catch (err) {
            await this.fail(stepLabel, `${what}（${selector}）を押せること`, err);
        }
    }

    /** カードの「次へ」（最後の手順では「完了」、optional な手順では「押さずに次へ」）を押す。 */
    async clickNext(stepLabel) {
        await this.click('#guide-tour-card [data-guide-action="next"]', stepLabel, 'カードの「次へ」');
    }

    async waitVisible(selector, stepLabel, what, timeout = STEP_TIMEOUT) {
        try {
            await this.page.locator(selector).first().waitFor({ state: 'visible', timeout });
        } catch (err) {
            await this.fail(stepLabel, `${what}（${selector}）が表示されること`, err);
        }
    }

    /** セレクタに合う要素が timeout の間ずっと現れないこと。現れたら失敗。 */
    async expectAbsent(selector, stepLabel, what, timeout = NEGATIVE_WAIT) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await this.page.locator(selector).first().isVisible().catch(() => false)) {
                await this.fail(stepLabel, `${what}（${selector}）が現れないこと（現れてしまった）`);
            }
            await sleep(250);
        }
    }

    async waitCardGone(stepLabel) {
        try {
            await this.page.waitForFunction(() => {
                const card = document.getElementById('guide-tour-card');
                if (!card) return true;
                const style = getComputedStyle(card);
                return card.hidden || style.display === 'none' || style.visibility === 'hidden';
            }, null, { timeout: STEP_TIMEOUT });
        } catch (err) {
            await this.fail(stepLabel, '#guide-tour-card が消えること', err);
        }
    }

    /** chrome.storage.local の guide_progress（保存値の形はツアーの進行状態そのまま）を読む。無ければ null。 */
    async readProgress() {
        return this.page.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get('guide_progress', (items) => resolve(items.guide_progress ?? null));
        }));
    }

    /** guide_progress の tours[tourId].status が expected になるのを待つ。 */
    async waitTourStatus(tourId, expected, stepLabel) {
        const deadline = Date.now() + STEP_TIMEOUT;
        let last = null;
        while (Date.now() < deadline) {
            last = await this.readProgress().catch(() => null);
            if (last?.tours?.[tourId]?.status === expected) return;
            await sleep(300);
        }
        await this.fail(stepLabel, `guide_progress.tours["${tourId}"].status が "${expected}" になること（実際: ${JSON.stringify(last)}）`);
    }

    sidepanelUrl(query = '') {
        return `chrome-extension://${this.extId}/sidepanel/sidepanel.html${query}`;
    }

    /** 未サインインで開き、ダイアログを一括処理する設定を入れてから、ログインボタンでサインインする。 */
    async openAndLogin(query = '') {
        // prompt（プロジェクト名）・confirm・alert はすべて承諾する
        this.page.on('dialog', (dialog) => {
            const accept = dialog.type() === 'prompt' ? dialog.accept('ツアー検証用プロジェクト') : dialog.accept();
            accept.catch(() => {});
        });
        await this.page.goto(this.sidepanelUrl(query));
        await this.waitVisible('#login-btn', 'login', 'ログインボタン');
        await this.click('#login-btn', 'login', 'ログインボタン');
        await this.waitVisible('#project-section', 'login', 'プロジェクト選択画面');
    }

    /**
     * デモの既定データ（抄録つきの文献を含む）のシートへ、URL 欄から接続する（openAndLogin のあとに呼ぶ）。
     * 新規作成の取り込み（抄録なし）を使わずにスクリーニング画面へ入りたいシナリオ用。
     */
    async connectToDemoSheet(stepLabel = 'setup') {
        await this.page.locator('#spreadsheet-input').fill(DEMO_SHEET_URL);
        await this.click('#connect-btn', stepLabel, '接続ボタン');
        await this.waitVisible('#ref-title', stepLabel, '文献のタイトル');
        await sleep(1000);
        await this.closeModal();
    }

    /** 自動提案バナーが出て、指定のボタンで始められることを確かめて押す。 */
    async startFromBanner(action) {
        await this.waitVisible('#guide-suggest-banner', 'banner', '自動提案のバナー');
        await this.shot('banner');
        await this.click(`#guide-suggest-banner [data-guide-action="${action}"]`, 'banner', `バナーの ${action}`);
    }
}
