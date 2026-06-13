// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// Phase 2 (実装済み): DOI/PMID → OA PDF URL 取得
// Phase 4 (本変更): 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存)
//   + フルテキスト候補リストによる前後ナビゲーション
// Phase 3 (TODO): PDF.js ビュワー + ハイライト保存 (Annotations タブ)
// Phase 5 (TODO): データ抽出モード (label 付きアノテーション)

import {
    getAuthToken,
    getUserEmail,
    getFulltextPageData,
    saveFulltextPoolRule,
    saveDecision,
    updateReferenceFulltextUrl,
} from '../lib/sheets-api';
import { retrieveAndCacheFulltext } from '../lib/fulltext-retriever';
import {
    ensureFulltextFolder,
    downloadDriveFile,
    extractDriveFileId,
    deleteDriveFile,
    uploadPdfToDrive,
    buildPdfFileName,
} from '../lib/drive-api';
import { getClientVersion } from '../lib/client-version';
import {
    isInFulltextPool,
    describeRule,
    isTiabDecision,
} from '../lib/fulltext-pool';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import { mountRuleEditor } from '../lib/fulltext-rule-editor';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference, Decision } from '../lib/types';

const OA_SOURCE_LABELS: Record<OaSource | 'cached' | 'linked', string> = {
    pmc_oa: 'PMC OA',
    europe_pmc: 'Europe PMC',
    unpaywall: 'Unpaywall',
    openalex: 'OpenAlex',
    publisher: '出版社',
    cached: 'Drive保存済み',
    linked: 'リンクのみ',
};

// ページ状態
let currentRef: Reference | null = null;
let userEmail = '';
let spreadsheetId = '';

// 全文献・全判定（候補計算とルールUIで使用）
let allRefs: Reference[] = [];
let allDecisions: Decision[] = [];

// フルテキスト候補ルール（Configシート共有設定、未設定はnull）
let poolRule: FulltextPoolRule | null = null;
let keyOpened = false;

// フルテキスト候補リスト
let fulltextCandidates: Reference[] = [];
let currentCandidateIndex = -1;

// 現在の決断パネル状態
let pendingDecision: 'include' | 'exclude' | 'maybe' | null = null;
let existingDecision: { decision: Decision; rowIndex: number } | null = null;

// ハイライト表示状態（このアプリはスクリーニング用ハイライトのみ。デフォルトON）
let highlightEnabled = true;

document.addEventListener('DOMContentLoaded', () => {
    initFulltextPage().catch(err => {
        showPlaceholder(`初期化エラー: ${(err as Error).message}`);
    });
});

