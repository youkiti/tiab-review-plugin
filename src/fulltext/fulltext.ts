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

import {
    getAuthToken,
    getUserEmail,
    getFulltextPageData,
    saveFulltextPoolRule,
    saveDecision,
    updateReferenceFulltextUrl,
    isUserAdmin,
} from '../lib/sheets-api';
import { retrieveAndCacheFulltext, fetchPdfResult } from '../lib/fulltext-retriever';
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
import type { Reference, Decision, FulltextLlmDecisionNote } from '../lib/types';
import { PdfRenderer } from './pdf-renderer';
import type { LoadedPdf, HighlightCategory } from './pdf-renderer';

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

// 採用中のフルテキストAI判定ラウンド（reviewer_id）。サマリ/ハイライトはこのラウンドを優先する。
let aiActiveRound: string | null = null;

// 現在ユーザーが管理者（編集権限）か。AI判定の開示トグルを出すかの判定に使う。
let isAdmin = false;
// AI判定（サマリ・evidenceハイライト・根拠カード）を開示するか。
// ブラインド情報のため、ブラインド解除(keyOpened) かつ 管理者 のときのみ既定で開示。
// 管理者は画面内トグルで切り替えられる。非管理者には一切表示しない。
let aiReveal = false;

// フルテキスト候補リスト
let fulltextCandidates: Reference[] = [];
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
    const { references: refs, decisions: decisionsData, config } = await getFulltextPageData(spreadsheetId);

    allRefs = refs;
    allDecisions = decisionsData.map(({ decision }) => decision);
    poolRule = config.fulltextPoolRule;
    keyOpened = config.keyOpened;
    aiActiveRound = config.fulltextAiActiveRound;

    // 管理者判定（権限API）。失敗時は安全側で非管理者扱い。
    isAdmin = await isUserAdmin(spreadsheetId, userEmail).catch(() => false);
    // AI「判断」サマリの既定開示: ブラインド解除済み(keyOpened)なら表示。
    // ブラインド中は隠し、管理者だけが画面内トグルで開示できる。
    // ※ evidence ハイライト・根拠カード（引用そのもの）は判断と別で常時表示する。
    aiReveal = keyOpened;

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
    wireRulePanel();
    updateRuleButton();
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

    renderBiblio(ref);
    renderProgress();
    renderOverallProgress();
    renderDecisionPanel();
    updateToolbarMode();

    // 隣接候補のPDFを先読み（現在文献は前回のうちに先読み済みなら即表示できる）
    prefetchNeighbors();

    // PDF 表示
    await showPdfForRef(ref, token);

    // ルール未設定なら設定パネルを表示（キー未開封時はブロックメッセージ）。
    // ただし既にPDFがある＝判定作業中は縦スペースを優先し自動展開しない
    // （ヘッダーの「候補ルール ▾」からいつでも開ける）。
    if (!isStale(token) && !poolRule && ref.fulltext_status !== 'cached') {
        openRulePanel();
    }
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
            renderOverallProgress();
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
 * - 組み入れ: 保存してそのまま次の候補へ進む
 * - 除外: 理由エリアを表示・フォーカスし、理由が確定（数字キー/Enter）したら次へ進む
 * - 保留: 保存のみ（その場に留まる）
 */
async function chooseDecision(decision: 'include' | 'exclude' | 'maybe'): Promise<void> {
    pendingDecision = decision;
    renderDecisionPanel();

    if (decision === 'exclude') {
        await handleSave();      // まず空理由で保存（後で理由を付けて再保存）
        focusReasonSelect();     // キーボードで理由を選べるようフォーカス
        return;                  // 理由確定で advanceToNext する
    }

    await handleSave();
    if (decision === 'include') advanceToNext();
}

