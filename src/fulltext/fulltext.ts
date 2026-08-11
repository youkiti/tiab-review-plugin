// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// 実装済み:
//   - DOI/PMID → OA PDF URL 取得、Drive保存(cached)
//   - 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存) + 候補リストの前後ナビ
//   - PDF.js ビュワー (pdf-renderer.ts): cached PDF をテキストレイヤー付きで描画
//   - AIフルテキスト判定の evidence ハイライト表示（テキストマッチ→bbox→ページ送りの段階縮退）
//     と、判定パネル上部の AI判定サマリ提示（AI票はサイドパネルの「AI判定」タブで一括生成）
// TODO:
//   - 人手アノテーションの作成・Annotations タブへの保存
//   - データ抽出モード (label 付きアノテーション)

import { setPlatform } from '../platform';
import { chromePlatform } from '../platform/chrome';
setPlatform(chromePlatform);

import {
    getAuthToken,
    getUserEmail,
    getFulltextPageData,
    saveDecision,
    updateReferenceFulltextUrl,
    isUserAdmin,
} from '../lib/sheets-api';
import { platform } from '../platform';
import { retrieveAndCacheFulltext, fetchPdfResult } from '../lib/fulltext-retriever';
import {
    ensureFulltextFolder,
    downloadDriveFile,
    extractDriveFileId,
    deleteDriveFile,
    uploadPdfToDrive,
    buildPdfFileName,
    describeDriveAccessError,
} from '../lib/drive-api';
import { getClientVersion } from '../lib/client-version';
import { t } from '../lib/i18n';
import {
    isTiabDecision,
} from '../lib/fulltext-pool';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import { explainEmptyFulltextCandidates } from '../lib/fulltext-empty-reason';
import { explainEmptyAiEvidence } from '../lib/ai-evidence-empty-reason';
import type { AiEvidenceEmptyReason } from '../lib/ai-evidence-empty-reason';
import { isFulltextCandidateRef } from '../lib/fulltext-candidates';
import {
    canSeeFulltextRef,
    createDefaultFulltextAssignment,
    initialSelectedFulltextSets,
    normalizeStoredFulltextSets,
    matchesSelectedFulltextSets,
} from '../lib/fulltext-assignment';
import type { FulltextAssignmentConfig } from '../lib/fulltext-assignment';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference, Decision, FulltextLlmDecisionNote } from '../lib/types';
import type { FulltextEvidenceDisplay } from '../lib/sheets-api';
import { PdfRenderer } from './pdf-renderer';
import type { LoadedPdf, HighlightCategory } from './pdf-renderer';

const OA_SOURCE_LABELS: Record<OaSource | 'cached' | 'linked', string> = {
    pmc_oa: 'PMC OA',
    europe_pmc: 'Europe PMC',
    unpaywall: 'Unpaywall',
    openalex: 'OpenAlex',
    publisher: '出版社',
    landing_meta: '出版社PDF',
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
// フルテキスト担当割り振り（Configシート共有設定、未設定は status 'none' = 全員が全候補）
let ftAssignment: FulltextAssignmentConfig = createDefaultFulltextAssignment();
// サイドパネルの担当セットフィルタで選択されたセット（起動時に一度だけ読む。以後の追従は不要）
let selectedFulltextSets: Set<string> = new Set();
let keyOpened = false;

// 採用中のフルテキストAI判定ラウンド（reviewer_id）。サマリ/ハイライトはこのラウンドを優先する。
let aiActiveRound: string | null = null;

// 現在ユーザーが管理者（編集権限）か。AI判定の開示トグルを出すかの判定に使う。
let isAdmin = false;
// AI判定（サマリ・evidenceハイライト・根拠カード）を開示するか。
// ブラインド情報のため、ブラインド解除(keyOpened) かつ 管理者 のときのみ既定で開示。
// 管理者は画面内トグルで切り替えられる。非管理者には一切表示しない。
let aiReveal = false;
// ブラインド中のAI evidence 表示レベル（Config共有設定 fulltext_evidence_display）。
// none: evidence非表示 / neutral: 単色・polarityなし / full: 色分け・polarityあり
let evidenceDisplay: FulltextEvidenceDisplay = 'neutral';

/**
 * 現在のAI evidence の実効表示レベル。
 * 開示中（aiReveal）は常に full。ブラインド中はプロジェクト共有設定に従う。
 * polarity（組入/除外の色・ラベル）の並びからAI判断が推測できてしまうため、
 * ブラインド中は既定（neutral）で polarity を伏せる。
 */
function effectiveEvidenceLevel(): FulltextEvidenceDisplay {
    return aiReveal ? 'full' : evidenceDisplay;
}

// フルテキスト候補リスト
let fulltextCandidates: Reference[] = [];
// 担当セットのチェックボックス絞り込み適用前の候補数（renderProgress の空理由判定用）
let candidateCountBeforeSetFilter = 0;
let currentCandidateIndex = -1;

// 先読みしたPDF（ref_id → Blob取得Promise）。隣接候補を事前取得し遷移を高速化する。
const pdfPrefetch = new Map<string, Promise<Blob | null>>();
// ページ内遷移トークン。非同期PDF取得中に別の文献へ移った場合の遅延描画（取り違え）を防ぐ。
let loadToken = 0;
function isStale(token: number): boolean {
    return token !== loadToken;
}

// 現在の決断パネル状態
let pendingDecision: 'include' | 'exclude' | 'maybe' | null = null;
let existingDecision: { decision: Decision; rowIndex: number } | null = null;

// 除外理由 select をポインタ（マウス/タッチ）で操作中かどうか。
// リストボックス（size付きselect）はクリックでも change が発火するため、
// 「クリック選択 → 保存して次へ」と「↑↓キーでのブラウズ → 保存のみ」を
// 区別するのに使う。
let reasonPointerDown = false;
// 今回のポインタ操作中に理由の値が変わったかどうか。
// select の外で離した（クリック不成立）場合に、表示と保存を一致させる
// 保存だけを行うための判定に使う。
let reasonChangedByPointer = false;

// 除外理由の選択肢（fulltext.html の <select> のオプション順と一致させる）。
// 数字キー 1〜7 のショートカット割り当てに使う。
const REASON_VALUES = [
    'population',
    'intervention',
    'comparator',
    'outcome',
    'study_design',
    'duplicate',
    'other',
] as const;

// ハイライト表示状態（このアプリはスクリーニング用ハイライトのみ。デフォルトON）
let highlightEnabled = true;

// PDF.js レンダラ（cached PDF をテキストレイヤー付きで描画する）。
// 初回利用時に生成し、文献遷移ごとに loadPdf で描き直す。
let pdfRenderer: PdfRenderer | null = null;
// 現在表示中PDFのメタ（scanned判定など）。ハイライト戦略の出し分けに使う。
let currentPdfInfo: LoadedPdf | null = null;

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
    const { references: refs, decisions: decisionsData, config } = await getFulltextPageData(spreadsheetId, userEmail);

    allRefs = refs;
    allDecisions = decisionsData.map(({ decision }) => decision);
    poolRule = config.fulltextPoolRule;
    ftAssignment = config.fulltextAssignment;
    keyOpened = config.keyOpened;
    aiActiveRound = config.fulltextAiActiveRound;

    // 管理者判定（権限API）。失敗時は安全側で非管理者扱い。
    isAdmin = await isUserAdmin(spreadsheetId, userEmail).catch(() => false);
    // AI「判断」サマリの既定開示: ブラインド解除済み(keyOpened)なら表示。
    // ブラインド中は隠し、管理者だけが画面内トグルで開示できる。
    // ※ evidence ハイライト・根拠カードはブラインド中、共有設定 evidenceDisplay に従って
    //   縮退表示する（既定 neutral: 単色・polarityなし）。開示時のみ色分け・polarityを出す。
    aiReveal = keyOpened;
    evidenceDisplay = config.fulltextEvidenceDisplay;

    // サイドパネルの担当セットフィルタ選択を読み込む（起動時に一度だけ。以後の追従は不要）。
    // このページは拡張専用なので chrome.storage.local を直接読む
    // （サイドパネル側は platform().storageGet/Set 経由で同じキーへ書き込む）。
    try {
        const storedSelection = await chrome.storage.local.get(['selectedFulltextSets']);
        const map = storedSelection.selectedFulltextSets as Record<string, string[]> | undefined;
        const storedForProject = map?.[spreadsheetId];
        selectedFulltextSets = storedForProject
            ? normalizeStoredFulltextSets(storedForProject, ftAssignment, userEmail)
            : initialSelectedFulltextSets(ftAssignment, userEmail);
    } catch (err) {
        console.warn('[fulltext] 担当セットフィルタ選択の読み込みに失敗:', err);
        selectedFulltextSets = initialSelectedFulltextSets(ftAssignment, userEmail);
    }

    currentRef = refs.find(r => r.ref_id === refId) ?? null;
    if (!currentRef) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }

    // フルテキスト候補リストを計算
    recomputeCandidates();

    // イベントリスナーとルールボタンは一度だけ初期化する
    // （ページ内遷移では再リロードしないため、ここで張った購読がそのまま使われる）。
    wireNavButtons();
    wireDecisionButtons();
    wireSavePdfButton();
    wireReplaceButtons();
    wireHighlightToggle();
    setupAiRevealToggle();
    document.addEventListener('keydown', handleKeydown);

    // 最初の文献を表示
    await loadRef(refId);
}