async function initFulltextPage(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const refId = params.get('ref_id') ?? '';

    if (!refId) {
        showPlaceholder('ref_id が指定されていません。サイドパネルから開いてください。');
        return;
    }

    showPlaceholder('読み込み中...');

    // 認証・ユーザー情報
    await getAuthToken();
    userEmail = await getUserEmail();

    // プロジェクト設定
    const stored = await chrome.storage.local.get(['spreadsheetId']);
    spreadsheetId = (stored.spreadsheetId as string | undefined) ?? '';
    if (!spreadsheetId) {
        showPlaceholder('プロジェクトが未設定です。サイドパネルで先にプロジェクトを開いてください。');
        return;
    }

    // 文献一覧・判定一覧・Config共有設定を1リクエストで取得（429対策）
    const { references: refs, decisions: decisionsData, config } = await getFulltextPageData(spreadsheetId);

    allRefs = refs;
    allDecisions = decisionsData.map(({ decision }) => decision);
    poolRule = config.fulltextPoolRule;
    keyOpened = config.keyOpened;

    const ref = refs.find(r => r.ref_id === refId) ?? null;
    if (!ref) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }
    currentRef = ref;

    // フルテキスト候補リストを計算
    recomputeCandidates();

    // 既存のフルテキスト決断を取得
    existingDecision = decisionsData.find(
        ({ decision: d }) =>
            d.ref_id === refId &&
            d.reviewer_id === userEmail &&
            (d.screening_phase ?? 'tiab') === 'fulltext'
    ) ?? null;
    if (existingDecision) {
        pendingDecision = existingDecision.decision.decision as 'include' | 'exclude' | 'maybe';
    }

    // UI 初期化
    renderRefMeta(ref);
    renderBiblio(ref);
    renderProgress();
    renderDecisionPanel();
    wireNavButtons();
    wireDecisionButtons();
    wireAttachTabButton();
    wireReplaceButtons();
    wireHighlightToggle();
    wireRulePanel();
    updateRuleButton();
    updateToolbarMode();
    document.addEventListener('keydown', handleKeydown);

    // PDF URL 表示（cached = Drive保存済みPDFを左ペインに表示 / retrieved = 外部リンクのみ）
    const hasPdf = ref.fulltext_status === 'cached' && !!ref.fulltext_url;
    if (hasPdf) {
        void showCachedPdf(ref.fulltext_url!);
    } else if (ref.fulltext_status === 'retrieved' && ref.fulltext_url) {
        showResolvedUrl(ref.fulltext_url, 'linked');
    } else if (ref.fulltext_status === 'unavailable') {
        // 既に「入手不可」と記録済み → 論文ページを埋め込み表示
        void showArticlePage();
    } else {
        showPlaceholder('「DOI → URL解決」ボタンをクリックしてOAフルテキストを検索してください。');
    }

    // ルール未設定なら設定パネルを表示（キー未開封時はブロックメッセージ）。
    // ただし既にPDFがある＝判定作業中は縦スペースを優先し自動展開しない
    // （ヘッダーの「候補ルール ▾」からいつでも開ける）。
    if (!poolRule && !hasPdf) {
        openRulePanel();
    }

    document.getElementById('ft-doi-resolve-btn')
        ?.addEventListener('click', () => { void handleResolve(); });
}

/**
 * PDFの取得状態に応じてツールバーのボタンを出し分ける。
 * - PDF保存済み(cached): 取得導線を隠し、差し替え（再アップロード/削除）導線を表示
 * - それ以外: 取得導線（タブアタッチ/DOI解決）を表示
 */
function updateToolbarMode(): void {
    const hasPdf = currentRef?.fulltext_status === 'cached' && !!currentRef.fulltext_url;
    const attach = document.getElementById('ft-attach-tab-btn');
    const resolve = document.getElementById('ft-doi-resolve-btn');
    const replace = document.getElementById('ft-replace-btn');
    const del = document.getElementById('ft-delete-btn');
    attach?.classList.toggle('hidden', hasPdf);
    resolve?.classList.toggle('hidden', hasPdf);
    replace?.classList.toggle('hidden', !hasPdf);
    del?.classList.toggle('hidden', !hasPdf);
}

// ---------------------------------------------------------------------------
// フルテキスト候補ルール
// ---------------------------------------------------------------------------

/**
 * 候補リストを再計算する
 * - ルール設定済み: 採用voterのInclude票が必要票数以上の文献
 * - 未設定: 自分が TiAb で Include した文献（レガシー動作）
 */
function recomputeCandidates(): void {
    if (poolRule) {
        const rule = poolRule;
        const byRef = new Map<string, Decision[]>();
        for (const d of allDecisions) {
            const list = byRef.get(d.ref_id);
            if (list) {
                list.push(d);
            } else {
                byRef.set(d.ref_id, [d]);
            }
        }
        fulltextCandidates = allRefs.filter(r => isInFulltextPool(byRef.get(r.ref_id) ?? [], rule));
    } else {
        const myTiabIncludes = new Set(
            allDecisions
                .filter(d =>
                    d.reviewer_id === userEmail &&
                    d.decision === 'include' &&
                    isTiabDecision(d)
                )
                .map(d => d.ref_id)
        );
        fulltextCandidates = allRefs.filter(r => myTiabIncludes.has(r.ref_id));
    }
    currentCandidateIndex = currentRef
        ? fulltextCandidates.findIndex(r => r.ref_id === currentRef!.ref_id)
        : -1;
}

function updateRuleButton(): void {
    const btn = document.getElementById('ft-rule-btn');
    if (!btn) return;
    btn.textContent = poolRule
        ? `候補ルール: ${describeRule(poolRule)} ▾`
        : '候補ルール: 未設定 ▾';
}

