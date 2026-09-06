// document-loader.ts - PDFの取得・再付与・描画と表示経路の選択を担う。
// 表示・根拠モジュールへ依存し、登録情報の取得は初期化時に注入する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { updateReferenceFulltextUrl, getFulltextDriveFolderId } from '../lib/sheets-api';
import { platform } from '../platform';
import { retrieveAndCacheFulltext, fetchPdfResult } from '../lib/fulltext-retriever';
import {
    ensureFulltextFolder,
    downloadDriveFile,
    extractDriveFileId,
    uploadPdfToDrive,
    buildPdfFileName,
    describeDriveAccessError,
} from '../lib/drive-api';
import { runRegrantPickerFlow } from '../lib/drive-regrant-picker';
import { describePdfLoadFailure } from '../lib/fulltext-pdf-access';
import type { PdfLoadFailureView } from '../lib/fulltext-pdf-access';
import { t } from '../lib/i18n';
import { isRegistrationRecord } from '../lib/registry-record';
import { resolveFulltextDisplayMode } from '../lib/fulltext-display-mode';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference } from '../lib/types';
import { PdfRenderer } from './pdf-renderer';
import {
    showResolvedUrl,
    showArticlePage,
    showPlaceholder,
    requestBroadHostPermission,
    updateToolbarMode,
    enableFrameEmbeddingForThisTab,
    showPdfFrame,
    setUrlLabel,
    showSavePdfButton,
    hideCanvasContainer,
    hidePdfFrame,
    hideArticleFrame,
    hideRegistrySnapshotFrame,
    hideSavePdfButton,
} from './document-view';
import { session, isStale } from './session';
import { showFeedback, appendTextWithBreaks } from './page-helpers';
import { renderAiCardsFallback, focusAnnotationCard, applyHighlightsForCurrentRef } from './evidence-controller';

interface Dependencies {
    showRegistrySnapshot: (url: string, token?: number) => Promise<void>;
}

let deps: Dependencies | null = null;

export function setDocumentLoaderDependencies(dependencies: Dependencies): void {
    deps = dependencies;
}

function getDependencies(): Dependencies {
    if (!deps) throw new Error('document-loader の依存が設定されていません');
    return deps;
}

/** PDFの取得状態に応じて左ペインを描画する */
export async function showPdfForRef(ref: Reference, token: number): Promise<void> {
    // 表示経路の判定は resolveFulltextDisplayMode()（純関数）に集約する（Issue #118 実装内容10）。
    // registration行のHTMLスナップショットは、ここで既存の showCachedPdf()（PDF.js経路）へ
    // 一切入れず、専用のサンドボックスiframe表示（showRegistrySnapshot）へ分岐させる。
    // HTMLをPDF.jsに渡すと解析に失敗し、catch節の「Chrome内蔵ビュワーへのフォールバック」に
    // 落ちて非サンドボックスの ft-pdf-frame に生HTMLが載ってしまうため、この暗黙のフォールバックに
    // 頼らず明示的に分岐させる。
    switch (resolveFulltextDisplayMode(ref)) {
        case 'registry_snapshot':
            await getDependencies().showRegistrySnapshot(ref.fulltext_url!, token);
            break;
        case 'pdf':
            await showCachedPdf(ref.fulltext_url!, token);
            break;
        case 'linked':
            showResolvedUrl(ref.fulltext_url!, 'linked');
            break;
        case 'unavailable':
            // 既に「入手不可」と記録済み → 論文ページを埋め込み表示
            await showArticlePage();
            break;
        case 'not_retrieved':
        default:
            // 未取得 → 表示時に自動でOA/レジストリを検索する
            await handleResolve(token);
            break;
    }
}

/**
 * 現在地から先の候補PDF（最大2件）をメモリに先読みする。
 * 先読みは Drive 保存済み(cached)PDFのみ対象。現在地から離れた古い先読みは破棄してメモリを節約する。
 */
export function prefetchNeighbors(): void {
    if (session.currentCandidateIndex < 0) return;
    const keep = new Set<string>();
    if (session.currentRef) keep.add(session.currentRef.ref_id);
    for (let d = 1; d <= 2; d++) {
        const ref = session.fulltextCandidates[session.currentCandidateIndex + d];
        if (!ref || ref.fulltext_status !== 'cached' || !ref.fulltext_url) continue;
        const fileId = extractDriveFileId(ref.fulltext_url);
        if (!fileId) continue;
        keep.add(ref.ref_id);
        if (!session.pdfPrefetch.has(ref.ref_id)) {
            session.pdfPrefetch.set(ref.ref_id, downloadDriveFile(fileId).catch(() => null));
        }
    }
    for (const key of [...session.pdfPrefetch.keys()]) {
        if (!keep.has(key)) session.pdfPrefetch.delete(key);
    }
}