/**
 * 指定した文献を「ページ内で」表示する。
 * ページ全体をリロードせずに状態とUIだけを差し替えることで、
 * ナビゲーションのたびに Sheets を再取得するコストと描画のちらつきを無くす。
 */
async function loadRef(refId: string): Promise<void> {
    const ref = allRefs.find(r => r.ref_id === refId) ?? null;
    if (!ref) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }
    const token = ++loadToken;
    currentRef = ref;
    currentCandidateIndex = fulltextCandidates.findIndex(r => r.ref_id === refId);

    // URL を現在の文献へ同期（リロード・ブックマーク・保存時の source_url 用）
    const url = new URL(window.location.href);
    url.searchParams.set('ref_id', refId);
    history.replaceState(null, '', url.toString());

    // この文献の既存フルテキスト判定を復元
    existingDecision = findMyFulltextDecision(refId);
    pendingDecision = existingDecision
        ? (existingDecision.decision.decision as 'include' | 'exclude' | 'maybe')
        : null;

    // 直前のフィードバックやフォーカスを片付け（i/e/m が効くよう body にフォーカスを戻す）
    document.getElementById('ft-feedback')?.remove();
    (document.activeElement as HTMLElement | null)?.blur?.();

    // 前の文献のAI判定ハイライト・根拠カードを消す。
    // applyHighlightsForCurrentRef は PDF.js 描画経路でしか呼ばれないため、
    // リンクのみ表示・論文ページ埋め込み・プレビュー等の経路では一覧が前の文献のまま残る。
    // ここで毎回リセットし、当該文献にAI判定が無ければ空表示にする。
    clearAiHighlights();

    renderBiblio(ref);
    renderContextPanel(ref);
    renderProgress();
    renderOverallProgress();
    renderDecisionPanel();
    updateToolbarMode();

    // 隣接候補のPDFを先読み（現在文献は前回のうちに先読み済みなら即表示できる）
    prefetchNeighbors();

    // PDF 表示
    await showPdfForRef(ref, token);
}

/** PDFの取得状態に応じて左ペインを描画する */
async function showPdfForRef(ref: Reference, token: number): Promise<void> {
    const hasPdf = ref.fulltext_status === 'cached' && !!ref.fulltext_url;
    if (hasPdf) {
        await showCachedPdf(ref.fulltext_url!, token);
    } else if (ref.fulltext_status === 'retrieved' && ref.fulltext_url) {
        showResolvedUrl(ref.fulltext_url, 'linked');
    } else if (ref.fulltext_status === 'unavailable') {
        // 既に「入手不可」と記録済み → 論文ページを埋め込み表示
        await showArticlePage();
    } else {
        // 未取得 → 表示時に自動でOAフルテキストを検索する
        await handleResolve(token);
    }
}

/** 現在のユーザーによるこの文献のフルテキスト判定（最新）を返す */
function findMyFulltextDecision(refId: string): { decision: Decision; rowIndex: number } | null {
    const mine = allDecisions
        .filter(d =>
            d.ref_id === refId &&
            d.reviewer_id === userEmail &&
            (d.screening_phase ?? 'tiab') === 'fulltext'
        )
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));
    return mine.length > 0 ? { decision: mine[0], rowIndex: -1 } : null;
}

/** この文献に（pending 以外の）自分のフルテキスト判定があるか */
function isDecided(refId: string): boolean {
    const d = findMyFulltextDecision(refId);
    return !!d && d.decision.decision !== 'pending';
}

/**
 * 現在地から先の候補PDF（最大2件）をメモリに先読みする。
 * 先読みは Drive 保存済み(cached)PDFのみ対象。現在地から離れた古い先読みは破棄してメモリを節約する。
 */
function prefetchNeighbors(): void {
    if (currentCandidateIndex < 0) return;
    const keep = new Set<string>();
    if (currentRef) keep.add(currentRef.ref_id);
    for (let d = 1; d <= 2; d++) {
        const ref = fulltextCandidates[currentCandidateIndex + d];
        if (!ref || ref.fulltext_status !== 'cached' || !ref.fulltext_url) continue;
        const fileId = extractDriveFileId(ref.fulltext_url);
        if (!fileId) continue;
        keep.add(ref.ref_id);
        if (!pdfPrefetch.has(ref.ref_id)) {
            pdfPrefetch.set(ref.ref_id, downloadDriveFile(fileId).catch(() => null));
        }
    }
    for (const key of [...pdfPrefetch.keys()]) {
        if (!keep.has(key)) pdfPrefetch.delete(key);
    }
}

/**
 * PDFの取得状態に応じてツールバーのボタンを出し分ける。
 * - PDF保存済み(cached): 差し替え（再アップロード/削除）導線を表示し、手動保存導線は隠す
 * - それ以外: 差し替え導線を隠す（取得は自動検索／リンククリックで行う）
 */
function updateToolbarMode(): void {
    const hasPdf = currentRef?.fulltext_status === 'cached' && !!currentRef.fulltext_url;
    const replace = document.getElementById('ft-replace-btn');
    const del = document.getElementById('ft-delete-btn');
    const upload = document.getElementById('ft-upload-btn');
    replace?.classList.toggle('hidden', !hasPdf);
    del?.classList.toggle('hidden', !hasPdf);
    // PDF未保存時は常に「⬆ PDFをアップロード」を出す。
    // 論文ページ埋め込み中・リンクのみ表示中でも手元のPDFをDriveへ保存できるようにする。
    upload?.classList.toggle('hidden', hasPdf);
    // 保存済みになったら「このPDFを保存」導線は不要
    if (hasPdf) hideSavePdfButton();
}

// ---------------------------------------------------------------------------
// フルテキスト候補ルール
// ---------------------------------------------------------------------------

/**
 * 候補リストを再計算する（判定は isFulltextCandidateRef に委譲。詳細は fulltext-candidates.ts 参照）
 * - 割り振り設定済み: fulltext_set が非空の文献 ∪ ルール評価で候補入りする未割り当て流入分
 * - 未設定:
 *   - ルール設定済み: 採用voterのInclude票が必要票数以上の文献
 *   - ルール未設定:
 *     - 管理者: 読み込まれている全レビュアーの TiAb Include が1件でもある文献
 *     - 非管理者: 自分が TiAb で Include した文献
 */
function recomputeCandidates(): void {
    const byRef = new Map<string, Decision[]>();
    for (const d of allDecisions) {
        const list = byRef.get(d.ref_id);
        if (list) {
            list.push(d);
        } else {
            byRef.set(d.ref_id, [d]);
        }
    }

    fulltextCandidates = allRefs.filter(r => isFulltextCandidateRef({
        ref: r,
        decisions: byRef.get(r.ref_id) ?? [],
        poolRule,
        assignment: ftAssignment,
        userEmail,
        isAdmin,
    }));

    // 担当割り振り設定済みなら自分の担当分（+未割り当て）へ絞り込む。管理者は全候補。
    fulltextCandidates = fulltextCandidates.filter(r =>
        canSeeFulltextRef(r, ftAssignment, userEmail, isAdmin)
    );
    candidateCountBeforeSetFilter = fulltextCandidates.length;

    // サイドパネルの担当セットフィルタ選択（チェックボックス絞り込み）を反映する
    fulltextCandidates = fulltextCandidates.filter(r =>
        matchesSelectedFulltextSets(r, ftAssignment, selectedFulltextSets)
    );

    currentCandidateIndex = currentRef
        ? fulltextCandidates.findIndex(r => r.ref_id === currentRef!.ref_id)
        : -1;
}