function wireRulePanel(): void {
    document.getElementById('ft-rule-btn')?.addEventListener('click', () => {
        const section = document.getElementById('ft-rule-section');
        if (section && !section.classList.contains('hidden')) {
            section.classList.add('hidden');
        } else {
            openRulePanel();
        }
    });
}

function openRulePanel(): void {
    const section = document.getElementById('ft-rule-section');
    const container = document.getElementById('ft-rule-editor-container');
    if (!section || !container) return;

    section.classList.remove('hidden');

    mountRuleEditor({
        container,
        references: allRefs,
        decisions: allDecisions,
        currentRule: poolRule,
        keyOpened,
        onSave: async (rule) => {
            await saveFulltextPoolRule(spreadsheetId, rule);
            poolRule = rule;
            recomputeCandidates();
            renderProgress();
            updateRuleButton();
            section.classList.add('hidden');
        },
        onClose: () => section.classList.add('hidden'),
    });
}

// ---------------------------------------------------------------------------
// 決断パネル
// ---------------------------------------------------------------------------

function renderDecisionPanel(): void {
    // 現在の決断状態をボタンに反映
    updateDecisionButtons();
    // 除外理由エリアの表示制御
    updateReasonArea();
    // 保存ボタンの表示
    updateSaveButton();
}

function wireDecisionButtons(): void {
    document.getElementById('ft-btn-include')?.addEventListener('click', () => { void chooseDecision('include'); });
    document.getElementById('ft-btn-exclude')?.addEventListener('click', () => { void chooseDecision('exclude'); });
    document.getElementById('ft-btn-maybe')?.addEventListener('click', () => { void chooseDecision('maybe'); });
    document.getElementById('ft-save-btn')?.addEventListener('click', () => { void handleSave(); });

    // 除外理由・メモの変更は（既に除外判定済みのとき）その場で再保存する
    document.getElementById('ft-reason-select')?.addEventListener('change', () => {
        if (pendingDecision === 'exclude') void handleSave();
    });
    document.getElementById('ft-reason-note')?.addEventListener('change', () => {
        if (pendingDecision) void handleSave();
    });
}

/**
 * 判定を選択して即保存する（TiAbレビューと同じ即保存挙動）。
 * 除外の場合は理由エリアを表示し、理由は空のまま即保存する
 * （後から理由/メモを選ぶと change イベントで再保存される）。
 */
async function chooseDecision(decision: 'include' | 'exclude' | 'maybe'): Promise<void> {
    pendingDecision = decision;
    renderDecisionPanel();
    await handleSave();
}

function updateDecisionButtons(): void {
    const states: Array<['include' | 'exclude' | 'maybe', string]> = [
        ['include', 'ft-btn-include'],
        ['exclude', 'ft-btn-exclude'],
        ['maybe', 'ft-btn-maybe'],
    ];
    for (const [val, id] of states) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        if (pendingDecision === val) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }
}

function updateReasonArea(): void {
    const area = document.getElementById('ft-reason-area');
    if (!area) return;
    if (pendingDecision === 'exclude') {
        area.classList.remove('hidden');
        // 既存の理由を復元
        if (existingDecision?.decision.decision === 'exclude') {
            const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
            const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
            if (select && existingDecision.decision.reason) {
                select.value = existingDecision.decision.reason;
            }
            if (note && existingDecision.decision.note) {
                note.value = existingDecision.decision.note;
            }
        }
    } else {
        area.classList.add('hidden');
    }
}

function updateSaveButton(): void {
    // 判定は即保存されるため保存ボタンは常に非表示
    const btn = document.getElementById('ft-save-btn');
    btn?.classList.add('hidden');
}

async function handleSave(): Promise<void> {
    if (!currentRef || !pendingDecision) return;

    const saveBtn = document.getElementById('ft-save-btn') as HTMLButtonElement | null;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        const reasonNote = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;

        const decisionObj: Decision = {
            decision_id: existingDecision?.decision.decision_id ?? crypto.randomUUID(),
            ref_id: currentRef.ref_id,
            reviewer_id: userEmail,
            decision: pendingDecision,
            reason: pendingDecision === 'exclude' ? (reasonSelect?.value || undefined) : undefined,
            note: reasonNote?.value || undefined,
            decided_at: new Date().toISOString(),
            client_version: getClientVersion('-human'),
            source_url: window.location.href,
            screening_phase: 'fulltext',
        };

        await saveDecision(spreadsheetId, decisionObj);

        // 保存成功: existingDecision を更新
        if (existingDecision) {
            existingDecision.decision = decisionObj;
        } else {
            existingDecision = { decision: decisionObj, rowIndex: -1 };
        }

        showFeedback('保存しました');
    } catch (err) {
        showFeedback(`保存失敗: ${(err as Error).message}`, true);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    }
}