async function handleResolve(token?: number): Promise<void> {
    if (!session.currentRef) return;
    const ref = session.currentRef; // 取得中に遷移しても結果は元の文献へ反映する

    showPlaceholder('OAソースを順番に検証中...\nPMC OA → Europe PMC → 出版社 → Unpaywall → OpenAlex → 出版社PDF');

    // 既知ホスト（PMC/Europe PMC/Unpaywall/OpenAlex/Springer）は host_permissions 済みで
    // 追加権限は不要。それ以外の出版社PDF取得には全サイト権限が要るが、ページ表示時の
    // 自動実行ではユーザージェスチャが無いため要求できない（既知ホスト分のみ取得を試みる）。
    await requestBroadHostPermission();

    const stale = () => token !== undefined && isStale(token);

    try {
        // タブの一括取得と同じ検証付き経路。各候補を実際に検証し、
        // 実PDFが取れれば Drive に保存（cached）、ダメなら開けるURLをリンク記録（linked）。
        const outcome = await retrieveAndCacheFulltext(
            ref, session.userEmail,
            // ensureFulltextFolder の fail-fast エラーは通知だけして再送出する。
            // retrieveAndCacheFulltext 側は従来どおり linked へフォールバックするため分岐は変えない。
            async () => {
                try {
                    return await ensureFulltextFolder(session.spreadsheetId);
                } catch (err) {
                    const knownMessage = describeDriveAccessError(err);
                    if (knownMessage) showFeedback(knownMessage, true);
                    throw err;
                }
            }
        );

        // OA検索経由の取得はDrive直接取り込みではないため、Drive取り込み元/コピーIDは必ずクリアする
        ref.fulltext_drive_source_id = undefined;
        ref.fulltext_drive_copy_id = undefined;
        if (outcome.kind === 'cached') {
            ref.fulltext_url = outcome.url;
            ref.fulltext_status = 'cached';
            updateReferenceFulltextUrl(session.spreadsheetId, ref.ref_id, outcome.url, 'cached', null)
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
            // registration行はここでも showCachedPdf() (PDF.js経路) へ入れず、
            // 初回取得の直後からスナップショット表示へ分岐させる（showPdfForRef と同じ判定）。
            if (!stale()) {
                if (isRegistrationRecord(ref)) {
                    await getDependencies().showRegistrySnapshot(outcome.url, token);
                } else {
                    await showCachedPdf(outcome.url, token);
                }
                updateToolbarMode();
            }
        } else if (outcome.kind === 'linked') {
            ref.fulltext_url = outcome.url;
            ref.fulltext_status = 'retrieved';
            updateReferenceFulltextUrl(session.spreadsheetId, ref.ref_id, outcome.url, 'retrieved', null)
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
            if (!stale()) showResolvedUrl(outcome.url, outcome.source);
        } else {
            // OA全文は無い → 論文ページ（出版社/PubMed）を枠内に埋め込み表示
            ref.fulltext_status = 'unavailable';
            updateReferenceFulltextUrl(session.spreadsheetId, ref.ref_id, '', 'unavailable', null)
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
            if (!stale()) await showArticlePage();
        }
    } catch (err) {
        if (!stale()) showPlaceholder(`取得エラー: ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// リンクのみPDF: クリックでインライン表示 → 可能ならDrive自動保存
// ---------------------------------------------------------------------------

/**
 * 「リンクのみ」URLをクリックした時の処理。
 * 1. PDFバイトを取得できれば Drive へ自動保存し、保存済みPDFとして左ペインに表示する
 * 2. 取得できなければ（PMCのランディングページ等）URLを左ペインにインライン埋め込みし、
 *    手動保存（このPDFを保存）導線を表示する
 */
export async function openLinkedInline(url: string, source: OaSource | 'cached' | 'linked'): Promise<void> {
    if (!session.currentRef) return;

    showPlaceholder('PDFを取得中...');
    // クリック（ユーザージェスチャ）起点。リダイレクト先（任意ホスト）のヘッダー除去と
    // PDF取得を行うため、ここで全サイト権限ダイアログを出せる。
    await requestBroadHostPermission();

    // 1. バイト取得 → Drive 自動保存
    const blob = await fetchLinkedPdfBlob(url);
    if (blob) {
        try {
            const folderId = await ensureFulltextFolder(session.spreadsheetId);
            const info = await uploadPdfToDrive(folderId, buildPdfFileName(session.currentRef), blob);
            await updateReferenceFulltextUrl(session.spreadsheetId, session.currentRef.ref_id, info.webViewLink, 'cached', null);
            session.currentRef.fulltext_url = info.webViewLink;
            session.currentRef.fulltext_status = 'cached';
            // クリックされたリンクの自動保存はDrive直接取り込みではないため、取り込み元/コピーIDはクリアする
            session.currentRef.fulltext_drive_source_id = undefined;
            session.currentRef.fulltext_drive_copy_id = undefined;
            await showCachedPdf(info.webViewLink);
            updateToolbarMode();
            showFeedback('PDFをDriveに保存しました');
            return;
        } catch (err) {
            // fail-fast エラー（アクセス拒否等）は原因が分かるよう通知した上で、
            // 従来どおりインライン埋め込みへフォールバックする（分岐は変えない）
            const knownMessage = describeDriveAccessError(err);
            if (knownMessage) showFeedback(knownMessage, true);
            console.warn('[fulltext] Drive保存に失敗、インライン表示にフォールバック:', err);
        }
    }

    // 2. 自動保存できない → インライン埋め込み + 手動保存導線
    await embedLinkedUrl(url, source);
}

/**
 * リンクのみURLからPDFバイトを取得する。
 * まず通常（credentials:omit）で試し、ダメなら認証付き（credentials:include）で再試行する。
 * PMC等は素のfetchにanti-botのHTMLを返すことがあるが、ユーザーのセッションCookieを
 * 伴うと実PDFを返すケースがあるため。
 */
async function fetchLinkedPdfBlob(url: string): Promise<Blob | null> {
    try {
        const res = await fetchPdfResult(url);
        if (res.kind === 'pdf') return res.blob;
    } catch { /* 認証付き再試行へ */ }

    try {
        const resp = await fetch(url, { credentials: 'include' });
        if (resp.ok) {
            const blob = await resp.blob();
            const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
            if (String.fromCharCode(...head).startsWith('%PDF')) return blob;
        }
    } catch { /* 取得不可 */ }
    return null;
}

/**
 * リンクのみURLを左ペインの iframe へ埋め込み表示する。
 * - 埋め込み禁止ヘッダー（X-Frame-Options / CSP）はこのタブ限定のDNRルールで除去する。
 *   リダイレクト先が任意ホストでも効くよう全サイト権限が望ましい（呼び出し前に要求済み）。
 * - PDFはChrome内蔵ビュワーで表示するため「非サンドボックス」のframeを使う。
 *   サンドボックス付き article-frame ではPDFビュワーがChromeにブロックされ
 *   「このページは Chrome によってブロックされています」になるため。
 * バイト取得できなかった＝自動保存できなかったので手動保存導線も表示する。
 */
async function embedLinkedUrl(url: string, source: OaSource | 'cached' | 'linked'): Promise<void> {
    const ruleOk = await enableFrameEmbeddingForThisTab();
    if (!ruleOk) {
        console.warn('[fulltext] frame埋め込みルール未設定。ヘッダー保護により表示がブロックされる場合があります');
    }
    // 非サンドボックスの ft-pdf-frame に表示（Chrome内蔵PDFビュワー対応）
    showPdfFrame(url);
    setUrlLabel(url, source);
    // 自動保存できなかったので手動保存（ダウンロード→アップロード）導線を表示
    showSavePdfButton();
}

/**
 * Drive保存済みPDFを左ペインに表示する。
 * 1. Drive API (alt=media) でPDFバイトを取得し PDF.js で描画（失敗時のみ内蔵ビュワー）
 * 2. 取得できない場合は失敗の種別に応じた復旧案内を出す（showPdfAccessFailure）
 * 3. Drive 以外のURL（タブアタッチで手入力した直リンク等）は従来のリンク表示
 *
 * **Drive のプレビュー埋め込み (/preview) へフォールバックしてはいけない（Issue #69）。**
 * Drive は `/preview` に `frame-ancestors https://drive.google.com` を返すため
 * `chrome-extension://` のページからは構造的に埋め込めず、拡張機能側の CSP 設定でも
 * 上書きできない。以前はここでフォールバックしていたが、実際には無言で空のペインに
 * なるだけだった（エラー表示すら出ない）。
 */
export async function showCachedPdf(url: string, token?: number): Promise<void> {
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        showResolvedUrl(url, 'cached');
        return;
    }

    showPlaceholder('Drive から PDF を読み込み中...');
    setUrlLabel(url, 'cached');

    // 先読み済みなら即利用。無ければその場で取得。
    const refId = session.currentRef?.ref_id;
    const prefetched = refId ? session.pdfPrefetch.get(refId) : undefined;

    let blob: Blob | null = null;
    try {
        blob = prefetched ? await prefetched : await downloadDriveFile(fileId);
        if (!blob && prefetched) blob = await downloadDriveFile(fileId); // 先読みが失敗していた場合の再取得
    } catch (err) {
        if (token !== undefined && isStale(token)) return;
        console.warn('[fulltext] DriveからのPDF取得に失敗:', err);
        showPdfAccessFailure(err, url, fileId);
        return;
    }

    // 取得中に別の文献へ移っていたら描画しない（取り違え防止）
    if (token !== undefined && isStale(token)) return;

    if (!blob) {
        // downloadDriveFile は Blob を返すか投げるかのどちらかなので通常ここには来ない。
        // 来た場合は原因が分からないため、未付与と断定せず「再試行」案内に倒す。
        showPdfAccessFailure(null, url, fileId);
        return;
    }

    // PDF.js でテキストレイヤー付き描画（ハイライト可能）。
    // 描画に失敗した場合のみ、従来の Chrome 内蔵ビュワー(iframe blob)へフォールバックする。
    try {
        await showRenderedPdf(blob, token);
        setUrlLabel(url, 'cached');
    } catch (err) {
        if (token !== undefined && isStale(token)) return;
        console.warn('[fulltext] PDF.js描画に失敗、iframeビュワーへフォールバック:', err);
        hideCanvasContainer();
        hidePdfFrame(); // 旧 blob URL を解放
        session.currentPdfObjectUrl = URL.createObjectURL(blob);
        showPdfFrame(session.currentPdfObjectUrl);
        setUrlLabel(url, 'cached');
    }
}

// ---------------------------------------------------------------------------
// PDF取得に失敗したときの復旧導線（Issue #69）
//
// 「読めない」を無言の空ペインにせず、原因（未付与 / 認証切れ / 一時エラー）に応じた
// 案内と復旧導線を出す。主導線は再付与（Picker）で、これは drive.file が
// 「アプリ×ユーザー×ファイル」単位でしか付与されず、Picker での選択以外に
// 付与経路が無いため（AGENTS.md「drive.file の 403/404 は『無い』ではなく
// 『このユーザーに未付与』」参照）。
// ---------------------------------------------------------------------------

/** PDF取得に失敗した理由をペインに表示する（フレーム類は全て畳む） */
function showPdfAccessFailure(error: unknown, url: string, fileId: string): void {
    const view = describePdfLoadFailure(error);
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    hideSavePdfButton();

    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.replaceChildren(buildPdfAccessFailurePanel(view, url, fileId, session.currentRef?.ref_id));
    }
    setUrlLabel(url, 'cached');
    // PDFを出せなくても、AI判定の根拠カード（quote＋ページ番号）は参照できるようにする
    renderAiCardsFallback();
}

function buildPdfAccessFailurePanel(
    view: PdfLoadFailureView,
    url: string,
    fileId: string,
    refId?: string
): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'ft-pdf-error-panel';

    const title = document.createElement('div');
    title.className = 'ft-pdf-error-title';
    title.textContent = t('fulltext_pdfPaneTitle');

    const message = document.createElement('div');
    message.className = 'ft-pdf-error-message';
    appendTextWithBreaks(message, t(view.messageKey));

    const actions = document.createElement('div');
    actions.className = 'ft-pdf-error-actions';

    if (view.showRegrant) {
        const regrantBtn = document.createElement('button');
        regrantBtn.className = 'btn btn-primary';
        regrantBtn.textContent = t('fulltext_pdfPaneRegrantBtn');
        regrantBtn.addEventListener('click', () => { void handlePdfRegrantClick(regrantBtn, url, refId); });
        actions.appendChild(regrantBtn);
    }

    if (view.showRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-primary';
        retryBtn.textContent = t('fulltext_pdfPaneRetryBtn');
        retryBtn.addEventListener('click', () => { void retryCachedPdf(url, refId); });
        actions.appendChild(retryBtn);
    }

    // 副次導線: ブラウザのGoogleセッションで開く。Drive 側で共有されていれば読めるが、
    // 別タブのDriveビュワーになるためハイライト・AI判定の根拠表示は使えない。
    // showArticleFallback（下部）の副次導線ボタンと見た目を揃えるため btn-secondary を使う。
    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary';
    openBtn.textContent = t('fulltext_pdfPaneOpenInDriveBtn');
    openBtn.addEventListener('click', () => {
        platform().openExternal(`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`);
    });
    actions.appendChild(openBtn);

    const note = document.createElement('div');
    note.className = 'ft-pdf-error-note';
    note.textContent = t('fulltext_pdfPaneOpenInDriveNote');

    panel.append(title, message, actions, note);
    return panel;
}

