/**
 * fulltext/drive-import/result-view.ts - Drive直接取り込み: 結果表示とクリーンアップ
 *
 * drive-import/ 全体の設計意図は同ディレクトリの index.ts 冒頭コメントを参照。
 * 本ファイルは exec.ts の実行結果（ExecResult）をモーダルに描画し、成功した取り込みについて
 * 元ファイルをゴミ箱へ移すクリーンアップUIを提供する。
 *
 * 再試行（retrySingle。実体は exec.ts 側）をここから直接importしていない理由: exec.ts は
 * runImportAndShowResults/retrySingle の中で本ファイルの renderResultStep を呼ぶため、
 * 本ファイルが exec.ts の retrySingle を直接importすると exec.ts ⇄ result-view.ts の循環import
 * になる（check-structure.mjs が新しい循環として検出する）。そのため renderResultStep の
 * 呼び出し元（exec.ts。呼び出し箇所は同一ファイル内に retrySingle 自身を持つ）から
 * retrySingle を引数で渡してもらう形にしている（openMappingModal の onClosed と同じ流儀）。
 */

import { dom as sharedDom } from '../../../dom';
import { state } from '../../../state';
import { t } from '../../../../lib/i18n';
import { showToast } from '../../../ui/feedback';
import { hideModal } from '../../../ui/modal';
import {
    ensureFulltextFolder,
    deleteDriveFile,
    describeDriveAccessError,
} from '../../../../lib/drive-api';
import { getProjectDriveFolderId } from '../../../../lib/sheets-api';
import type { ExecResult } from './types';

// フルテキストタブ全体を再描画するためのコールバック（fulltext/tab.ts から注入）
let _rerenderTab: (() => void) | null = null;
export function setFulltextDriveImportDeps(deps: { rerenderTab: () => void }): void {
    _rerenderTab = deps.rerenderTab;
}

