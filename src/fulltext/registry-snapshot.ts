// registry-snapshot.ts - 登録情報スナップショットの取得と復旧案内を担う。
// 表示モジュールと既存のPDF取得経路へ一方向に依存する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { getFulltextDriveFolderId } from '../lib/sheets-api';
import { platform } from '../platform';
import { downloadDriveFile, extractDriveFileId, describeDriveAccessError } from '../lib/drive-api';
import { runRegrantPickerFlow } from '../lib/drive-regrant-picker';
import { describePdfLoadFailure } from '../lib/fulltext-pdf-access';
import type { PdfLoadFailureView } from '../lib/fulltext-pdf-access';
import { t } from '../lib/i18n';
import {
    showResolvedUrl,
    showPlaceholder,
    setUrlLabel,
    showRegistrySnapshotFrame,
    hideArticleFrame,
    hidePdfFrame,
    hideCanvasContainer,
    hideRegistrySnapshotFrame,
    hideSavePdfButton,
} from './document-view';
import { session, isStale } from './session';
import { showCachedPdf } from './document-loader';
import { renderAiCardsFallback } from './evidence-controller';
import { appendTextWithBreaks, showFeedback } from './page-helpers';

/** バイト列の先頭がPDFのマジックナンバー（%PDF）で始まるか（uploadPdfFile()と同じ判定） */
async function looksLikePdfBlob(blob: Blob): Promise<boolean> {
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head).startsWith('%PDF');
}

/**
 * Driveからregistration行のHTMLスナップショットを取得し、サンドボックスiframeで表示する。
 *
 * - fileId が取れない（Drive以外のURL）場合は、showCachedPdf() が同じ状況（Drive以外の
 *   cached URL）で使っている対処に揃え、showResolvedUrl() へフォールバックする。
 *   registration行のcached URLは常に retrieveRegistrationSnapshot() がDriveへ
 *   アップロードした結果のため通常はDrive URLになるはずで、これは防御的な分岐にとどまる。
 * - 取得失敗時は無言の空ペインにせず、showRegistrySnapshotAccessFailure()（原因別の
 *   復旧導線。showPdfAccessFailure() と同じ describePdfLoadFailure() の分類を再利用する）
 *   を出す。
 * - isRegistrationRecord(ref) はメタデータ（record_type）だけを見て判定するため、
 *   ツールバーの「別のPDFをアップロード」で fulltext_url が実PDFへ差し替えられていても
 *   この経路に入りうる。取得したバイト列がPDFのマジックナンバーで始まっていれば、
 *   HTMLとして描画せず showCachedPdf()（通常のPDF経路）へ委譲する。pdfPrefetch に積んだ
 *   Promise は一度解決したBlobをそのまま返すだけなので、委譲しても二重ダウンロードには
 *   ならない。
 */
export async function showRegistrySnapshot(url: string, token?: number): Promise<void> {
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        showResolvedUrl(url, 'cached');
        return;
    }

    showPlaceholder(t('fulltext_snapshotLoading'));
    setUrlLabel(url, 'cached');

    // 先読み済みなら即利用。無ければその場で取得（showCachedPdf()と同じ流儀）。
    const refId = session.currentRef?.ref_id;
    const prefetched = refId ? session.pdfPrefetch.get(refId) : undefined;

    let blob: Blob | null = null;
    try {
        blob = prefetched ? await prefetched : await downloadDriveFile(fileId);
        if (!blob && prefetched) blob = await downloadDriveFile(fileId); // 先読みが失敗していた場合の再取得
    } catch (err) {
        if (token !== undefined && isStale(token)) return;
        console.warn('[fulltext] Driveからのスナップショット取得に失敗:', err);
        showRegistrySnapshotAccessFailure(err, url, fileId);
        return;
    }

    // 取得中に別の文献へ移っていたら描画しない（取り違え防止）
    if (token !== undefined && isStale(token)) return;

    // blob.size === 0 も明示的に弾く（PR #124 レビュー指摘5）。0バイトのBlobはnull/undefinedと
    // 違い truthy なので `if (!blob)` だけでは素通りする。0バイトはアップロード途中断や
    // Drive側で中身が消えたファイルなどで起こりうる。素通りすると looksLikePdfBlob() は
    // 先頭5バイトが空文字のため false になり、blob.text() が '' を返して
    // showRegistrySnapshotFrame('') が srcdoc='' を設定し、プレースホルダも隠れたまま
    // ペインが完全な空白になる（無言の空ペイン）。
    if (!blob || blob.size === 0) {
        showRegistrySnapshotAccessFailure(null, url, fileId);
        return;
    }

    // 登録行でも「別のPDFをアップロード」で実PDFへ差し替えられている場合がある。
    // その場合は通常のPDF経路へ委譲する（詳細は関数コメント参照）。
    if (await looksLikePdfBlob(blob)) {
        if (token !== undefined && isStale(token)) return;
        await showCachedPdf(url, token);
        return;
    }

    const html = await blob.text();
    if (token !== undefined && isStale(token)) return;

    showRegistrySnapshotFrame(html);
    setUrlLabel(url, 'cached');
}

