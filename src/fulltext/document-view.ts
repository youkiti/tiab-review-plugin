// document-view.ts - フレーム・ツールバー・取得状況・記事ページの表示を担う。
// 根拠表示へ依存し、リンク先PDFの取得は初期化時に注入する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { t } from '../lib/i18n';
import { resolveFulltextDisplayMode } from '../lib/fulltext-display-mode';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference } from '../lib/types';
import { session } from './session';
import { renderAiCardsFallback } from './evidence-controller';
import { buildExternalAnchor, appendTextWithBreaks } from './page-helpers';

interface Dependencies {
    openLinkedInline: (url: string, source: OaSource | 'cached' | 'linked') => Promise<void>;
}

let deps: Dependencies | null = null;

export function setDocumentViewDependencies(dependencies: Dependencies): void {
    deps = dependencies;
}

function getDependencies(): Dependencies {
    if (!deps) throw new Error('document-view の依存が設定されていません');
    return deps;
}

const OA_SOURCE_LABELS: Record<OaSource | 'cached' | 'linked', string> = {
    pmc_oa: 'PMC OA',
    europe_pmc: 'Europe PMC',
    unpaywall: 'Unpaywall',
    openalex: 'OpenAlex',
    publisher: '出版社',
    landing_meta: '出版社PDF',
    registry: 'レジストリ登録情報',
    cached: 'Drive保存済み',
    linked: 'リンクのみ',
};

/**
 * PDFの取得状態に応じてツールバーのボタンを出し分ける。
 * - PDF保存済み(cached): 差し替え（再アップロード/削除）導線を表示し、手動保存導線は隠す
 * - それ以外: 差し替え導線を隠す（取得は自動検索／リンククリックで行う）
 *
 * 【Issue #118 実装内容4: registration行のスナップショット表示時の扱い】
 * fulltext_status==='cached' はスナップショット表示時にも true になるため、上記の
 * hasPdf 条件だけでは「差し替え」「削除」がそのまま表示されてしまう。判断:
 * - どちらも隠さない。「削除」はスナップショットを消して取り直す（再度レジストリ検索を
 *   走らせる）導線として意味があり、「別のPDFをアップロード」は登録内容のPDF
 *   （プロトコル文書など）で差し替える運用がありうる。どちらも実用上の価値があるため、
 *   registration行だからといって機能を封じる理由が無い。
 * - ただし両ボタンの既定ラベルは「PDF」と明記しており、表示中の中身が実際にはHTML
 *   スナップショットであることと食い違って誤解を招きうる。そのため、
 *   resolveFulltextDisplayMode(currentRef) === 'registry_snapshot' のときだけ
 *   ラベルをスナップショット向けの文言に差し替える（表示/非表示の条件そのものは変えない）。
 * - 通常のPDF経路（registration行以外）ではラベルを一切変えない
 *   （defaultReplaceBtnLabel/defaultDeleteBtnLabel でHTMLの既定文言をそのまま復元する）。
 */
export function updateToolbarMode(): void {
    const hasPdf = session.currentRef?.fulltext_status === 'cached' && !!session.currentRef.fulltext_url;
    const replace = document.getElementById('ft-replace-btn');
    const del = document.getElementById('ft-delete-btn');
    const upload = document.getElementById('ft-upload-btn');

    if (session.defaultReplaceBtnLabel === null && replace) session.defaultReplaceBtnLabel = replace.textContent ?? '';
    if (session.defaultDeleteBtnLabel === null && del) session.defaultDeleteBtnLabel = del.textContent ?? '';

    replace?.classList.toggle('hidden', !hasPdf);
    del?.classList.toggle('hidden', !hasPdf);
    // PDF未保存時は常に「⬆ PDFをアップロード」を出す。
    // 論文ページ埋め込み中・リンクのみ表示中でも手元のPDFをDriveへ保存できるようにする。
    upload?.classList.toggle('hidden', hasPdf);
    // 保存済みになったら「このPDFを保存」導線は不要
    if (hasPdf) hideSavePdfButton();

    const isSnapshot = hasPdf && !!session.currentRef && resolveFulltextDisplayMode(session.currentRef) === 'registry_snapshot';
    if (replace) replace.textContent = isSnapshot ? t('fulltext_snapshotReplaceBtn') : (session.defaultReplaceBtnLabel ?? '');
    if (del) del.textContent = isSnapshot ? t('fulltext_snapshotDeleteBtn') : (session.defaultDeleteBtnLabel ?? '');
}