// ---------------------------------------------------------------------------
// 決断パネル
// ---------------------------------------------------------------------------

function renderDecisionPanel(): void {
    // AI判定サマリ（あれば）を提示。人間の判定は別票のためプリフィルはしない。
    renderAiSummary();
    // 現在の決断状態をボタンに反映
    updateDecisionButtons();
    // 除外理由エリアの表示制御
    updateReasonArea();
    // 保存ボタンの表示
    updateSaveButton();
}

const EXCLUDE_REASON_LABELS: Record<string, string> = {
    population: 'Population 不適合',
    intervention: 'Intervention 不適合',
    comparator: 'Comparator 不適合',
    outcome: 'Outcome 不適合',
    study_design: 'Study design 不適合',
    duplicate: '重複',
    other: 'その他',
};

const AI_DECISION_LABELS: Record<string, string> = {
    include: '組み入れ',
    exclude: '除外',
    maybe: '保留',
};

/**
 * AI判定の開示トグル（管理者のみ）。
 * AI判定はブラインド情報なので、非管理者には出さず、管理者にだけ表示/非表示ボタンを出す。
 */
function setupAiRevealToggle(): void {
    if (!isAdmin) return;
    const title = document.querySelector('.ft-annotations-panel .ft-panel-title');
    if (!title || document.getElementById('ft-ai-reveal-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ft-ai-reveal-btn';
    btn.className = 'ft-ai-reveal-btn';
    btn.addEventListener('click', () => {
        aiReveal = !aiReveal;
        syncAiRevealButton();
        renderAiSummary();
        // 開示状態で evidence の表示レベル（色分け・polarityラベル）も変わるため再描画する
        refreshEvidenceDisplay();
    });
    title.appendChild(btn);
    syncAiRevealButton();
}

function syncAiRevealButton(): void {
    const btn = document.getElementById('ft-ai-reveal-btn');
    if (!btn) return;
    btn.textContent = aiReveal ? 'AI判断: 表示中' : 'AI判断: 非表示';
    btn.title = 'AIの組入/除外の判断とその理由の表示を切り替えます（管理者のみ）';
    btn.classList.toggle('active', aiReveal);
}

/**
 * AIフルテキスト判定のサマリを決断パネル上部に表示する。
 * 人間レビュアーが「AIが何をどう判定したか」を一目で確認できるようにする（票自体は別管理）。
 * ブラインド情報のため、開示が許可（aiReveal）されている時のみ表示する。
 */
function renderAiSummary(): void {
    const panel = document.querySelector('.ft-decision-panel');
    if (!panel) return;
    let banner = document.getElementById('ft-ai-summary');

    const ai = aiReveal && currentRef ? findAiFulltext(currentRef.ref_id) : null;
    if (!ai) {
        banner?.remove();
        return;
    }
    const { decision, note } = ai;

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ft-ai-summary';
        banner.className = 'ft-ai-summary';
        const title = panel.querySelector('.ft-panel-title');
        if (title) title.insertAdjacentElement('afterend', banner);
        else panel.prepend(banner);
    }

    const decLabel = AI_DECISION_LABELS[decision.decision] ?? decision.decision;
    const pct = Math.round((note.include_probability ?? 0) * 100);
    const reasonCat = note.exclude_reason_category
        ? `（${EXCLUDE_REASON_LABELS[note.exclude_reason_category] ?? note.exclude_reason_category}）`
        : '';

    banner.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ft-ai-summary-head';
    head.textContent = `AI判定: ${decLabel}${reasonCat} ・ 組入確率 ${pct}%`;
    // 数字＋小バーの併記で、maybe（50%前後）と高確信判定を一目で区別できるようにする
    const bar = document.createElement('span');
    bar.className = 'ft-ai-prob-bar';
    bar.title = `組入確率 ${pct}%`;
    const fill = document.createElement('span');
    fill.className = 'ft-ai-prob-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    head.appendChild(bar);
    banner.appendChild(head);

    if (note.reason) {
        const reason = document.createElement('div');
        reason.className = 'ft-ai-summary-reason';
        reason.textContent = note.reason;
        banner.appendChild(reason);
    }
}

function wireDecisionButtons(): void {
    document.getElementById('ft-btn-include')?.addEventListener('click', () => { void chooseDecision('include'); });
    document.getElementById('ft-btn-exclude')?.addEventListener('click', () => { void chooseDecision('exclude'); });
    document.getElementById('ft-btn-maybe')?.addEventListener('click', () => { void chooseDecision('maybe'); });
    document.getElementById('ft-save-btn')?.addEventListener('click', () => { void handleSave(); });

    // 除外理由の確定はモダリティで挙動を分ける：
    // - クリック（ポインタ）で選択: 確定とみなし、保存して次の候補へ進む
    // - ↑↓キーでのブラウズ: その場で保存のみ（Enter/数字キーで次へ）
    // 新規除外は理由が選ばれてから初めて保存する。
    const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    reasonSelect?.addEventListener('change', () => {
        if (pendingDecision !== 'exclude') return;
        if (reasonPointerDown) {
            // クリック選択。確定処理（保存＋次へ）は pointerup 側で行う
            reasonChangedByPointer = true;
            return;
        }
        void handleSave();
    });
    reasonSelect?.addEventListener('pointerdown', () => {
        reasonPointerDown = true;
        reasonChangedByPointer = false;
    });
    // select の外で離した場合も拾えるよう window で監視する
    window.addEventListener('pointerup', (e) => {
        if (!reasonPointerDown) return;
        reasonPointerDown = false;
        if (pendingDecision !== 'exclude' || !reasonSelect?.value) return;
        if (e.target instanceof Node && reasonSelect.contains(e.target)) {
            // select 上で離した＝クリック確定。保存して次の候補へ。
            // 選択済みの理由をもう一度クリックした場合も確定として扱う。
            void commitReasonAndAdvance();
        } else if (reasonChangedByPointer) {
            // select の外で離した（クリック取り消し）。選択表示は変わっているため
            // 保存だけ行い、次へは進まない。
            void handleSave();
        }
    });
    window.addEventListener('pointercancel', () => {
        if (!reasonPointerDown) return;
        reasonPointerDown = false;
        if (pendingDecision === 'exclude' && reasonChangedByPointer && reasonSelect?.value) {
            void handleSave();
        }
    });
    // メモの変更は、その場で再保存する（自動送りはしない）。
    document.getElementById('ft-reason-note')?.addEventListener('change', () => {
        if (pendingDecision === 'exclude') {
            const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
            if (select?.value) void handleSave();
        } else if (pendingDecision) {
            void handleSave();
        }
    });

    // メモ欄で Enter（改行は Shift+Enter）: メモ込みで保存して次の候補へ。
    // 保留メモの「任意入力 → Enter で次へ」フローに使う（除外でも同様に効く）。
    document.getElementById('ft-reason-note')?.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void commitNoteAndAdvance();
        } else if (e.key === 'Escape') {
            (e.target as HTMLElement).blur();
            e.preventDefault();
        }
    });
}

/** メモ欄の Enter 確定: 保存して次の候補へ（除外は理由未選択なら保存しない） */
async function commitNoteAndAdvance(): Promise<void> {
    if (!pendingDecision) return;
    if (pendingDecision === 'exclude') {
        const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        if (!select?.value) {
            showFeedback('除外理由を選択してください', true);
            focusReasonSelect();
            return;
        }
    }
    const saved = await handleSave();
    if (saved) advanceToNext();
}

