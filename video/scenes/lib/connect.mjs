// デモプロジェクトへの接続（共通操作）
//
// 「最近のスプレッドシート」ドロップダウンで index 1（デモプロジェクト）を選ぶと、
// 自動的に接続処理が走り、文献データを読み込んでスクリーニング画面に遷移する
// （sidepanel/features/project.ts の挙動。デモビルドの `#recent-sheets` は
// index 0 が読み込み中プレースホルダ、index 1 がデモプロジェクトになっている）。

/**
 * `#recent-sheets` からデモプロジェクトを選択し、接続完了（readySelector が表示される）
 * まで待つ。
 */
export async function connectDemoProject(page, { readySelector = '#btn-include', timeout = 15000 } = {}) {
    await page.locator('#recent-sheets').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#recent-sheets').selectOption({ index: 1 });
    await page.locator(readySelector).waitFor({ state: 'visible', timeout });
}