// ---------------------------------------------------------------------------
// OA URL 解決
// ---------------------------------------------------------------------------

// PMC系・Springer以外（Unpaywall/OpenAlex経由の任意出版社）のPDFをfetchするには
// 全HTTPSサイトの実行時権限が要る。拒否されても既存host_permission内のPDFは取得できる。
export function requestBroadHostPermission(): Promise<boolean> {
    return new Promise(resolve => {
        try {
            chrome.permissions.contains({ origins: ['https://*/*'] }, has => {
                if (has) { resolve(true); return; }
                chrome.permissions.request({ origins: ['https://*/*'] }, granted => resolve(!!granted));
            });
        } catch {
            resolve(false);
        }
    });
}

// ---------------------------------------------------------------------------
// リンクのみPDFの手動保存（自動保存に失敗した時の導線）
// ---------------------------------------------------------------------------

export function wireSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.addEventListener('click', () => {
        const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
        if (input) {
            input.value = '';
            input.click();
        }
    });
}

export function showSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.classList.remove('hidden');
}

export function hideSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 「PDFとして保存」ボタン（スナップショット表示専用。Issue #118 実装内容3）
//
// 既存の ft-save-pdf-btn（「このPDFを保存」＝リンクのみPDFの手動保存導線。手元のPDFを
// 選んでDriveへアップロードする）とは別物。流用・改変しない。
// window.print() ではなく frame.contentWindow.print() を呼ぶことで、印刷対象を
// スナップショットiframeの中身だけに限定する（親ページの判定パネル等を巻き込まない）。
// ---------------------------------------------------------------------------

/** ラベルは新規追加の文言のため t() 経由で設定する（既存の静的ツールバーボタンは
 *  ハードコードされたJapanese文言だが、新規に追加する文言は必ずi18nキーを通す方針） */