/**
 * 再付与（Picker）を起動し、閉じたら同じPDFをもう一度読みに行く。
 * キャンセルでも再取得する（「選択」を押した時点でサーバー側の付与は確定しており、
 * キャンセル判定自体が best-effort なため）。
 */
async function handlePdfRegrantClick(btn: HTMLButtonElement, url: string, refId?: string): Promise<void> {
    btn.disabled = true;
    try {
        const folderId = await getFulltextDriveFolderId(session.spreadsheetId);
        if (!folderId) {
            showFeedback(t('fulltext_regrantNoFolder'), true);
            return;
        }
        const outcome = await runRegrantPickerFlow({ folderId, email: session.userEmail });
        if (outcome.status === 'parse-error') showFeedback(t('fulltext_regrantParseError'), true);
        await retryCachedPdf(url, refId);
    } catch (err) {
        console.warn('[fulltext] 読み取り権限の復旧に失敗:', err);
        showFeedback(describeDriveAccessError(err) ?? t('fulltext_regrantError', (err as Error).message), true);
    } finally {
        // 再取得で描画し直すとこのボタン自体が捨てられるが、失敗して残った場合に押し直せるよう戻す
        btn.disabled = false;
    }
}

/** 同じ文献を表示したままPDFだけ読み直す（失敗した先読み結果は捨てる） */
async function retryCachedPdf(url: string, refId?: string): Promise<void> {
    // 押している間に別の文献へ移っていたら、その文献の表示を壊さないよう何もしない
    if (refId && session.currentRef?.ref_id !== refId) return;
    if (refId) session.pdfPrefetch.delete(refId);
    await showCachedPdf(url, ++session.loadToken);
}

