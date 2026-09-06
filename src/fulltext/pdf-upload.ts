// pdf-upload.ts - PDFのアップロード・置換・削除・ドロップ操作を担う。
// 表示とPDF取得へ依存し、初期化や判定処理へは依存しない。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { updateReferenceFulltextUrl } from '../lib/sheets-api';
import {
    ensureFulltextFolder,
    extractDriveFileId,
    deleteDriveFile,
    uploadPdfToDrive,
    buildPdfFileName,
    describeDriveAccessError,
} from '../lib/drive-api';
import { t } from '../lib/i18n';
import { resolveFulltextDisplayMode } from '../lib/fulltext-display-mode';
import { session } from './session';
import { showPlaceholder, updateToolbarMode } from './document-view';
import { showCachedPdf } from './document-loader';
import { showFeedback } from './page-helpers';

// ---------------------------------------------------------------------------
// PDF 差し替え（誤ったPDFの削除 + 再アップロード）
// ---------------------------------------------------------------------------

export function wireReplaceButtons(): void {
    const openPicker = () => {
        const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
        if (input) {
            input.value = '';
            input.click();
        }
    };
    // 「別のPDFをアップロード」(cached時の差し替え) と「⬆ PDFをアップロード」(未保存時) は
    // どちらも同じファイル選択 → アップロード経路を使う
    document.getElementById('ft-replace-btn')?.addEventListener('click', openPicker);
    document.getElementById('ft-upload-btn')?.addEventListener('click', openPicker);
    document.getElementById('ft-upload-input')?.addEventListener('change', () => {
        const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
        const file = input?.files?.[0];
        if (file) void uploadPdfFile(file);
    });
    document.getElementById('ft-delete-btn')?.addEventListener('click', () => {
        void handleDeletePdf();
    });
    wireDropZone();
}

/**
 * PDFビュワー枠へのドラッグ&ドロップでローカルPDFをアップロードできるようにする。
 *
 * 論文ページや保存済みPDFが iframe で表示されている時、素の drop は iframe 自身に
 * ファイルを開かせてしまう。これを防ぐため:
 * - dragenter/over/leave を document レベルで監視する（ファイルがビューポートに入った
 *   時点でオーバーレイを出す。ペインだけだとカーソルが先に iframe へ入って取りこぼす）。
 * - オーバーレイ(z-index)を iframe の上に出し、drop をオーバーレイ側で受ける。
 * - ペイン外への drop でもブラウザがファイルを開かないよう document の drop を握りつぶす。
 */
function wireDropZone(): void {
    const viewer = document.getElementById('ft-pdf-viewer');
    const overlay = document.getElementById('ft-drop-overlay');
    if (!viewer || !overlay) return;

    // ドラッグの入れ子要素ごとに発火する dragenter/leave をカウンタで正規化し、
    // ビューポートから完全に出た時だけオーバーレイを隠す。
    let dragDepth = 0;
    const hasFiles = (e: DragEvent) =>
        Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const hideOverlay = () => { dragDepth = 0; overlay.classList.add('hidden'); };

    document.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        overlay.classList.remove('hidden');
    });
    document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) overlay.classList.add('hidden');
    });
    // ペイン外への drop はファイルを開かせないよう握りつぶすだけ（アップロードしない）
    document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        hideOverlay();
    });
    // ビューワ（オーバーレイ）上への drop だけアップロードする
    viewer.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideOverlay();
        const file = e.dataTransfer?.files?.[0];
        if (file) void uploadPdfFile(file);
    });
}

/**
 * 保存済みPDF（またはregistration行のスナップショット）をDriveから削除し、参照を未取得状態へ戻す。
 *
 * 【PR #124 レビュー指摘4】確認ダイアログの文言・ボタンラベルはスナップショット表示中かどうかで
 * 出し分ける。resolveFulltextDisplayMode(currentRef) === 'registry_snapshot' の判定は
 * currentRef.fulltext_status/fulltext_url を書き換える前（この関数の先頭）で行うこと
 * （updateToolbarMode() と同じ判定基準。削除処理中に currentRef の状態を変えるため、
 * 判定を後回しにすると常に非スナップショット扱いになってしまう）。
 */