let feedbackTimer: number | undefined;
function showFeedback(msg: string, isError = false): void {
    const anchor = document.querySelector('.ft-decision-buttons');
    if (!anchor) return;
    const id = 'ft-feedback';
    document.getElementById(id)?.remove();
    const feedback = document.createElement('div');
    feedback.id = id;
    feedback.textContent = msg;
    feedback.style.cssText = `font-size:12px;margin-top:8px;color:${isError ? '#e74c3c' : '#27ae60'}`;
    anchor.insertAdjacentElement('afterend', feedback);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => feedback.remove(), 3000);
}

// ---------------------------------------------------------------------------
// ナビゲーション
// ---------------------------------------------------------------------------

function wireNavButtons(): void {
    document.getElementById('ft-prev-btn')?.addEventListener('click', () => navigate(-1));
    document.getElementById('ft-next-btn')?.addEventListener('click', () => navigate(1));
}

function navigate(delta: number): void {
    if (fulltextCandidates.length === 0) return;
    const newIndex = (currentCandidateIndex + delta + fulltextCandidates.length) % fulltextCandidates.length;
    const nextRef = fulltextCandidates[newIndex];
    if (!nextRef) return;

    const url = new URL(window.location.href);
    url.searchParams.set('ref_id', nextRef.ref_id);
    window.location.href = url.toString();
}

// ---------------------------------------------------------------------------
// OA URL 解決
// ---------------------------------------------------------------------------