export function wireSnapshotPrintButton(): void {
    const btn = document.getElementById('ft-snapshot-print-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.textContent = t('fulltext_snapshotPrintBtn');
    btn.title = t('fulltext_snapshotPrintBtnTitle');
    btn.addEventListener('click', () => {
        const frame = document.getElementById('ft-snapshot-frame') as HTMLIFrameElement | null;
        frame?.contentWindow?.print();
    });
}

function showSnapshotSaveButton(): void {
    document.getElementById('ft-snapshot-print-btn')?.classList.remove('hidden');
}

function hideSnapshotSaveButton(): void {
    document.getElementById('ft-snapshot-print-btn')?.classList.add('hidden');
}

export function hideArticleFrame(): void {
    const frame = document.getElementById('ft-article-frame') as HTMLIFrameElement | null;
    if (frame) {
        frame.classList.add('hidden');
        frame.removeAttribute('src');
    }
}

export function hidePdfFrame(): void {
    const frame = document.getElementById('ft-pdf-frame') as HTMLIFrameElement | null;
    if (frame) {
        frame.classList.add('hidden');
        frame.removeAttribute('src');
    }
    if (session.currentPdfObjectUrl) {
        URL.revokeObjectURL(session.currentPdfObjectUrl);
        session.currentPdfObjectUrl = null;
    }
}

export function showPdfFrame(src: string): void {
    hideArticleFrame();
    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    const frame = document.getElementById('ft-pdf-frame') as HTMLIFrameElement | null;
    if (!frame) return;
    frame.src = src;
    frame.classList.remove('hidden');
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    // iframe 経由（Driveプレビュー・Chrome内蔵ビュワー等）ではPDF.jsハイライトを
    // 描けないが、根拠カード一覧だけは表示する（消失させない）
    renderAiCardsFallback();
}

function renderUrlLabel(label: HTMLElement, sourceLabel: string, url: string): void {
    const badge = document.createElement('span');
    badge.className = 'ft-source-badge';
    badge.textContent = sourceLabel;

    const link = buildExternalAnchor(url, url);
    label.replaceChildren(badge, link);
}

export function setUrlLabel(url: string, source: OaSource | 'cached' | 'linked'): void {
    const label = document.getElementById('ft-pdf-url-label');
    if (!label) return;
    const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
    renderUrlLabel(label, sourceLabel, url);
}

// ---------------------------------------------------------------------------
// レジストリスナップショット表示（Issue #118 実装内容10）
//
// registration行（isRegistrationRecord(ref)）の自己完結HTMLスナップショットを、
// サンドボックス化した専用iframe（#ft-snapshot-frame）に srcdoc で流し込んで表示する。
// 既存の showCachedPdf()（PDF.js経路）へは一切入れない
// （HTMLをPDF.jsに渡すと解析に失敗し、catch節の「Chrome内蔵ビュワー(iframe blob)への
// フォールバック」に落ちて非サンドボックスのft-pdf-frameに生HTMLが載ってしまうため。
// この暗黙のフォールバックに頼らず、ここで明示的に分岐させるのが実装内容10の目的）。
//
// 【iframeの sandbox 設定】"allow-same-origin allow-modals" のみを付け、allow-scripts は
// 絶対に付けない。
// - allow-scripts を付けない → スナップショット内のスクリプトは一切実行されない。
//   スナップショットは buildRegistrySnapshotHtml() が生成しエスケープ済みだが、保存先は
//   ユーザーが編集し得るDriveファイルなので、信頼できない前提で扱う。
// - allow-same-origin を付ける → iframeが拡張機能オリジンを継承し、親から
//   frame.contentWindow.print() を呼べる（「PDFとして保存」ボタンに必要）。allow-scripts と
//   同時に付けるとsandboxが実質無効化されるが、ここではscriptsを付けないため
//   危険な組み合わせにはならない。**将来「ついでにallow-scriptsも」と足さないこと。**
// - allow-modals は印刷ダイアログ（window.print()）に必要。
//
// 取得手順・取り違え防止（token/isStale）は showCachedPdf() と全く同じ作法に揃えている。
// ---------------------------------------------------------------------------

/** サンドボックスiframeへスナップショットHTMLを流し込んで表示する */
export function showRegistrySnapshotFrame(html: string): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    const frame = document.getElementById('ft-snapshot-frame') as HTMLIFrameElement | null;
    if (!frame) return;
    frame.srcdoc = html;
    frame.classList.remove('hidden');
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    showSnapshotSaveButton();
    // 他のiframe経路（showPdfFrame）と同じく、このモードにはPDF.jsのハイライトが無いため
    // 根拠カード一覧だけは表示する（消失させない）。registration行は通常AI evidenceを
    // 持たない想定だが、念のため既存の表示経路と挙動を揃えておく。
    renderAiCardsFallback();
}

/** スナップショットiframeを畳む（PDF等、他の表示へ戻る時に必ず呼ぶ。片方だけ実装すると
 *  文献を切り替えたときに前の表示が residue として残る） */
export function hideRegistrySnapshotFrame(): void {
    const frame = document.getElementById('ft-snapshot-frame') as HTMLIFrameElement | null;
    if (frame) {
        frame.classList.add('hidden');
        frame.removeAttribute('srcdoc');
    }
    hideSnapshotSaveButton();
}

/** PDF.js 描画コンテナを隠し、描画リソースを解放する（PDF以外を表示する時に呼ぶ） */
export function hideCanvasContainer(): void {
    const container = document.getElementById('ft-pdf-canvas-container');
    if (container) container.classList.add('hidden');
    if (session.pdfRenderer) session.pdfRenderer.destroy();
    session.currentPdfInfo = null;
}

export function showPlaceholder(msg: string): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    hideSavePdfButton();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.replaceChildren();
        appendTextWithBreaks(placeholder, msg);
    }
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.replaceChildren();
}

export function showResolvedUrl(url: string, source: OaSource | 'cached' | 'linked'): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    hideSavePdfButton();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        placeholder.replaceChildren();
        placeholder.style.display = '';

        const panel = document.createElement('div');
        panel.className = 'ft-linked-panel';

        const badge = document.createElement('span');
        badge.className = 'ft-source-badge';
        badge.textContent = sourceLabel;

        const lead = document.createElement('div');
        lead.className = 'ft-linked-lead';
        lead.textContent = 'フルテキストURLが見つかりました。クリックで左ペインに表示し、可能ならDriveへ自動保存します。';

        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn-primary ft-linked-open-btn';
        openBtn.textContent = '▶ PDFを表示';
        openBtn.addEventListener('click', () => { void getDependencies().openLinkedInline(url, source); });

        const urlNote = document.createElement('div');
        urlNote.className = 'ft-linked-url';
        urlNote.textContent = url;

        panel.append(badge, lead, openBtn, urlNote);
        placeholder.append(panel);
    }

    setUrlLabel(url, source);
    // PDF未表示でも根拠カード（quote＋ページ番号）は参照できるようにする
    renderAiCardsFallback();
}