async function handleDeletePdf(): Promise<void> {
    if (!session.currentRef || !session.currentRef.fulltext_url) return;
    const isSnapshot = resolveFulltextDisplayMode(session.currentRef) === 'registry_snapshot';
    const confirmMessage = isSnapshot
        ? t('fulltext_snapshotDeleteConfirm')
        : 'このPDFをDriveから削除します。よろしいですか？\n（削除後、この画面から正しいPDFをアップロードできます）';
    if (!window.confirm(confirmMessage)) {
        return;
    }

    const delBtn = document.getElementById('ft-delete-btn') as HTMLButtonElement | null;
    if (delBtn) { delBtn.disabled = true; delBtn.textContent = '削除中...'; }

    try {
        const fileId = extractDriveFileId(session.currentRef.fulltext_url);
        if (fileId) {
            await deleteDriveFile(fileId);
        }
        await updateReferenceFulltextUrl(session.spreadsheetId, session.currentRef.ref_id, '', 'not_retrieved', null);
        session.currentRef.fulltext_url = '';
        session.currentRef.fulltext_status = 'not_retrieved';
        // 削除時はDrive取り込み元/コピーIDも必ずクリアする（ゴミ箱送りのコピーを取り込み済みと誤判定させないため）
        session.currentRef.fulltext_drive_source_id = undefined;
        session.currentRef.fulltext_drive_copy_id = undefined;
        showPlaceholder('PDFを削除しました。\n上の「⬆ PDFをアップロード」から再取得してください。');
    } catch (err) {
        window.alert(`削除に失敗しました: ${(err as Error).message}`);
    } finally {
        if (delBtn) delBtn.disabled = false;
        // ラベルのハードコード復元をやめ updateToolbarMode() に委ねる（PR #124 レビュー指摘4）。
        // 以前は finally で 'PDFを削除' に固定していたため、削除失敗時にスナップショット表示が
        // 残っているのにボタンだけ通常PDF向けラベルに戻る不整合があった。
        // updateToolbarMode() は defaultDeleteBtnLabel を記憶しており、現在の表示モード
        // （成功時は 'not_retrieved' に変わった currentRef、失敗時はスナップショット/通常PDFの
        // どちらであっても現状の currentRef）に応じて正しいラベルを出し分ける。
        updateToolbarMode();
    }
}

/**
 * ローカルのPDFファイルをDriveへアップロードして表示する。
 * ファイル選択（差し替え/⬆アップロード）とドラッグ&ドロップの共通経路。
 */
async function uploadPdfFile(file: File): Promise<void> {
    if (!session.currentRef || session.uploadInProgress) return;

    // マジックナンバーでPDF検証
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (!String.fromCharCode(...head).startsWith('%PDF')) {
        window.alert('PDFファイルではないようです。.pdf ファイルを選択してください。');
        return;
    }

    session.uploadInProgress = true;
    const ref = session.currentRef; // アップロード中に遷移しても結果は元の文献へ反映する
    showPlaceholder('Drive へPDFをアップロード中...');
    try {
        const folderId = await ensureFulltextFolder(session.spreadsheetId);
        const info = await uploadPdfToDrive(folderId, buildPdfFileName(ref), file);
        await updateReferenceFulltextUrl(session.spreadsheetId, ref.ref_id, info.webViewLink, 'cached', null);
        ref.fulltext_url = info.webViewLink;
        ref.fulltext_status = 'cached';
        // ローカルPDFの手動アップロードはDrive直接取り込みではないため、取り込み元/コピーIDはクリアする
        ref.fulltext_drive_source_id = undefined;
        ref.fulltext_drive_copy_id = undefined;
        // アップロード中に別文献へ移っていたら描画はせず、状態更新のみ
        if (ref === session.currentRef) {
            await showCachedPdf(info.webViewLink);
            updateToolbarMode();
            showFeedback('PDFをDriveに保存しました');
        }
    } catch (err) {
        if (ref === session.currentRef) {
            const knownMessage = describeDriveAccessError(err);
            showPlaceholder(knownMessage ?? `アップロードに失敗しました: ${(err as Error).message}`);
        }
    } finally {
        session.uploadInProgress = false;
    }
}