/**
 * 判定を選択して即保存する（TiAbレビューと同じ即保存挙動）。
 * - 組み入れ: 保存してそのまま次の候補へ進む
 * - 除外: 理由エリアを表示・フォーカスし、理由が確定（クリック/数字キー/Enter）したら次へ進む
 * - 保留: 即保存しつつメモ欄（任意）を表示。第2レビュアー・adjudication で
 *   「何が判断できなかったか」を共有できるようにする。Enter で次へ進む。
 */
async function chooseDecision(decision: 'include' | 'exclude' | 'maybe'): Promise<void> {
    pendingDecision = decision;
    renderDecisionPanel();

    if (decision === 'exclude') {
        focusReasonSelect();     // キーボードで理由を選べるようフォーカス
        showFeedback('除外理由を選択すると保存して次の候補へ進みます');
        return;                  // 理由確定で保存して advanceToNext する
    }

    if (decision === 'maybe') {
        const saved = await handleSave();
        if (saved) {
            showFeedback('保存しました。判断できなかった点をメモできます（Enterで次へ）');
            focusReasonNote();
        }
        return;                  // Enter（またはボタン/キーで次へ）で advanceToNext する
    }

    const saved = await handleSave();
    if (saved) advanceToNext();   // 組み入れは保存できたら次の候補へ
}

/** 次の候補へ進む（末尾なら留まって通知）。判定後の自動送りに使う。 */
function advanceToNext(): void {
    if (currentCandidateIndex < 0) return;
    // 全候補が判定済みになったら、完了を通知してタブを閉じ元の画面へ戻る。
    // 判定アクション後にしか通らないので、全件判定済みの状態で
    // 開き直しただけでは発火しない（見直しはできる）。
    if (fulltextCandidates.length > 0 && fulltextCandidates.every(r => isDecided(r.ref_id))) {
        startAutoClose();
        return;
    }
    if (currentCandidateIndex >= fulltextCandidates.length - 1) {
        showFeedback('最後の候補です');
        return;
    }
    void loadRef(fulltextCandidates[currentCandidateIndex + 1].ref_id);
}

/** 除外理由 select にフォーカスを移す（表示中のときだけ） */
function focusReasonSelect(): void {
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const area = document.getElementById('ft-reason-area');
    if (select && area && !area.classList.contains('hidden')) {
        select.focus();
    }
}

/** メモ欄（textarea）にフォーカスを移す（表示中のときだけ）。保留メモの入力導線。 */
function focusReasonNote(): void {
    const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
    const area = document.getElementById('ft-reason-area');
    if (note && area && !area.classList.contains('hidden')) {
        note.focus();
    }
}

/** 数字キー（1〜7）で除外理由を選び、保存して次へ進む */
function selectReasonByIndex(n: number): void {
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const value = REASON_VALUES[n - 1];
    if (!select || value === undefined) return;
    select.value = value;
    void commitReasonAndAdvance();
}

