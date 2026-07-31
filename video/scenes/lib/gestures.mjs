// マウス操作の「間」を作るための共通ヘルパー
//
// Playwright の locator.hover() / page.mouse.wheel() は瞬時に実行されてしまい、
// 視聴者が「何を指しているか」を認識する前に次の操作に移ってしまう。
// ここでは複数回に分けて少しずつ動かし、その間に待ち時間を挟むことで、
// ナレーションに合わせたゆっくりした操作に見せる。

/**
 * 指定した locator の中心へ、ゆっくりマウスを移動してホバー状態にする。
 * 既存のマウス位置からではなく、要素の少し上から近づく体裁にする。
 */
export async function hoverSlow(page, locator, { durationMs = 700, steps = 14 } = {}) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
        await locator.hover().catch(() => {});
        return;
    }
    const targetX = box.x + box.width / 2;
    const targetY = box.y + box.height / 2;
    const startX = targetX - 60;
    const startY = targetY - 40;
    const stepDelay = durationMs / steps;
    for (let i = 1; i <= steps; i += 1) {
        const ratio = i / steps;
        await page.mouse.move(startX + (targetX - startX) * ratio, startY + (targetY - startY) * ratio);
        await page.waitForTimeout(stepDelay);
    }
}

/**
 * 複数の locator を順番にゆっくりホバーしていく。各要素の間には holdMs だけ留まる。
 */
export async function hoverSequence(page, locators, { holdMs = 500, moveMs = 500 } = {}) {
    for (const locator of locators) {
        await hoverSlow(page, locator, { durationMs: moveMs });
        await page.waitForTimeout(holdMs);
    }
}

/**
 * page.mouse.wheel を小刻みに分割して呼び出し、滑らかにスクロールしているように見せる。
 * totalDeltaY が正なら下方向へ、負なら上方向へスクロールする。
 */
export async function smoothWheel(page, totalDeltaY, { steps = 12, stepDelayMs = 90 } = {}) {
    const perStep = totalDeltaY / steps;
    for (let i = 0; i < steps; i += 1) {
        await page.mouse.wheel(0, perStep);
        await page.waitForTimeout(stepDelayMs);
    }
}