// PMC系・Springer以外（Unpaywall/OpenAlex経由の任意出版社）のPDFをfetchするには
// 全HTTPSサイトの実行時権限が要る。拒否されても既存host_permission内のPDFは取得できる。
function requestBroadHostPermission(): Promise<boolean> {
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

async function handleResolve(): Promise<void> {
    if (!currentRef) return;

    const btn = document.getElementById('ft-doi-resolve-btn') as HTMLButtonElement | null;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '検索中...';
    }

    showPlaceholder('OAソースを順番に検証中...\nPMC OA → Europe PMC → 出版社 → Unpaywall → OpenAlex');

    // ボタンクリック（ユーザージェスチャ）起点なので権限ダイアログを出せる
    await requestBroadHostPermission();

    try {
        // タブの一括取得と同じ検証付き経路。各候補を実際に検証し、
        // 実PDFが取れれば Drive に保存（cached）、ダメなら開けるURLをリンク記録（linked）。
        const outcome = await retrieveAndCacheFulltext(
            currentRef, userEmail,
            () => ensureFulltextFolder(spreadsheetId)
        );

        if (outcome.kind === 'cached') {
            await showCachedPdf(outcome.url);
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, outcome.url, 'cached')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        } else if (outcome.kind === 'linked') {
            showResolvedUrl(outcome.url, outcome.source);
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, outcome.url, 'retrieved')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        } else {
            // OA全文は無い → 論文ページ（出版社/PubMed）を枠内に埋め込み表示
            await showArticlePage();
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, '', 'unavailable')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        }
    } catch (err) {
        showPlaceholder(`取得エラー: ${(err as Error).message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'DOI → URL解決';
        }
    }
}

// ---------------------------------------------------------------------------
// タブアタッチ（URL手入力）
// ---------------------------------------------------------------------------

function wireAttachTabButton(): void {
    document.getElementById('ft-attach-tab-btn')?.addEventListener('click', () => {
        const url = window.prompt('PDFのURLを入力してください（現在のタブのURLをコピーして貼り付けてください）:');
        if (!url) return;
        // Drive のリンクならそのままPDFを左ペインに表示、それ以外はリンク表示
        void showCachedPdf(url);
        if (currentRef) {
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, url, 'retrieved')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        }
    });
}

// ---------------------------------------------------------------------------
// PDF 差し替え（誤ったPDFの削除 + 再アップロード）
// ---------------------------------------------------------------------------

function wireReplaceButtons(): void {
    document.getElementById('ft-replace-btn')?.addEventListener('click', () => {
        const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
        if (input) {
            input.value = '';
            input.click();
        }
    });
    document.getElementById('ft-upload-input')?.addEventListener('change', () => {
        void handleUpload();
    });
    document.getElementById('ft-delete-btn')?.addEventListener('click', () => {
        void handleDeletePdf();
    });
}

/** 保存済みPDFをDriveから削除し、参照を未取得状態へ戻す */
async function handleDeletePdf(): Promise<void> {
    if (!currentRef || !currentRef.fulltext_url) return;
    if (!window.confirm('このPDFをDriveから削除します。よろしいですか？\n（削除後、この画面から正しいPDFをアップロードできます）')) {
        return;
    }

    const delBtn = document.getElementById('ft-delete-btn') as HTMLButtonElement | null;
    if (delBtn) { delBtn.disabled = true; delBtn.textContent = '削除中...'; }

    try {
        const fileId = extractDriveFileId(currentRef.fulltext_url);
        if (fileId) {
            await deleteDriveFile(fileId);
        }
        await updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, '', 'not_retrieved');
        currentRef.fulltext_url = '';
        currentRef.fulltext_status = 'not_retrieved';
        showPlaceholder('PDFを削除しました。\n「別のPDFをアップロード」または「DOI → URL解決」で再取得してください。');
        updateToolbarMode();
    } catch (err) {
        window.alert(`削除に失敗しました: ${(err as Error).message}`);
    } finally {
        if (delBtn) { delBtn.disabled = false; delBtn.textContent = 'PDFを削除'; }
    }
}

/** 選択されたPDFファイルをDriveへアップロードして表示する */
async function handleUpload(): Promise<void> {
    if (!currentRef) return;
    const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    // マジックナンバーでPDF検証
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (!String.fromCharCode(...head).startsWith('%PDF')) {
        window.alert('PDFファイルではないようです。.pdf ファイルを選択してください。');
        return;
    }

    const replaceBtn = document.getElementById('ft-replace-btn') as HTMLButtonElement | null;
    if (replaceBtn) { replaceBtn.disabled = true; replaceBtn.textContent = 'アップロード中...'; }

    showPlaceholder('Drive へPDFをアップロード中...');
    try {
        const folderId = await ensureFulltextFolder(spreadsheetId);
        const info = await uploadPdfToDrive(folderId, buildPdfFileName(currentRef), file);
        await updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, info.webViewLink, 'cached');
        currentRef.fulltext_url = info.webViewLink;
        currentRef.fulltext_status = 'cached';
        await showCachedPdf(info.webViewLink);
        updateToolbarMode();
    } catch (err) {
        showPlaceholder(`アップロードに失敗しました: ${(err as Error).message}`);
    } finally {
        if (replaceBtn) { replaceBtn.disabled = false; replaceBtn.textContent = '別のPDFをアップロード'; }
    }
}

// ---------------------------------------------------------------------------
// ハイライト表示トグル（スクリーニング用ハイライトのON/OFF、デフォルトON）
// ---------------------------------------------------------------------------

function wireHighlightToggle(): void {
    const checkbox = document.getElementById('ft-highlight-checkbox') as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = highlightEnabled;
    checkbox.addEventListener('change', () => {
        highlightEnabled = checkbox.checked;
        applyHighlightVisibility();
    });
    applyHighlightVisibility();
}

/** ハイライトオーバーレイ／アノテーション一覧の表示をトグル状態に同期する */
function applyHighlightVisibility(): void {
    const list = document.getElementById('ft-annotations-list');
    if (list) list.style.display = highlightEnabled ? '' : 'none';
    document.querySelectorAll('.ft-highlight').forEach(el => {
        (el as HTMLElement).style.display = highlightEnabled ? '' : 'none';
    });
}

// ---------------------------------------------------------------------------
// キーボードショートカット（TiAbレビューと同一割り当て）
// ---------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
    // 入力フォーム内では無効
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement) {
        return;
    }
    // 修飾キー併用時は無効
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    switch (e.key.toLowerCase()) {
        case 'i': // Include
            void chooseDecision('include');
            e.preventDefault();
            break;
        case 'e': // Exclude
            void chooseDecision('exclude');
            e.preventDefault();
            break;
        case 'm': // Maybe
        case '?':
            void chooseDecision('maybe');
            e.preventDefault();
            break;
        case 'arrowright': // Next
        case 'j':
            navigate(1);
            e.preventDefault();
            break;
        case 'arrowleft': // Prev
        case 'k':
            navigate(-1);
            e.preventDefault();
            break;
    }
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

function renderRefMeta(ref: Reference): void {
    const el = document.getElementById('ft-ref-meta');
    if (!el) return;
    const parts: string[] = [];
    if (ref.title) {
        parts.push(ref.title.length > 80 ? ref.title.substring(0, 80) + '…' : ref.title);
    }
    if (ref.year) parts.push(String(ref.year));
    if (ref.journal) parts.push(ref.journal);
    el.textContent = parts.join(' · ');
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * PDFペイン上部に書誌情報を表示する。
 * 表示中PDFの本文（タイトル・著者・誌名・年）と突き合わせて、
 * 誤ったPDFが保存されていないかをレビュアーが判断できるようにする。
 */
function renderBiblio(ref: Reference): void {
    const bar = document.getElementById('ft-biblio');
    const titleEl = document.getElementById('ft-biblio-title');
    const metaEl = document.getElementById('ft-biblio-meta');
    const idsEl = document.getElementById('ft-biblio-ids');
    if (!bar || !titleEl || !metaEl || !idsEl) return;

    titleEl.textContent = ref.title || '(タイトルなし)';

    // 著者 · 誌名 year;vol(issue):pages
    const metaParts: string[] = [];
    if (ref.authors) metaParts.push(ref.authors);
    let cite = '';
    if (ref.journal) cite += ref.journal;
    if (ref.year) cite += (cite ? ' ' : '') + ref.year;
    let loc = '';
    if (ref.volume) loc += ref.volume;
    if (ref.issue) loc += `(${ref.issue})`;
    if (ref.pages) loc += `:${ref.pages}`;
    if (loc) cite += (cite ? ';' : '') + loc;
    if (cite) metaParts.push(cite);
    metaEl.textContent = metaParts.join(' · ');

    // DOI / PMID リンク
    const idLinks: string[] = [];
    if (ref.doi) {
        const doi = escapeHtml(ref.doi);
        idLinks.push(`<a href="https://doi.org/${encodeURIComponent(ref.doi)}" target="_blank" rel="noopener noreferrer">DOI: ${doi}</a>`);
    }
    if (ref.pmid) {
        const pmid = escapeHtml(ref.pmid);
        idLinks.push(`<a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/" target="_blank" rel="noopener noreferrer">PMID: ${pmid}</a>`);
    }
    idsEl.innerHTML = idLinks.join('');
    idsEl.classList.toggle('hidden', idLinks.length === 0);

    bar.classList.remove('hidden');
}