/** 除外理由を確定して保存し、次の候補へ進む */
async function commitReasonAndAdvance(): Promise<void> {
    if (pendingDecision !== 'exclude') return;
    const saved = await handleSave();
    if (saved) advanceToNext();
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
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
    const selectLabel = area.querySelector('.ft-reason-label') as HTMLElement | null;
    const hint = area.querySelector('.ft-reason-hint') as HTMLElement | null;

    // メモ欄は非表示中でも handleSave が値を参照するため、判定種によらず
    // 「同じ判定種の既存メモ」を復元し、それ以外はクリアする。
    // （旧実装は exclude 以外で復元もクリアもせず、include/maybe＋note の既存判定を
    //   開いてもメモが見えない・前の文献のメモが残って保存される問題があった）
    if (note) {
        note.value = pendingDecision && existingDecision?.decision.decision === pendingDecision
            ? existingDecision.decision.note ?? ''
            : '';
    }

    if (pendingDecision === 'exclude' || pendingDecision === 'maybe') {
        area.classList.remove('hidden');
        const excludeMode = pendingDecision === 'exclude';
        // 保留（maybe）ではPRISMA理由の選択は不要。メモ欄のみ出す。
        selectLabel?.classList.toggle('hidden', !excludeMode);
        select?.classList.toggle('hidden', !excludeMode);
        hint?.classList.toggle('hidden', !excludeMode);
        if (note) {
            note.placeholder = excludeMode
                ? '補足メモ（任意）'
                : '判断できなかった点のメモ（任意・Enterで次へ）';
        }
        // 既存の除外理由を復元
        if (select) {
            if (excludeMode && existingDecision?.decision.decision === 'exclude' && existingDecision.decision.reason) {
                select.value = existingDecision.decision.reason;
            } else {
                select.selectedIndex = -1;
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

async function handleSave(): Promise<boolean> {
    if (!currentRef || !pendingDecision) return false;

    const saveBtn = document.getElementById('ft-save-btn') as HTMLButtonElement | null;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        const reasonNote = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
        const reason = reasonSelect?.value || '';

        if (pendingDecision === 'exclude' && !reason) {
            showFeedback('除外理由を選択してください', true);
            focusReasonSelect();
            return false;
        }

        // decision_id は判定イベントごとに毎回新規発番する（Decisionsタブが追記専用になったため、
        // 既存判定のIDを使い回すと判定変更の履歴が別イベントとして残らなくなる）
        const decisionObj: Decision = {
            decision_id: crypto.randomUUID(),
            ref_id: currentRef.ref_id,
            reviewer_id: userEmail,
            decision: pendingDecision,
            reason: pendingDecision === 'exclude' ? reason : undefined,
            note: reasonNote?.value || undefined,
            decided_at: new Date().toISOString(),
            client_version: getClientVersion('-human'),
            source_url: window.location.href,
            screening_phase: 'fulltext',
        };

        // 送信前にメモリ状態を確定させる。decision_id は追記専用化により毎回新規発番されるため、
        // (ref_id, reviewer_id, screening_phase) が一致する既存要素を探して置換することで、
        // メモリ上の allDecisions に同一判定の重複が積まれるのを防ぐ。
        if (existingDecision) {
            existingDecision.decision = decisionObj;
        } else {
            existingDecision = { decision: decisionObj, rowIndex: -1 };
        }
        const idx = allDecisions.findIndex(d =>
            d.ref_id === decisionObj.ref_id &&
            d.reviewer_id === decisionObj.reviewer_id &&
            (d.screening_phase ?? 'tiab') === (decisionObj.screening_phase ?? 'tiab')
        );
        if (idx >= 0) allDecisions[idx] = decisionObj;
        else allDecisions.push(decisionObj);
        renderOverallProgress();

        await saveDecision(spreadsheetId, decisionObj);

        // サイドパネルのチーム進捗パネルへ即時反映を通知
        // （サイドパネルが閉じていて受信側がいなくてもエラーにしない）
        platform().emitMessage({ type: 'team-progress:decision-saved', spreadsheetId, decision: decisionObj });

        showFeedback('保存しました');
        return true;
    } catch (err) {
        showFeedback(`保存失敗: ${(err as Error).message}`, true);
        return false;
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
    document.getElementById('ft-next-undecided-btn')?.addEventListener('click', () => jumpToNextUndecided());
    document.getElementById('ft-close-btn')?.addEventListener('click', () => closeTab());
}

/** このタブを閉じて元の画面に戻る。chrome.tabs.create で開かれたタブは
 *  window.close() が効かないことがあるため chrome.tabs API を優先する。 */
function closeTab(): void {
    chrome.tabs.getCurrent(tab => {
        if (tab?.id !== undefined) {
            chrome.tabs.remove(tab.id);
        } else {
            window.close();
        }
    });
}

let autoCloseTimer: number | undefined;

/**
 * 全件判定完了を通知し、少し待ってからタブを閉じる。
 * 猶予中にキー入力・クリックがあれば自動クローズをキャンセルする
 * （直前の判定を見直したい場合の逃げ道）。
 */
function startAutoClose(): void {
    if (autoCloseTimer !== undefined) return;
    showFeedback('全件の判定が完了しました 🎉 まもなくタブを閉じます（操作でキャンセル）');
    const ac = new AbortController();
    const cancel = (): void => {
        ac.abort();
        if (autoCloseTimer === undefined) return;
        clearTimeout(autoCloseTimer);
        autoCloseTimer = undefined;
        showFeedback('自動クローズをキャンセルしました');
    };
    window.addEventListener('keydown', cancel, { capture: true, signal: ac.signal });
    window.addEventListener('pointerdown', cancel, { capture: true, signal: ac.signal });
    autoCloseTimer = window.setTimeout(() => closeTab(), 2000);
}

function navigate(delta: number): void {
    if (fulltextCandidates.length === 0) return;
    const len = fulltextCandidates.length;
    const newIndex = (currentCandidateIndex + delta + len) % len;
    const nextRef = fulltextCandidates[newIndex];
    if (nextRef) void loadRef(nextRef.ref_id);
}

/**
 * 次の未判定候補へジャンプする（u キー＋ボタン）。
 * 現在位置から末尾方向へ探し、末尾まで無ければ先頭へ折り返す。
 * 中断後の再開や、飛ばした文献の拾い直しを高速化する。
 */
function jumpToNextUndecided(): void {
    const len = fulltextCandidates.length;
    if (len === 0) return;
    const start = currentCandidateIndex >= 0 ? currentCandidateIndex : -1;
    for (let d = 1; d <= len; d++) {
        const ref = fulltextCandidates[(start + d + len) % len];
        if (ref && ref.ref_id !== currentRef?.ref_id && !isDecided(ref.ref_id)) {
            void loadRef(ref.ref_id);
            return;
        }
    }
    showFeedback('未判定の候補はありません');
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

async function handleResolve(token?: number): Promise<void> {
    if (!currentRef) return;
    const ref = currentRef; // 取得中に遷移しても結果は元の文献へ反映する

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
            ref, userEmail,
            // ensureFulltextFolder の fail-fast エラーは通知だけして再送出する。
            // retrieveAndCacheFulltext 側は従来どおり linked へフォールバックするため分岐は変えない。
            async () => {
                try {
                    return await ensureFulltextFolder(spreadsheetId);
                } catch (err) {
                    const knownMessage = describeDriveAccessError(err);
                    if (knownMessage) showFeedback(knownMessage, true);
                    throw err;
                }
            }
        );

        if (outcome.kind === 'cached') {
            ref.fulltext_url = outcome.url;
            ref.fulltext_status = 'cached';
            updateReferenceFulltextUrl(spreadsheetId, ref.ref_id, outcome.url, 'cached')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
            if (!stale()) { await showCachedPdf(outcome.url, token); updateToolbarMode(); }
        } else if (outcome.kind === 'linked') {
            ref.fulltext_url = outcome.url;
            ref.fulltext_status = 'retrieved';
            updateReferenceFulltextUrl(spreadsheetId, ref.ref_id, outcome.url, 'retrieved')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
            if (!stale()) showResolvedUrl(outcome.url, outcome.source);
        } else {
            // OA全文は無い → 論文ページ（出版社/PubMed）を枠内に埋め込み表示
            ref.fulltext_status = 'unavailable';
            updateReferenceFulltextUrl(spreadsheetId, ref.ref_id, '', 'unavailable')
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
async function openLinkedInline(url: string, source: OaSource | 'cached' | 'linked'): Promise<void> {
    if (!currentRef) return;

    showPlaceholder('PDFを取得中...');
    // クリック（ユーザージェスチャ）起点。リダイレクト先（任意ホスト）のヘッダー除去と
    // PDF取得を行うため、ここで全サイト権限ダイアログを出せる。
    await requestBroadHostPermission();

    // 1. バイト取得 → Drive 自動保存
    const blob = await fetchLinkedPdfBlob(url);
    if (blob) {
        try {
            const folderId = await ensureFulltextFolder(spreadsheetId);
            const info = await uploadPdfToDrive(folderId, buildPdfFileName(currentRef), blob);
            await updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, info.webViewLink, 'cached');
            currentRef.fulltext_url = info.webViewLink;
            currentRef.fulltext_status = 'cached';
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

// ---------------------------------------------------------------------------
// リンクのみPDFの手動保存（自動保存に失敗した時の導線）
// ---------------------------------------------------------------------------

function wireSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.addEventListener('click', () => {
        const input = document.getElementById('ft-upload-input') as HTMLInputElement | null;
        if (input) {
            input.value = '';
            input.click();
        }
    });
}

function showSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.classList.remove('hidden');
}

function hideSavePdfButton(): void {
    document.getElementById('ft-save-pdf-btn')?.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// PDF 差し替え（誤ったPDFの削除 + 再アップロード）
// ---------------------------------------------------------------------------

function wireReplaceButtons(): void {
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
        showPlaceholder('PDFを削除しました。\n上の「⬆ PDFをアップロード」から再取得してください。');
        updateToolbarMode();
    } catch (err) {
        window.alert(`削除に失敗しました: ${(err as Error).message}`);
    } finally {
        if (delBtn) { delBtn.disabled = false; delBtn.textContent = 'PDFを削除'; }
    }
}

// アップロード中の二重実行ガード（ボタン連打・ドロップ重複対策）
let uploadInProgress = false;

/**
 * ローカルのPDFファイルをDriveへアップロードして表示する。
 * ファイル選択（差し替え/⬆アップロード）とドラッグ&ドロップの共通経路。
 */
async function uploadPdfFile(file: File): Promise<void> {
    if (!currentRef || uploadInProgress) return;

    // マジックナンバーでPDF検証
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (!String.fromCharCode(...head).startsWith('%PDF')) {
        window.alert('PDFファイルではないようです。.pdf ファイルを選択してください。');
        return;
    }

    uploadInProgress = true;
    const ref = currentRef; // アップロード中に遷移しても結果は元の文献へ反映する
    showPlaceholder('Drive へPDFをアップロード中...');
    try {
        const folderId = await ensureFulltextFolder(spreadsheetId);
        const info = await uploadPdfToDrive(folderId, buildPdfFileName(ref), file);
        await updateReferenceFulltextUrl(spreadsheetId, ref.ref_id, info.webViewLink, 'cached');
        ref.fulltext_url = info.webViewLink;
        ref.fulltext_status = 'cached';
        // アップロード中に別文献へ移っていたら描画はせず、状態更新のみ
        if (ref === currentRef) {
            await showCachedPdf(info.webViewLink);
            updateToolbarMode();
            showFeedback('PDFをDriveに保存しました');
        }
    } catch (err) {
        if (ref === currentRef) {
            const knownMessage = describeDriveAccessError(err);
            showPlaceholder(knownMessage ?? `アップロードに失敗しました: ${(err as Error).message}`);
        }
    } finally {
        uploadInProgress = false;
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

/**
 * PDF上のハイライトオーバーレイの表示をトグル状態に同期する。
 * 根拠カード一覧は制御しない（原文を読みたくてオーバーレイをOFFにしても、
 * カードから文脈を辿れるよう常に残す）。
 */
function applyHighlightVisibility(): void {
    // PDF.js 描画中はレンダラ側のハイライトレイヤーをまとめて制御する
    pdfRenderer?.setHighlightsVisible(highlightEnabled);
    document.querySelectorAll('.ft-highlight').forEach(el => {
        (el as HTMLElement).style.display = highlightEnabled ? '' : 'none';
    });
}

// ---------------------------------------------------------------------------
// キーボードショートカット（TiAbレビューと同一割り当て）
// ---------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
    // 除外理由 select にフォーカスがある時は専用処理（数字で確定・↑↓でネイティブ移動・Enterで次へ）
    const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    if (reasonSelect && e.target === reasonSelect) {
        handleReasonKeydown(e, reasonSelect);
        return;
    }

    // その他の入力フォーム内では無効
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement) {
        return;
    }
    // 修飾キー併用時は無効
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    // 除外モード中は（selectからフォーカスが外れていても）数字キーで理由を選べる
    if (pendingDecision === 'exclude' && /^[1-7]$/.test(e.key)) {
        selectReasonByIndex(Number(e.key));
        e.preventDefault();
        return;
    }

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
        case 'u': // 次の未判定候補へ
            jumpToNextUndecided();
            e.preventDefault();
            break;
        case 'n': // 次の evidence へ（カード強調＋PDFスクロール連動）
            jumpToEvidence(1);
            e.preventDefault();
            break;
        case 'p': // 前の evidence へ
            jumpToEvidence(-1);
            e.preventDefault();
            break;
    }
}

/**
 * 除外理由 select にフォーカスがある時のキー処理。
 * - 数字 1〜7: その理由を選んで保存し、次の候補へ
 * - ↑↓: ネイティブの select で理由を上下移動（change で随時保存。まだ次へは進まない）
 * - Enter: 選択中の理由を確定して次の候補へ
 * - Escape: select からフォーカスを外す
 */
function handleReasonKeydown(e: KeyboardEvent, select: HTMLSelectElement): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[1-7]$/.test(e.key)) {
        selectReasonByIndex(Number(e.key));
        e.preventDefault();
        return;
    }
    if (e.key === 'Enter') {
        if (select.value) void commitReasonAndAdvance();
        e.preventDefault();
        return;
    }
    if (e.key === 'Escape') {
        select.blur();
        e.preventDefault();
    }
    // ArrowUp / ArrowDown はネイティブ select に委ねる（change ハンドラで保存される）
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

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
    idsEl.replaceChildren();
    if (ref.doi) {
        const link = document.createElement('a');
        link.href = `https://doi.org/${encodeURIComponent(ref.doi)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `DOI: ${ref.doi}`;
        idsEl.appendChild(link);
    }
    if (ref.pmid) {
        const link = document.createElement('a');
        link.href = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `PMID: ${ref.pmid}`;
        idsEl.appendChild(link);
    }
    idsEl.classList.toggle('hidden', idsEl.children.length === 0);

    bar.classList.remove('hidden');
}

/** 現在のユーザーによるこの文献のTiAb判定（最新）を返す */
function findMyTiabDecision(refId: string): Decision | null {
    const mine = allDecisions
        .filter(d => d.ref_id === refId && d.reviewer_id === userEmail && isTiabDecision(d))
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));
    return mine[0] ?? null;
}

/**
 * 右ペインの「抄録・自分のTiAb判定」折りたたみを描画する。
 * 表示中PDFと抄録の突き合わせ（取り違え確認）と、
 * TiAb時に何を根拠に通したかの文脈想起を助ける。開閉状態は文献をまたいで維持する。
 */
function renderContextPanel(ref: Reference): void {
    const body = document.getElementById('ft-context-body');
    if (!body) return;
    body.replaceChildren();

    const tiab = findMyTiabDecision(ref.ref_id);
    const tiabRow = document.createElement('div');
    tiabRow.className = 'ft-context-tiab';
    if (tiab) {
        tiabRow.dataset.decision = tiab.decision;
        const parts = [`自分のTiAb判定: ${AI_DECISION_LABELS[tiab.decision] ?? tiab.decision}`];
        if (tiab.reason) parts.push(EXCLUDE_REASON_LABELS[tiab.reason] ?? tiab.reason);
        if (tiab.note) parts.push(tiab.note);
        tiabRow.textContent = parts.join(' · ');
    } else {
        tiabRow.textContent = '自分のTiAb判定: なし';
    }
    body.appendChild(tiabRow);

    const abs = document.createElement('div');
    abs.className = 'ft-context-abstract';
    abs.textContent = ref.abstract || '（抄録なし）';
    body.appendChild(abs);
}

function renderProgress(): void {
    const el = document.getElementById('ft-progress');
    if (!el) return;
    if (fulltextCandidates.length === 0) {
        el.textContent = describeEmptyCandidatesReason();
        return;
    }
    if (currentCandidateIndex === -1) {
        // この文献は現在の候補条件に含まれていない（判定・保存は可能）
        el.textContent = `候補外（候補 ${fulltextCandidates.length}件）`;
        return;
    }
    el.textContent = `${currentCandidateIndex + 1} / ${fulltextCandidates.length}`;
}

/**
 * 候補0件の理由に応じたメッセージを返す（サイドパネルの空状態と同じ判定関数を使う）。
 * Blind中に他レビュアーの人間票が読み込まれず候補ルールが評価できない場合、
 * 従来は無表示で「まだTiAbが終わっていない」と誤認させていた（実際に混乱が起きた）。
 * このウィンドウにはBlind解除ボタンを置く導線が無いため、管理者にはサイドパネルへの誘導文言を出す。
 */
function describeEmptyCandidatesReason(): string {
    const assignedSetCount = allRefs.filter(r => (r.fulltext_set || '').trim() !== '').length;
    const reason = explainEmptyFulltextCandidates({
        poolRule,
        keyOpened,
        userEmail,
        assignedSetCount,
        candidateCountBeforeSetFilter,
        visibleCandidateCount: fulltextCandidates.length,
    });
    switch (reason) {
        case 'rule_unevaluable_blind':
            return isAdmin
                ? t('fulltext_emptyBlindUnevaluableFulltextWindow')
                : t('fulltext_emptyBlindUnevaluable');
        case 'assignment_mismatch':
            return t('fulltext_emptyAssignmentMismatch', String(assignedSetCount));
        case 'filtered_out':
            return t('fulltext_emptyFilteredOut');
        default:
            // 従来どおり: 本当に候補が無いだけの場合はヘッダーに何も出さない
            return '';
    }
}

/** 候補プール全体で自分の判定がどれだけ終わったかを表示する */
function renderOverallProgress(): void {
    const text = document.getElementById('ft-overall-text');
    const fill = document.getElementById('ft-overall-fill');
    if (!text && !fill) return;
    const total = fulltextCandidates.length;
    const decided = fulltextCandidates.filter(r => isDecided(r.ref_id)).length;
    const pct = total > 0 ? Math.round((decided / total) * 100) : 0;
    if (text) text.textContent = total > 0 ? `判定済 ${decided}/${total} (${pct}%)` : '';
    if (fill) fill.style.width = `${pct}%`;
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
    hideCanvasContainer();
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

function appendTextWithBreaks(parent: HTMLElement, text: string): void {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
        if (idx > 0) parent.appendChild(document.createElement('br'));
        parent.appendChild(document.createTextNode(line));
    });
}

function isSafeLinkUrl(url: string): boolean {
    try {
        const parsed = new URL(url, window.location.href);
        return ['https:', 'http:', 'blob:', 'chrome-extension:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

function buildExternalAnchor(url: string, label: string, className?: string): HTMLAnchorElement {
    const anchor = document.createElement('a');
    anchor.textContent = label;
    if (className) anchor.className = className;
    if (isSafeLinkUrl(url)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.href = url;
    } else {
        anchor.removeAttribute('href');
        anchor.title = '安全でないURL形式のためリンクを無効化しました';
    }
    return anchor;
}

function renderUrlLabel(label: HTMLElement, sourceLabel: string, url: string): void {
    const badge = document.createElement('span');
    badge.className = 'ft-source-badge';
    badge.textContent = sourceLabel;

    const link = buildExternalAnchor(url, url);
    label.replaceChildren(badge, link);
}

function setUrlLabel(url: string, source: OaSource | 'cached' | 'linked'): void {
    const label = document.getElementById('ft-pdf-url-label');
    if (!label) return;
    const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
    renderUrlLabel(label, sourceLabel, url);
}

/**
 * Drive保存済みPDFを左ペインに表示する。
 * 1. Drive API (alt=media) でPDFバイトを取得し blob URL を内蔵ビュワーで表示
 * 2. drive.file スコープ外（他レビュアーが保存したファイル等）で取得できない場合は
 *    Drive のプレビュー埋め込み (/preview) にフォールバック
 * 3. Drive 以外のURL（タブアタッチで手入力した直リンク等）は従来のリンク表示
 */
async function showCachedPdf(url: string, token?: number): Promise<void> {
    const fileId = extractDriveFileId(url);
    if (!fileId) {
        showResolvedUrl(url, 'cached');
        return;
    }

    showPlaceholder('Drive から PDF を読み込み中...');
    setUrlLabel(url, 'cached');

    // 先読み済みなら即利用。無ければその場で取得。
    const refId = currentRef?.ref_id;
    const prefetched = refId ? pdfPrefetch.get(refId) : undefined;

    let blob: Blob | null = null;
    try {
        blob = prefetched ? await prefetched : await downloadDriveFile(fileId);
        if (!blob && prefetched) blob = await downloadDriveFile(fileId); // 先読みが失敗していた場合の再取得
    } catch (err) {
        if (token !== undefined && isStale(token)) return;
        console.warn('[fulltext] Drive APIでのPDF取得に失敗、プレビュー埋め込みへフォールバック:', err);
        showPdfFrame(`https://drive.google.com/file/d/${fileId}/preview`);
        setUrlLabel(url, 'cached');
        return;
    }

    // 取得中に別の文献へ移っていたら描画しない（取り違え防止）
    if (token !== undefined && isStale(token)) return;

    if (!blob) {
        showPdfFrame(`https://drive.google.com/file/d/${fileId}/preview`);
        setUrlLabel(url, 'cached');
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
        currentPdfObjectUrl = URL.createObjectURL(blob);
        showPdfFrame(currentPdfObjectUrl);
        setUrlLabel(url, 'cached');
    }
}

// ---------------------------------------------------------------------------
// PDF.js 描画（cached PDF。テキストレイヤー + ハイライト対応）
// ---------------------------------------------------------------------------

/** PDF.js レンダラを取得（初回生成） */
function getPdfRenderer(): PdfRenderer {
    if (!pdfRenderer) {
        const container = document.getElementById('ft-pdf-canvas-container');
        if (!container) throw new Error('PDF描画コンテナが見つかりません');
        pdfRenderer = new PdfRenderer(container);
        // PDF上のハイライトクリック → 右ペインの該当カードへスクロール＆強調
        pdfRenderer.onHighlightClick = id => focusAnnotationCard(id);
    }
    return pdfRenderer;
}

/** PDF.js 描画コンテナを隠し、描画リソースを解放する（PDF以外を表示する時に呼ぶ） */
function hideCanvasContainer(): void {
    const container = document.getElementById('ft-pdf-canvas-container');
    if (container) container.classList.add('hidden');
    if (pdfRenderer) pdfRenderer.destroy();
    currentPdfInfo = null;
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
    currentPdfInfo = await renderer.loadPdf(buf);
    // loadPdf 自体が新しい描画で前の描画を上書きするため、stale でも destroy は不要。
    if (token !== undefined && isStale(token)) return;

    renderer.setHighlightsVisible(highlightEnabled);
    // Phase 2/3: ここで AI evidence / 既存アノテーションのハイライトを適用する
    applyHighlightsForCurrentRef();
}

/**
 * 現在表示中PDFに対し、AIフルテキスト判定の evidence をハイライト描画し、
 * 右ペインのアノテーション一覧を再構築する。
 *
 * - 経路A（quote文字列マッチ）→ 経路B（bbox）の順で renderer が解決を試みる。
 * - どちらも解決できなかった evidence は「位置不明」として一覧に出し、
 *   クリックでページ送りのみ行う（縮退フォールバック）。
 */
/**
 * AI evidence ハイライト（canvas）と根拠カード一覧（右ペイン）を空にする。
 * 文献遷移のたびに呼び、前の文献のハイライトが残らないようにする。
 * AI判定のある cached PDF では、この後 applyHighlightsForCurrentRef が再構築する。
 */
function clearAiHighlights(): void {
    pdfRenderer?.clearHighlights();
    // 空文言は文献に依存しない（ラウンドの状態のみで決まる）ため、
    // ここでも理由別メッセージを出しておき、遷移時に既定文言が一瞬見える状態を作らない
    renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
}

/**
 * 根拠一覧の空メッセージ（理由別）。
 * 'blinded'（表示レベル none）は、採用ラウンドの有無等で文言を変えると
 * 「AI判定が存在するか」が推測できてしまうため 'no_evidence' と同一文言に固定する。
 * Config の生キー名は出さず、UIから辿れる導線（サイドパネルのAI判定タブ）を案内する。
 */
const AI_EVIDENCE_EMPTY_MESSAGES: Record<AiEvidenceEmptyReason, string> = {
    blinded: 'このPDFのAI判定根拠はまだありません。',
    no_round:
        'フルテキストAI判定はまだ実行されていません。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」から一括AI判定を実行すると、ここに根拠ハイライトが表示されます'
        + '（TiAbのAI判定とは別枠です）。',
    round_not_adopted:
        'フルテキストAI判定はありますが、採用するラウンドが選ばれていません。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」→「判定ラウンド」で選択してください。',
    adopted_round_missing:
        '採用中のAI判定ラウンドの判定が見つかりません（削除された可能性があります）。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」→「判定ラウンド」で選び直してください。',
    no_evidence: 'このPDFのAI判定根拠はまだありません。',
};

/** 状態に応じた根拠一覧の空メッセージ */
function evidenceEmptyMessage(): string {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: effectiveEvidenceLevel(),
        hasAnyFulltextAiDecision: allDecisions.some(isFulltextAiDecision),
        hasAdoptedRoundDecision: !!aiActiveRound
            && allDecisions.some(d => isFulltextAiDecision(d) && d.reviewer_id === aiActiveRound),
        activeRound: aiActiveRound,
    });
    return AI_EVIDENCE_EMPTY_MESSAGES[reason];
}

/** フルテキストフェーズのAI判定（reviewer_id が `llm:`）か */
function isFulltextAiDecision(d: Decision): boolean {
    return (d.screening_phase ?? 'tiab') === 'fulltext' && (d.reviewer_id || '').startsWith('llm:');
}

/**
 * 現在の表示経路に応じて AI evidence 表示を再構築する。
 * PDF.js 描画中はハイライト＋カード、それ以外（iframe埋め込み等）はカードのみ。
 * 開示トグルや表示レベル変更時の再描画に使う。
 */
function refreshEvidenceDisplay(): void {
    if (currentPdfInfo) {
        applyHighlightsForCurrentRef();
    } else {
        renderAiCardsFallback();
    }
}

/**
 * PDF.js 以外の表示経路（Driveプレビュー埋め込み・Chrome内蔵ビュワー・
 * 論文ページ埋め込み・リンクのみ表示）でも根拠カード一覧は表示する。
 * 矩形ハイライトは描けないため、カードは quote＋AIの申告ページ番号のみで
 * クリックでのスクロールは無効にする。
 */
function renderAiCardsFallback(): void {
    if (!currentRef) return;

    const level = effectiveEvidenceLevel();
    if (level === 'none') {
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const note = findAiFulltextNote(currentRef.ref_id);
    if (!note || !Array.isArray(note.evidence) || note.evidence.length === 0) {
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const items: HighlightListItem[] = note.evidence.map((ev, idx) => ({
        id: `ai-ev-${idx}`,
        category: (level !== 'full' ? 'ai_evidence'
            : ev.polarity === 'exclude' ? 'exclude_evidence' : 'include_evidence') as HighlightCategory,
        quote: ev.quote,
        page: ev.page,
        resolved: false,
        via: 'none' as const,
    }));

    renderAnnotationsList(items, note.image_only ?? false, {
        clickable: false,
        notice: 'この表示モードではPDF上のハイライト表示はできません（根拠一覧のみ）。',
    });
}

function applyHighlightsForCurrentRef(): void {
    if (!pdfRenderer || !currentRef || !currentPdfInfo) return;
    pdfRenderer.clearHighlights();

    // evidence の表示レベル（ブラインディング制御）:
    // - none:    evidence 自体を出さない（AI判定なしと同じ見た目）
    // - neutral: 単色ハイライト＋「AI注目箇所」。polarity の並びからAI判断を推測させない
    // - full:    組入/除外の色分け・polarityラベル（開示時は常にこれ）
    const level = effectiveEvidenceLevel();
    if (level === 'none') {
        // 空表示は「AI判定根拠なし」と同文言にし、AI判定の有無自体を漏らさない
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const note = findAiFulltextNote(currentRef.ref_id);
    const items: HighlightListItem[] = [];

    if (note && Array.isArray(note.evidence)) {
        note.evidence.forEach((ev, idx) => {
            // neutral では DOM 属性からも polarity が読めないよう中立カテゴリに落とす
            const category: HighlightCategory =
                level !== 'full' ? 'ai_evidence'
                    : ev.polarity === 'exclude' ? 'exclude_evidence' : 'include_evidence';
            const id = `ai-ev-${idx}`;
            const result = pdfRenderer!.highlight({
                id,
                category,
                quote: ev.quote,
                page: ev.page,
                bbox: ev.bbox,
                title: ev.quote,
            });
            items.push({
                id,
                category,
                quote: ev.quote,
                page: result.page ?? ev.page,
                resolved: result.resolved,
                via: result.via,
            });
        });
    }

    renderAnnotationsList(items, note?.image_only ?? currentPdfInfo?.isImageOnly ?? false, {
        emptyMessage: evidenceEmptyMessage(),
    });
    pdfRenderer.setHighlightsVisible(highlightEnabled);
}

/**
 * 現在の文献に対するAIフルテキスト判定（Decision + パース済み note）を返す。
 * 採用ラウンド(aiActiveRound)の判定のみを対象とする。
 * 採用ラウンド未設定、または当該ラウンドの判定が無ければ null（＝AI判定は一切表示しない）。
 */
function findAiFulltext(refId: string): { decision: Decision; note: FulltextLlmDecisionNote } | null {
    if (!aiActiveRound) return null;
    const candidates = allDecisions
        .filter(d =>
            d.ref_id === refId &&
            d.reviewer_id === aiActiveRound &&
            (d.screening_phase ?? 'tiab') === 'fulltext' &&
            !!d.note && d.note.trim().startsWith('{')
        )
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));

    for (const d of candidates) {
        try {
            const parsed = JSON.parse(d.note as string);
            if (parsed && parsed.type === 'llm_fulltext') {
                return { decision: d, note: parsed as FulltextLlmDecisionNote };
            }
        } catch { /* 次の候補へ */ }
    }
    return null;
}

/** 現在の文献に対する最新のAIフルテキスト判定 note を返す（無ければ null） */
function findAiFulltextNote(refId: string): FulltextLlmDecisionNote | null {
    return findAiFulltext(refId)?.note ?? null;
}

interface HighlightListItem {
    id: string;
    category: HighlightCategory;
    quote: string;
    page: number;
    resolved: boolean;
    via: 'text' | 'bbox' | 'none';
}

// 表示中の根拠カード一覧と n/p ジャンプ用のカーソル位置。
// renderAnnotationsList のたびに一覧を差し替え、カーソルは先頭前（-1）へ戻す。
let evidenceItems: HighlightListItem[] = [];
let evidenceCursor = -1;

/**
 * 指定idの根拠カードへスクロールして一時強調する。
 * PDF上のハイライトクリック・n/pジャンプからの連動に使う。
 */
function focusAnnotationCard(id: string): void {
    const list = document.getElementById('ft-annotations-list');
    const card = list?.querySelector(`.ft-annotation-card[data-hl-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!card) return;
    evidenceCursor = evidenceItems.findIndex(i => i.id === id);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    flashElement(card, 'ft-card-flash');
}

/** 要素に flash クラスを付け直してアニメーションを再始動し、終了後に外す */
function flashElement(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow でアニメーションをリセット
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 1300);
}

/**
 * n / p キーで次/前の evidence へジャンプする。
 * カードを強調し、PDF.js 描画中は該当ハイライト（または申告ページ）へもスクロールする。
 */
function jumpToEvidence(delta: number): void {
    if (evidenceItems.length === 0) return;
    if (evidenceCursor === -1) {
        evidenceCursor = delta > 0 ? 0 : evidenceItems.length - 1;
    } else {
        evidenceCursor = (evidenceCursor + delta + evidenceItems.length) % evidenceItems.length;
    }
    const item = evidenceItems[evidenceCursor];
    focusAnnotationCard(item.id);
    // オーバーレイ非表示中は（不可視要素へは scrollIntoView が効かないため）ページ単位で送る
    if (item.resolved && highlightEnabled) {
        pdfRenderer?.scrollToHighlight(item.id);
        pdfRenderer?.flashHighlight(item.id);
    } else if (currentPdfInfo) {
        pdfRenderer?.scrollToPage(item.page);
    }
}

interface AnnotationListOptions {
    /** カードクリックでのスクロールを有効にするか（PDF.js 描画時のみ true）。既定 true */
    clickable?: boolean;
    /** 一覧先頭に出す注意書き（フォールバック表示モードの説明など） */
    notice?: string;
    /** 空表示の文言（状態別の出し分け用）。省略時は既定文言 */
    emptyMessage?: string;
}

/** 右ペインのアノテーション一覧を再構築する */
function renderAnnotationsList(
    items: HighlightListItem[],
    imageOnly: boolean,
    opts: AnnotationListOptions = {}
): void {
    const list = document.getElementById('ft-annotations-list');
    if (!list) return;
    list.innerHTML = '';
    const clickable = opts.clickable ?? true;

    // n/p ジャンプ・ハイライト連動用の一覧を差し替え、カーソルをリセット
    evidenceItems = items;
    evidenceCursor = -1;

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ft-annotation-empty';
        // 理由別メッセージは導線案内を含み複数行になるため、改行を <br> として描画する
        appendTextWithBreaks(empty, opts.emptyMessage ?? AI_EVIDENCE_EMPTY_MESSAGES.no_evidence);
        list.appendChild(empty);
        return;
    }

    if (opts.notice) {
        const notice = document.createElement('div');
        notice.className = 'ft-annotation-notice';
        notice.textContent = opts.notice;
        list.appendChild(notice);
    }

    if (imageOnly) {
        const note = document.createElement('div');
        note.className = 'ft-annotation-imageonly';
        note.textContent = '⚠ スキャン画像PDFのため、ハイライト位置はAIの領域推定に基づきます（精度が落ちる場合があります）。';
        list.appendChild(note);
    }

    for (const item of items) {
        const card = document.createElement('div');
        card.className = 'ft-annotation-card';
        card.dataset.category = item.category;
        card.dataset.hlId = item.id;

        const text = document.createElement('div');
        text.className = 'ft-annotation-text';
        text.textContent = item.quote;
        card.appendChild(text);

        const meta = document.createElement('div');
        meta.className = 'ft-annotation-meta';
        // ＋/－ は緑/赤（P/D型色覚で区別困難）の冗長コーディング
        const polarityLabel =
            item.category === 'ai_evidence' ? 'AI注目箇所'
                : item.category === 'exclude_evidence' ? '－ 除外根拠' : '＋ 組入根拠';
        // フォールバック（クリック不可）時の位置はAIの申告ページ番号そのままなので
        // 「位置不明」の注記は付けない
        const locLabel = !clickable
            ? `p.${item.page}`
            : item.resolved
                ? (item.via === 'bbox' ? `p.${item.page}（領域推定）` : `p.${item.page}`)
                : `p.${item.page}（位置不明）`;
        meta.textContent = `${polarityLabel} · ${locLabel}`;
        card.appendChild(meta);

        if (clickable) {
            // クリックで該当ハイライト（解決済み）またはページ先頭（縮退）へスクロールし、
            // スクロール先のハイライトを一時強調して見つけやすくする
            card.addEventListener('click', () => {
                evidenceCursor = evidenceItems.findIndex(i => i.id === item.id);
                // オーバーレイ非表示中は（不可視要素へは scrollIntoView が効かないため）ページ単位で送る
                if (item.resolved && highlightEnabled) {
                    pdfRenderer?.scrollToHighlight(item.id);
                    pdfRenderer?.flashHighlight(item.id);
                } else {
                    pdfRenderer?.scrollToPage(item.page);
                }
            });
        } else {
            card.classList.add('ft-annotation-static');
        }

        list.appendChild(card);
    }
}

function showPlaceholder(msg: string): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
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

function showResolvedUrl(url: string, source: OaSource | 'cached' | 'linked'): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
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
        openBtn.addEventListener('click', () => { void openLinkedInline(url, source); });

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

    hideCanvasContainer();
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
    if (currentRef?.pmid) {
        const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(currentRef.pmid)}/`;
        links.appendChild(buildExternalAnchor(pubmedUrl, '↗ PubMed で開く', 'btn btn-secondary'));
    }

    panel.append(message, links);
    placeholder.appendChild(panel);
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.replaceChildren();
    renderAiCardsFallback();
}