/** 次の候補へ進む（末尾なら留まって通知）。判定後の自動送りに使う。 */
function advanceToNext(): void {
    if (currentCandidateIndex < 0) return;
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
    await handleSave();
    advanceToNext();
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

        // 送信前にメモリ状態を確定させる。除外→数字を高速連打した時に
        // 同じ decision_id を再利用させ、重複行が生まれるのを防ぐ。
        if (existingDecision) {
            existingDecision.decision = decisionObj;
        } else {
            existingDecision = { decision: decisionObj, rowIndex: -1 };
        }
        const idx = allDecisions.findIndex(d => d.decision_id === decisionObj.decision_id);
        if (idx >= 0) allDecisions[idx] = decisionObj;
        else allDecisions.push(decisionObj);
        renderOverallProgress();

        await saveDecision(spreadsheetId, decisionObj);

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
    const len = fulltextCandidates.length;
    const newIndex = (currentCandidateIndex + delta + len) % len;
    const nextRef = fulltextCandidates[newIndex];
    if (nextRef) void loadRef(nextRef.ref_id);
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

    showPlaceholder('OAソースを順番に検証中...\nPMC OA → Europe PMC → 出版社 → Unpaywall → OpenAlex');

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
            () => ensureFulltextFolder(spreadsheetId)
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
            showPlaceholder(`アップロードに失敗しました: ${(err as Error).message}`);
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

/** ハイライトオーバーレイ／アノテーション一覧の表示をトグル状態に同期する */
function applyHighlightVisibility(): void {
    const list = document.getElementById('ft-annotations-list');
    if (list) list.style.display = highlightEnabled ? '' : 'none';
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
function applyHighlightsForCurrentRef(): void {
    if (!pdfRenderer || !currentRef) return;
    pdfRenderer.clearHighlights();

    // evidence ハイライト・根拠カードは引用そのものなので常時表示する
    // （AIの「判断」サマリのみ blind/管理者トグルで制御する）。
    const note = findAiFulltextNote(currentRef.ref_id);
    const items: HighlightListItem[] = [];

    if (note && Array.isArray(note.evidence)) {
        note.evidence.forEach((ev, idx) => {
            const category: HighlightCategory =
                ev.polarity === 'exclude' ? 'exclude_evidence' : 'include_evidence';
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

    renderAnnotationsList(items, note?.image_only ?? currentPdfInfo?.isImageOnly ?? false);
    pdfRenderer.setHighlightsVisible(highlightEnabled);
}

/**
 * 現在の文献に対するAIフルテキスト判定（Decision + パース済み note）を返す。
 * 採用ラウンド(aiActiveRound)が設定されていればそれを優先し、無ければ最新を採る。
 */
function findAiFulltext(refId: string): { decision: Decision; note: FulltextLlmDecisionNote } | null {
    const all = allDecisions.filter(d =>
        d.ref_id === refId &&
        (d.reviewer_id || '').startsWith('llm:') &&
        (d.screening_phase ?? 'tiab') === 'fulltext' &&
        !!d.note && d.note.trim().startsWith('{')
    );
    // 採用ラウンドのものを先頭に、その後は新しい順。
    const candidates = all.sort((a, b) => {
        const aActive = aiActiveRound && a.reviewer_id === aiActiveRound ? 1 : 0;
        const bActive = aiActiveRound && b.reviewer_id === aiActiveRound ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b.decided_at || '').localeCompare(a.decided_at || '');
    });

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

/** 右ペインのアノテーション一覧を再構築する */
function renderAnnotationsList(items: HighlightListItem[], imageOnly: boolean): void {
    const list = document.getElementById('ft-annotations-list');
    if (!list) return;
    list.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ft-annotation-empty';
        empty.textContent = 'このPDFのAI判定根拠はまだありません。';
        list.appendChild(empty);
        return;
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

        const text = document.createElement('div');
        text.className = 'ft-annotation-text';
        text.textContent = item.quote;
        card.appendChild(text);

        const meta = document.createElement('div');
        meta.className = 'ft-annotation-meta';
        const polarityLabel = item.category === 'exclude_evidence' ? '除外根拠' : '組入根拠';
        const locLabel = item.resolved
            ? (item.via === 'bbox' ? `p.${item.page}（領域推定）` : `p.${item.page}`)
            : `p.${item.page}（位置不明）`;
        meta.textContent = `${polarityLabel} · ${locLabel}`;
        card.appendChild(meta);

        // クリックで該当ハイライト（解決済み）またはページ先頭（縮退）へスクロール
        card.addEventListener('click', () => {
            if (item.resolved) {
                pdfRenderer?.scrollToHighlight(item.id);
            } else {
                pdfRenderer?.scrollToPage(item.page);
            }
        });

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
        placeholder.innerHTML = msg.replace(/\n/g, '<br>');
    }
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.innerHTML = '';
}

function showResolvedUrl(url: string, source: OaSource | 'cached' | 'linked'): void {
    hideArticleFrame();
    hidePdfFrame();
    hideCanvasContainer();
    hideSavePdfButton();
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        placeholder.innerHTML = '';
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