function renderProgress(): void {
    const el = document.getElementById('ft-progress');
    if (!el) return;
    if (fulltextCandidates.length === 0) {
        el.textContent = '';
        return;
    }
    if (currentCandidateIndex === -1) {
        // この文献は現在の候補条件に含まれていない（判定・保存は可能）
        el.textContent = `候補外（候補 ${fulltextCandidates.length}件）`;
        return;
    }
    el.textContent = `${currentCandidateIndex + 1} / ${fulltextCandidates.length}`;
}

function hideArticleFrame(): void {
    const frame = document.getElementById('ft-article-frame') as HTMLIFrameElement | null;
    if (frame) {
        frame.classList.add('hidden');
        frame.removeAttribute('src');
    }
}

// 表示中のPDF blob URL（解放用）
let currentPdfObjectUrl: string | null = null;

function hidePdfFrame(): void {
    const frame = document.getElementById('ft-pdf-frame') as HTMLIFrameElement | null;
    if (frame) {
        frame.classList.add('hidden');
        frame.removeAttribute('src');
    }
    if (currentPdfObjectUrl) {
        URL.revokeObjectURL(currentPdfObjectUrl);
        currentPdfObjectUrl = null;
    }
}

function showPdfFrame(src: string): void {
    hideArticleFrame();
    const frame = document.getElementById('ft-pdf-frame') as HTMLIFrameElement | null;
    if (!frame) return;
    frame.src = src;
    frame.classList.remove('hidden');
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) placeholder.style.display = 'none';
}