// ---------------------------------------------------------------------------
// フルテキスト未発見時: 論文ページの埋め込み表示
// ---------------------------------------------------------------------------

// 自ビューアタブ内の sub_frame のみ対象にするDNRセッションルールの固定ID
const FRAME_DNR_RULE_ID = 4801;

/** 論文ページURL（出版社DOI優先、無ければPubMed） */
function articlePageUrl(ref: Reference): string | null {
    if (ref.doi) return `https://doi.org/${encodeURIComponent(ref.doi)}`;
    if (ref.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/`;
    return null;
}

/**
 * このビューアタブ内の sub_frame に限り、埋め込み禁止ヘッダー
 * （X-Frame-Options / CSP）を除去するDNRセッションルールを設定する。
 * tabIds で自タブに限定するので、他タブ・他ページのframe保護には影響しない。
 */
export async function enableFrameEmbeddingForThisTab(): Promise<boolean> {
    try {
        const tab = await chrome.tabs.getCurrent();
        if (!tab?.id) return false;
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [FRAME_DNR_RULE_ID],
            addRules: [{
                id: FRAME_DNR_RULE_ID,
                priority: 1,
                action: {
                    type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                    responseHeaders: [
                        { header: 'x-frame-options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
                        { header: 'content-security-policy', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
                        { header: 'content-security-policy-report-only', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
                    ],
                },
                condition: {
                    tabIds: [tab.id],
                    resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME],
                },
            }],
        });
        return true;
    } catch (err) {
        console.warn('[fulltext] frame埋め込みルールの設定に失敗:', err);
        return false;
    }
}

/**
 * フルテキスト未発見時に論文ページを枠内へ埋め込み表示する。
 * 埋め込みには全サイトアクセス権限が必要（DNRはhost access配下でのみ作用）。
 * 権限が無い/ルール設定に失敗した場合は別タブ導線パネルにフォールバックする。
 */
export async function showArticlePage(): Promise<void> {
    const url = session.currentRef ? articlePageUrl(session.currentRef) : null;
    if (!url) {
        showPlaceholder('フルテキストが見つかりませんでした。\n（DOI/PMID が無いため論文ページも開けません）');
        return;
    }

    const hasBroad = await requestBroadHostPermission();
    const ruleOk = hasBroad && await enableFrameEmbeddingForThisTab();

    hideCanvasContainer();
    hideRegistrySnapshotFrame();
    const frame = document.getElementById('ft-article-frame') as HTMLIFrameElement | null;
    if (frame && ruleOk) {
        hidePdfFrame();
        const placeholder = document.getElementById('ft-pdf-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        frame.classList.remove('hidden');
        frame.src = url;
        const label = document.getElementById('ft-pdf-url-label');
        if (label) {
            renderUrlLabel(label, '論文ページ', url);
        }
        // 論文ページ埋め込みでもAI根拠カードは参照できるようにする
        renderAiCardsFallback();
    } else {
        showArticleFallback(url);
    }
}

/** 埋め込みが使えない時の別タブ導線パネル */
function showArticleFallback(url: string): void {
    hideArticleFrame();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (!placeholder) return;
    placeholder.style.display = '';
    placeholder.replaceChildren();

    const panel = document.createElement('div');
    panel.className = 'ft-article-fallback';

    const message = document.createElement('div');
    appendTextWithBreaks(message, 'フルテキストが見つかりませんでした。\n論文ページで本文を確認してください。');

    const links = document.createElement('div');
    links.className = 'ft-fallback-links';
    links.appendChild(buildExternalAnchor(url, '↗ 論文ページを開く', 'btn btn-secondary'));
    if (session.currentRef?.pmid) {
        const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(session.currentRef.pmid)}/`;
        links.appendChild(buildExternalAnchor(pubmedUrl, '↗ PubMed で開く', 'btn btn-secondary'));
    }

    panel.append(message, links);
    placeholder.appendChild(panel);
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.replaceChildren();
    renderAiCardsFallback();
}