/**
 * スナップショット取得に失敗した理由をペインに表示する（フレーム類は全て畳む）。
 * showPdfAccessFailure() と同じ構造・同じ describePdfLoadFailure() 分類・同じ再付与/再試行の
 * 実処理（handleSnapshotRegrantClick/retryRegistrySnapshot）を使うが、"PDF" と明記した
 * 既存の文言（fulltext_pdfPaneNotGranted 等）をそのまま出すとHTMLスナップショットの失敗として
 * 誤解を招くため、表示文言だけを差し替えた専用パネルを組み立てる
 * （buildPdfAccessFailurePanel() は変更しない）。
 */
function showRegistrySnapshotAccessFailure(error: unknown, url: string, fileId: string): void {
    const view = describePdfLoadFailure(error);
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    hideSavePdfButton();

    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.replaceChildren(buildSnapshotAccessFailurePanel(view, url, fileId, session.currentRef?.ref_id));
    }
    setUrlLabel(url, 'cached');
    renderAiCardsFallback();
}

function buildSnapshotAccessFailurePanel(
    view: PdfLoadFailureView,
    url: string,
    fileId: string,
    refId?: string
): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'ft-pdf-error-panel';

    const title = document.createElement('div');
    title.className = 'ft-pdf-error-title';
    title.textContent = t('fulltext_snapshotPaneTitle');

    const message = document.createElement('div');
    message.className = 'ft-pdf-error-message';
    // auth-error/transient は既存の汎用文言（"PDF"に限定しない一般的なDrive認証切れ／一時
    // エラーの文言）をそのまま使う。not-granted/unknown はPDF専用の文言なので、
    // スナップショット向けの文言に差し替える。
    const messageKey = view.kind === 'auth-error' || view.kind === 'transient'
        ? view.messageKey
        : view.kind === 'not-granted'
            ? 'fulltext_snapshotPaneNotGranted'
            : 'fulltext_snapshotPaneLoadFailed';
    appendTextWithBreaks(message, t(messageKey));

    const actions = document.createElement('div');
    actions.className = 'ft-pdf-error-actions';

    if (view.showRegrant) {
        const regrantBtn = document.createElement('button');
        regrantBtn.className = 'btn btn-primary';
        regrantBtn.textContent = t('fulltext_pdfPaneRegrantBtn');
        regrantBtn.addEventListener('click', () => { void handleSnapshotRegrantClick(regrantBtn, url, refId); });
        actions.appendChild(regrantBtn);
    }

    if (view.showRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-primary';
        retryBtn.textContent = t('fulltext_pdfPaneRetryBtn');
        retryBtn.addEventListener('click', () => { void retryRegistrySnapshot(url, refId); });
        actions.appendChild(retryBtn);
    }

    // 副次導線: ブラウザのGoogleセッションで開く（showPdfAccessFailureのopenBtnと同じ）
    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary';
    openBtn.textContent = t('fulltext_pdfPaneOpenInDriveBtn');
    openBtn.addEventListener('click', () => {
        platform().openExternal(`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`);
    });
    actions.appendChild(openBtn);

    const note = document.createElement('div');
    note.className = 'ft-pdf-error-note';
    note.textContent = t('fulltext_snapshotPaneOpenInDriveNote');

    panel.append(title, message, actions, note);
    return panel;
}

/**
 * 再付与（Picker）を起動し、閉じたら同じスナップショットをもう一度読みに行く。
 * handlePdfRegrantClick() と同じ流れ（キャンセルでも再取得する理由も同じ）。
 */
async function handleSnapshotRegrantClick(btn: HTMLButtonElement, url: string, refId?: string): Promise<void> {
    btn.disabled = true;
    try {
        const folderId = await getFulltextDriveFolderId(session.spreadsheetId);
        if (!folderId) {
            showFeedback(t('fulltext_regrantNoFolder'), true);
            return;
        }
        const outcome = await runRegrantPickerFlow({ folderId, email: session.userEmail });
        if (outcome.status === 'parse-error') showFeedback(t('fulltext_regrantParseError'), true);
        await retryRegistrySnapshot(url, refId);
    } catch (err) {
        console.warn('[fulltext] スナップショットの読み取り権限の復旧に失敗:', err);
        showFeedback(describeDriveAccessError(err) ?? t('fulltext_regrantError', (err as Error).message), true);
    } finally {
        btn.disabled = false;
    }
}

/** 同じ文献を表示したままスナップショットだけ読み直す（失敗した先読み結果は捨てる） */
async function retryRegistrySnapshot(url: string, refId?: string): Promise<void> {
    if (refId && session.currentRef?.ref_id !== refId) return;
    if (refId) session.pdfPrefetch.delete(refId);
    await showRegistrySnapshot(url, ++session.loadToken);
}