function setUrlLabel(url: string, source: OaSource | 'cached' | 'linked'): void {
    const label = document.getElementById('ft-pdf-url-label');
    if (!label) return;
    const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
    label.innerHTML =
        `<span class="ft-source-badge">${sourceLabel}</span>` +
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
}

/**
 * Drive保存済みPDFを左ペインに表示する。
 * 1. Drive API (alt=media) でPDFバイトを取得し blob URL を内蔵ビュワーで表示
 * 2. drive.file スコープ外（他レビュアーが保存したファイル等）で取得できない場合は
 *    Drive のプレビュー埋め込み (/preview) にフォールバック
 * 3. Drive 以外のURL（タブアタッチで手入力した直リンク等）は従来のリンク表示
 */
async function showCachedPdf(url: string): Promise<void> {
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        showResolvedUrl(url, 'cached');
        return;
    }

    showPlaceholder('Drive から PDF を読み込み中...');
    setUrlLabel(url, 'cached');

    try {
        const blob = await downloadDriveFile(fileId);
        hidePdfFrame(); // 旧 blob URL を解放
        currentPdfObjectUrl = URL.createObjectURL(blob);
        showPdfFrame(currentPdfObjectUrl);
    } catch (err) {
        console.warn('[fulltext] Drive APIでのPDF取得に失敗、プレビュー埋め込みへフォールバック:', err);
        showPdfFrame(`https://drive.google.com/file/d/${fileId}/preview`);
    }
    setUrlLabel(url, 'cached');
}

function showPlaceholder(msg: string): void {
    hideArticleFrame();
    hidePdfFrame();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.innerHTML = msg.replace(/\n/g, '<br>');
    }
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.innerHTML = '';
}

function showResolvedUrl(url: string, source: OaSource | 'cached' | 'linked'): void {
    hideArticleFrame();
    hidePdfFrame();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        placeholder.innerHTML =
            `<span class="ft-source-badge">${sourceLabel}</span>` +
            `フルテキストURLが見つかりました。<br>` +
            `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ft-pdf-link">${url}</a>`;
        placeholder.style.display = '';
    }

    setUrlLabel(url, source);
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
async function enableFrameEmbeddingForThisTab(): Promise<boolean> {
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
async function showArticlePage(): Promise<void> {
    const url = currentRef ? articlePageUrl(currentRef) : null;
    if (!url) {
        showPlaceholder('フルテキストが見つかりませんでした。\n（DOI/PMID が無いため論文ページも開けません）');
        return;
    }

    const hasBroad = await requestBroadHostPermission();
    const ruleOk = hasBroad && await enableFrameEmbeddingForThisTab();

    const frame = document.getElementById('ft-article-frame') as HTMLIFrameElement | null;
    if (frame && ruleOk) {
        hidePdfFrame();
        const placeholder = document.getElementById('ft-pdf-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        frame.classList.remove('hidden');
        frame.src = url;
        const label = document.getElementById('ft-pdf-url-label');
        if (label) {
            label.innerHTML =
                '<span class="ft-source-badge">論文ページ</span>' +
                `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        }
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
    const pubmedLink = currentRef?.pmid
        ? `<a class="btn btn-secondary" href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(currentRef.pmid)}/" target="_blank" rel="noopener noreferrer">↗ PubMed で開く</a>`
        : '';
    placeholder.innerHTML = `
        <div class="ft-article-fallback">
            <div>フルテキストが見つかりませんでした。<br>論文ページで本文を確認してください。</div>
            <div class="ft-fallback-links">
                <a class="btn btn-secondary" href="${url}" target="_blank" rel="noopener noreferrer">↗ 論文ページを開く</a>
                ${pubmedLink}
            </div>
        </div>`;
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.innerHTML = '';
}