// ---------------------------------------------------------------------------
// PDF.js 描画（cached PDF。テキストレイヤー + ハイライト対応）
// ---------------------------------------------------------------------------

/** PDF.js レンダラを取得（初回生成） */
function getPdfRenderer(): PdfRenderer {
    if (!session.pdfRenderer) {
        const container = document.getElementById('ft-pdf-canvas-container');
        if (!container) throw new Error('PDF描画コンテナが見つかりません');
        session.pdfRenderer = new PdfRenderer(container);
        // PDF上のハイライトクリック → 右ペインの該当カードへスクロール＆強調
        session.pdfRenderer.onHighlightClick = id => focusAnnotationCard(id);
    }
    return session.pdfRenderer;
}

/** PDFバイト列(blob)を PDF.js で全ページ描画する */
async function showRenderedPdf(blob: Blob, token?: number): Promise<void> {
    const buf = await blob.arrayBuffer();
    if (token !== undefined && isStale(token)) return;

    // iframe・プレースホルダを退避し、canvas コンテナを前面に出す
    hideArticleFrame();
    hidePdfFrame();
    hideSavePdfButton();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const container = document.getElementById('ft-pdf-canvas-container');
    if (container) container.classList.remove('hidden');

    const renderer = getPdfRenderer();
    session.currentPdfInfo = await renderer.loadPdf(buf);
    // loadPdf 自体が新しい描画で前の描画を上書きするため、stale でも destroy は不要。
    if (token !== undefined && isStale(token)) return;

    renderer.setHighlightsVisible(session.highlightEnabled);
    // Phase 2/3: ここで AI evidence / 既存アノテーションのハイライトを適用する
    applyHighlightsForCurrentRef();
}