/** 実行ループ中はモーダルの閉じるボタン(X)を無効化し、誤操作での中断を防ぐ */
export function setModalCloseEnabled(enabled: boolean): void {
    sharedDom.modalCloseBtn.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// ⑤ 結果表示 + クリーンアップ（元ファイルのゴミ箱移動）
// ---------------------------------------------------------------------------

export async function renderResultStep(
    body: HTMLElement,
    footer: HTMLElement,
    results: ExecResult[],
    retrySingle: (
        original: ExecResult,
        body: HTMLElement,
        footer: HTMLElement,
        allResults: ExecResult[]
    ) => Promise<void>
): Promise<void> {
    body.innerHTML = '';
    footer.innerHTML = '';

    const successCount = results.filter(r => r.outcome === 'success').length;
    const skippedCount = results.filter(r => r.outcome === 'skipped-cached').length;
    const errorCount = results.filter(r => r.outcome === 'error').length;

    const summary = document.createElement('p');
    summary.className = 'ft-import-summary';
    summary.textContent = t('fulltext_importDoneSummary', [String(successCount), String(skippedCount), String(errorCount)]);
    body.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'ft-import-row-list';
    body.appendChild(list);

    for (const r of results) {
        const row = document.createElement('div');
        row.className = `ft-import-result-row ft-import-result-row--${r.outcome}`;

        const name = document.createElement('span');
        name.className = 'ft-import-row-name';
        name.textContent = `${r.file.name} → ${r.refTitle}`;
        row.appendChild(name);

        const msg = document.createElement('span');
        msg.className = 'ft-import-result-msg';
        msg.textContent = r.message;
        row.appendChild(msg);

        if (r.outcome === 'error') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'btn btn-outline btn-small';
            retryBtn.textContent = t('fulltext_importRetryBtn');
            retryBtn.addEventListener('click', () => {
                retryBtn.disabled = true;
                void retrySingle(r, body, footer, results);
            });
            row.appendChild(retryBtn);
        }

        list.appendChild(row);
    }

    const cleanupTargets = results.filter(r => r.outcome === 'success');
    if (cleanupTargets.length > 0) {
        body.appendChild(await buildCleanupSection(cleanupTargets));
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary btn-small';
    closeBtn.textContent = t('fulltext_importCloseBtn');
    closeBtn.addEventListener('click', () => hideModal());
    footer.appendChild(closeBtn);

    setModalCloseEnabled(true);
    if (_rerenderTab) _rerenderTab();
}

async function buildCleanupSection(cleanupTargets: ExecResult[]): Promise<HTMLElement> {
    const section = document.createElement('div');
    section.className = 'ft-import-cleanup';

    const title = document.createElement('h4');
    title.className = 'ft-import-cleanup-title';
    title.textContent = t('fulltext_importCleanupTitle');
    section.appendChild(title);

    const intro = document.createElement('p');
    intro.className = 'ft-import-cleanup-intro';
    intro.textContent = t('fulltext_importCleanupIntro');
    section.appendChild(intro);

    let projectFolderId: string | null = null;
    try {
        projectFolderId = await getProjectDriveFolderId(state.spreadsheetId);
    } catch (err) {
        console.warn('[fulltext-drive-import] プロジェクトフォルダID取得に失敗（既定チェックはフォルダ外扱い）:', err);
    }
    let fulltextFolderId: string | null = null;
    try {
        fulltextFolderId = await ensureFulltextFolder(state.spreadsheetId);
    } catch (err) {
        // チェックボックスの初期状態（既知フォルダ内か）を絞れないだけなので処理は続行するが、
        // fail-fast エラー（アクセス拒否等）は原因が分かるよう別途通知する
        const knownMessage = describeDriveAccessError(err);
        if (knownMessage) showToast(knownMessage, 6000);
        console.warn('[fulltext-drive-import] fulltextフォルダID取得に失敗（既定チェックはフォルダ外扱い）:', err);
    }

    const list = document.createElement('div');
    list.className = 'source-file-list';
    const checkboxes: Array<{ result: ExecResult; checkbox: HTMLInputElement }> = [];

    for (const result of cleanupTargets) {
        const row = document.createElement('div');
        row.className = 'source-file-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `ft-import-cleanup-${result.file.id}`;
        checkbox.disabled = !result.file.canTrash;
        const inKnownFolder = !!(
            (projectFolderId && result.file.parents.includes(projectFolderId)) ||
            (fulltextFolderId && result.file.parents.includes(fulltextFolderId))
        );
        checkbox.checked = result.file.canTrash && inKnownFolder;

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = result.file.canTrash
            ? result.file.name
            : `${result.file.name} ${t('fulltext_importCleanupNoTrashPermission')}`;

        row.appendChild(checkbox);
        row.appendChild(label);
        list.appendChild(row);
        checkboxes.push({ result, checkbox });
    }
    section.appendChild(list);

    const note = document.createElement('p');
    note.className = 'ft-import-cleanup-note';
    note.textContent = t('fulltext_importCleanupNote');
    section.appendChild(note);

    const cleanupBtn = document.createElement('button');
    cleanupBtn.className = 'btn btn-danger btn-small';
    cleanupBtn.textContent = t('fulltext_importCleanupBtn');
    cleanupBtn.addEventListener('click', () => {
        void runCleanup(checkboxes, cleanupBtn);
    });
    section.appendChild(cleanupBtn);

    return section;
}

async function runCleanup(
    checkboxes: Array<{ result: ExecResult; checkbox: HTMLInputElement }>,
    button: HTMLButtonElement
): Promise<void> {
    const targets = checkboxes.filter(c => c.checkbox.checked && !c.checkbox.disabled);
    if (targets.length === 0) return;

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = t('fulltext_importCleanupRunning');

    let successCount = 0;
    const failedNames: string[] = [];
    for (const { result, checkbox } of targets) {
        try {
            await deleteDriveFile(result.file.id);
            successCount += 1;
            checkbox.disabled = true;
        } catch (err) {
            console.warn('[fulltext-drive-import] 元ファイルのゴミ箱移動に失敗:', result.file.id, err);
            failedNames.push(result.file.name);
        }
    }

    button.disabled = false;
    button.textContent = originalLabel;
    if (successCount > 0) showToast(t('fulltext_importCleanupDone', String(successCount)), 4000);
    if (failedNames.length > 0) showToast(t('fulltext_importCleanupError', failedNames.join(', ')), 6000);
}
