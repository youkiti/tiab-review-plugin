/**
 * 重複候補のレビューUI（Issue #147、Issue #145 チャンク3）
 *
 * 純関数層（src/lib/duplicate-review.ts）を消費する UI 層。判定ロジックはここに書き直さず、
 * すべて import して使う。
 *
 * fulltext-publication-candidates.ts と同じ流儀:
 * - DOM は document.createElement() で動的生成する（sidepanel.html / dom.ts は触らない）。
 * - 循環importは setXxxDeps() の依存注入で回避する。
 * - 二重クリックガード（in-flight の Set）を持ち、finally でボタンを必ず復帰する。
 * - モーダルは src/sidepanel/ui/modal.ts の showModal() / hideModal() を使う（新設しない）。
 *
 * chrome.* API は一切使わない（src/sidepanel/ 配下は docs/app/ の Web版にも入るため）。
 * Web版では initModal() が呼ばれず ✕ ボタンが未配線のため、モーダルのフッターには
 * 必ず自前の閉じるボタンを置き hideModal() を直接呼ぶ。
 */

import { state } from '../state';
import { dom } from '../dom';
import { t } from '../../lib/i18n';
import { showToast, showLoading } from '../ui/feedback';
import { showModal, hideModal } from '../ui/modal';
import {
    resolveSurvivor,
    diffReferenceFields,
    isAutoApplicableCandidate,
    isPairAlreadySettled,
    arePairRefsMutuallyDeleted,
    chooseMutualDeletionSurvivor,
    planBulkApply,
    scanReferencesForDuplicatePairs,
} from '../../lib/duplicate-review';
import { filterNewDuplicatePairs, isLogicallyDeleted } from '../../lib/duplicate-detect';
import { isLlmDecision, isMlDecision } from '../../lib/client-version';
import {
    getReferences,
    getDuplicateCandidates,
    updateDuplicateCandidateStatus,
    setDuplicateOf,
    saveDuplicateCandidates,
    getDecisions,
} from '../../lib/sheets-api';
import type { Reference, DuplicateCandidate, Decision } from '../../lib/types';
import type { DuplicateMatchType } from '../../lib/duplicate-detect';
import type { BulkApplyCandidateInput } from '../../lib/duplicate-review';

// ---------------------------------------------------------------------------
// 依存注入（project.loadDataAndShowScreening への依存を回避する。循環import回避）
// ---------------------------------------------------------------------------

export interface DuplicateReviewDeps {
    /** 適用後にデータを読み直して画面を描き直す（project.loadDataAndShowScreening を注入する） */
    reloadAfterApply: () => Promise<void>;
}

let deps: DuplicateReviewDeps | null = null;

export function setDuplicateReviewDeps(d: DuplicateReviewDeps): void {
    deps = d;
}

// ---------------------------------------------------------------------------
// モジュールローカル状態
// ---------------------------------------------------------------------------

const SECTION_ID = 'duplicate-review-section';

/**
 * モーダルに一度に描画する未確認候補の上限。正規化タイトル一致だけで数百組出ることがあり、
 * 全件を1組10行の比較テーブル付きで描画すると狭いサイドパネルに数千行のDOMができてしまう
 * ため上限を設ける。片付けるたびに refreshModalContents() が再描画するので、残りは
 * 順に表示される（一度に全件は見えないが、繰り返し操作すれば全件に到達できる）。
 */
const MAX_RENDERED_PAIRS = 50;

/** 独立セクションに出す未確認候補件数のキャッシュ。null は「未取得」。 */
let pendingCount: number | null = null;
let pendingCountFailed = false;
let loadingPendingCount = false;
/** プロジェクト切替・ログアウトでキャッシュが古いまま残らないようにするための直前値 */
let cachedSpreadsheetId: string | null = null;

/**
 * 「あとでまとめて確認」が押されたことを示すセッションローカルのフラグ。
 * true の間は openDuplicateReviewModal({ fromImport: true }) を呼んでもモーダルを出さず、
 * 案内トーストに差し替える（Issue #147「連続インポート中にモーダルを強制しない」）。
 */
let deferredThisSession = false;

/** 個別ペア適用（統合/別々の文献）の二重クリックガード（candidate_id 単位） */
const applyInFlight = new Set<string>();
let bulkApplyInFlight = false;
let rescanInFlight = false;

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function buildRefsById(refs: Reference[]): Map<string, Reference> {
    return new Map(refs.map((r) => [r.ref_id, r]));
}

interface DecisionCount {
    total: number;
    ai: number;
}

/**
 * getDecisions() の結果（ref_id, reviewer_id, screening_phase 単位で最新1行へ畳み込み済み）から
 * ref_id ごとの判定件数を集計する。
 *
 * decision が 'pending' または空文字の行は「未判定」として除外する
 * （decision-summary.ts の buildReviewerDecisionMap() と同じ扱い。メモのみ保存された
 * pending 行を判定件数に数えない）。
 *
 * ai は isLlmDecision() または isMlDecision() が true の件数。表示・警告に使うのは
 * total - ai（AI以外の判定数）で、client_version が空の古い行は AI と判定できないため
 * この式では人の判定として数えられる。これは意図した安全側の倒し方
 * （「消すと困る側」＝人間の判定として扱う）。
 */
function buildDecisionCounts(decisionsData: { decision: Decision }[]): Map<string, DecisionCount> {
    const map = new Map<string, DecisionCount>();
    for (const { decision } of decisionsData) {
        if (!decision.decision || decision.decision === 'pending') continue;
        const refId = (decision.ref_id || '').trim();
        if (!refId) continue;

        const entry = map.get(refId) ?? { total: 0, ai: 0 };
        entry.total += 1;
        if (isLlmDecision(decision.client_version) || isMlDecision(decision.client_version)) {
            entry.ai += 1;
        }
        map.set(refId, entry);
    }
    return map;
}

function nonAiCountOf(counts: Map<string, DecisionCount>, refId: string): number {
    const c = counts.get(refId);
    if (!c) return 0;
    return c.total - c.ai;
}

function formatDecisionCountLabel(counts: Map<string, DecisionCount>, refId: string): string {
    const c = counts.get(refId) ?? { total: 0, ai: 0 };
    return t('dupReview_decisionCount', [String(c.total), String(c.ai)]);
}

const MATCH_TYPE_LABEL_KEYS: Record<DuplicateMatchType, string> = {
    pmid: 'dupReview_matchType_pmid',
    doi: 'dupReview_matchType_doi',
    trialId: 'dupReview_matchType_trialId',
    title: 'dupReview_matchType_title',
};

const FIELD_LABEL_KEYS: Record<string, string> = {
    title: 'dupReview_field_title',
    journal: 'dupReview_field_journal',
    volume: 'dupReview_field_volume',
    issue: 'dupReview_field_issue',
    pages: 'dupReview_field_pages',
    doi: 'dupReview_field_doi',
    pmid: 'dupReview_field_pmid',
    year: 'dupReview_field_year',
    source: 'dupReview_field_source',
    source_file: 'dupReview_field_sourceFile',
};

function fieldLabel(field: string): string {
    const key = FIELD_LABEL_KEYS[field];
    return key ? t(key) : field;
}

/**
 * 未確認候補件数キャッシュを破棄し、独立セクションを再描画（読み直しは投げっぱなし）する。
 *
 * export する理由（Issue #147 外部レビュー指摘）: `handleRISImport()`（import-export.ts）が
 * `saveDuplicateCandidates()` 成功直後に呼ぶ。初回ロードで 0 件がキャッシュされた後は
 * `pendingCount === null` ガードにより非nullのまま固定され、以後どのボタンも押さない限り
 * 古い件数（0件）が残り続ける。「あとでまとめて確認」でモーダルを閉じてセクションへ戻る導線が
 * まさにこの経路のため、保存直後に必ずここを呼んで無効化する（モーダルが開くかどうかには
 * 依存させない。未確認0件のときは openDuplicateReviewModal({ fromImport: true }) がモーダルを
 * 出さないため）。
 */
export function invalidatePendingCountAndRerenderSection(): void {
    pendingCount = null;
    pendingCountFailed = false;
    renderDuplicateReviewSection();
}

// ---------------------------------------------------------------------------
// 独立セクション（renderSourceFilters() の先頭から呼ばれる）
// ---------------------------------------------------------------------------

/**
 * プロジェクト読み込み側（project.ts の loadDataAndShowScreening）が既に取得済みの
 * References（論理削除を含む全件）と Duplicate_Candidates を渡し、未確認件数キャッシュを
 * 直接温める（Issue #153 工程2 チャンク2）。これにより、続けて呼ぶ renderDuplicateReviewSection()
 * 内の「pendingCount === null なら loadPendingCount() で取得」が発火せず、初回描画のたびに
 * getReferences() + getDuplicateCandidates() を再取得する重複がなくなる。
 *
 * 🔄ボタン相当の明示的な再取得経路（invalidatePendingCountAndRerenderSection・
 * rescanDuplicates・モーダルを開く操作）はこの関数を経由せず、従来どおり内部で取得し直す
 * （判定を進めても未確認件数が更新されなくなる、という事態を避けるため）。
 */
export function primeDuplicateReviewSection(
    spreadsheetId: string,
    allReferences: Reference[],
    candidates: DuplicateCandidate[]
): void {
    cachedSpreadsheetId = spreadsheetId;
    const refsById = buildRefsById(allReferences);
    pendingCount = candidates.filter((c) => !isPairAlreadySettled(c, refsById)).length;
    pendingCountFailed = false;
    loadingPendingCount = false;
    renderDuplicateReviewSection();
}

/**
 * 管理画面の独立セクションを描画する。同期関数で返り、件数の読み込みは投げっぱなし（void）にする
 * （呼び出し元の renderSourceFilters() が同期関数のため）。
 *
 * 既にセクションのDOMがあれば作り直さず中身だけ更新する（renderSourceFilters() は何度も呼ばれる）。
 */
export function renderDuplicateReviewSection(): void {
    // プロジェクト切替・ログアウトでキャッシュが古いまま残らないよう、spreadsheetId が
    // 変わった時点（空文字への変化も含む）で必ずキャッシュを破棄する。
    if (cachedSpreadsheetId !== state.spreadsheetId) {
        cachedSpreadsheetId = state.spreadsheetId;
        pendingCount = null;
        pendingCountFailed = false;
    }

    if (!state.spreadsheetId) return;

    let section = document.getElementById(SECTION_ID) as HTMLDivElement | null;
    const isNew = !section;
    if (!section) {
        section = document.createElement('div');
        section.id = SECTION_ID;
        section.className = 'dup-review-section';
    }

    renderSectionBody(section);

    if (isNew) {
        const anchor = dom.sourceFiltersSection;
        if (anchor.parentNode) {
            anchor.parentNode.insertBefore(section, anchor);
        }
    }

    if (pendingCount === null && !loadingPendingCount && !pendingCountFailed) {
        void loadPendingCount();
    }
}

function sectionCountText(): string {
    if (pendingCountFailed) return t('dupReview_countError');
    if (pendingCount === null) return t('dupReview_countLoading');
    return t('dupReview_countLabel', String(pendingCount));
}

function renderSectionBody(section: HTMLElement): void {
    section.innerHTML = '';

    const heading = document.createElement('h4');
    heading.textContent = t('dupReview_sectionTitle');
    section.appendChild(heading);

    const countP = document.createElement('p');
    countP.className = 'dup-review-count';
    countP.textContent = sectionCountText();
    section.appendChild(countP);

    const actions = document.createElement('div');
    actions.className = 'dup-review-section-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-secondary btn-small';
    openBtn.textContent = t('dupReview_openBtn');
    openBtn.addEventListener('click', () => {
        void openDuplicateReviewModal();
    });
    actions.appendChild(openBtn);

    const rescanBtn = document.createElement('button');
    rescanBtn.type = 'button';
    rescanBtn.className = 'btn btn-secondary btn-small';
    rescanBtn.textContent = t('dupReview_rescanBtn');
    rescanBtn.addEventListener('click', () => {
        void rescanDuplicates();
    });
    actions.appendChild(rescanBtn);

    section.appendChild(actions);
}

async function loadPendingCount(): Promise<void> {
    if (loadingPendingCount) return;
    if (!state.spreadsheetId) return;
    loadingPendingCount = true;
    const spreadsheetId = state.spreadsheetId;

    try {
        const [refs, candidates] = await Promise.all([
            getReferences(spreadsheetId),
            getDuplicateCandidates(spreadsheetId),
        ]);
        // 読み込み中にプロジェクトが切り替わっていたら、古い結果で上書きしない
        if (state.spreadsheetId !== spreadsheetId) return;
        const refsById = buildRefsById(refs);
        pendingCount = candidates.filter((c) => !isPairAlreadySettled(c, refsById)).length;
        pendingCountFailed = false;
    } catch (err) {
        console.warn('[duplicate-review] 未確認候補件数の取得に失敗:', err);
        pendingCountFailed = true;
    } finally {
        loadingPendingCount = false;
        renderDuplicateReviewSection();
    }
}

// ---------------------------------------------------------------------------
// モーダル本体
// ---------------------------------------------------------------------------

/**
 * 重複候補レビューのモーダルを開く。
 *
 * fromImport: true は取り込み直後の自動起動。「あとでまとめて確認」が押された後の
 * セッションでは何も出さず、代わりに独立セクションへの案内トーストを出す
 * （Issue #147「連続インポート中にモーダルを強制しない」）。
 * fromImport なし（セクションのボタンからの明示操作）はフラグに関係なく必ず開く。
 */
export async function openDuplicateReviewModal(options?: { fromImport?: boolean }): Promise<void> {
    if (!state.spreadsheetId) return;

    if (options?.fromImport && deferredThisSession) {
        showToast(t('dupReview_deferredReminder'), 6000);
        return;
    }

    await refreshModalContents({ fromImport: options?.fromImport });
}

/**
 * fromImport: true のときは、読み直した結果 未確認（isPairAlreadySettled() が false）の候補が
 * 0件ならモーダルを開かず何も表示せず戻る（取り込み完了トーストが既に出ているため、
 * ここで追加のトーストも出さない）。saveDuplicateCandidates() は既出の組を内部で落とすため、
 * 今回の検出がすべて既出だった場合は未確認の候補が1件も無いことがある。
 * fromImport なし（明示操作）では、これまでどおり0件でも開いて「未確認の重複候補はありません」
 * を出す（ユーザーがボタンを押した以上、無反応は不可）。
 */
async function refreshModalContents(options?: { fromImport?: boolean }): Promise<void> {
    if (!state.spreadsheetId) return;
    try {
        const [refs, candidates, decisionsData] = await Promise.all([
            getReferences(state.spreadsheetId),
            getDuplicateCandidates(state.spreadsheetId),
            getDecisions(state.spreadsheetId),
        ]);

        if (options?.fromImport) {
            const refsById = buildRefsById(refs);
            const hasUnresolved = candidates.some((c) => !isPairAlreadySettled(c, refsById));
            if (!hasUnresolved) return;
        }

        renderReviewModal(refs, candidates, decisionsData.map((d) => d.decision));
    } catch (err) {
        console.error('[duplicate-review] モーダル表示用データの読み込みに失敗:', err);
        showToast(t('dupReview_loadError', (err as Error).message), 6000);
    }
}

function renderReviewModal(refs: Reference[], candidates: DuplicateCandidate[], decisions: Decision[]): void {
    const refsById = buildRefsById(refs);
    const decisionCounts = buildDecisionCounts(decisions.map((decision) => ({ decision })));

    const unresolved = candidates.filter((c) => !isPairAlreadySettled(c, refsById));

    const body = document.createElement('div');
    body.className = 'dup-review-modal-body';

    if (unresolved.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'dup-review-empty';
        empty.textContent = t('dupReview_noneToReview');
        body.appendChild(empty);
    } else {
        const toRender = unresolved.slice(0, MAX_RENDERED_PAIRS);
        for (const candidate of toRender) {
            body.appendChild(buildPairRow(candidate, refsById, decisionCounts));
        }

        const remaining = unresolved.length - toRender.length;
        if (remaining > 0) {
            const more = document.createElement('p');
            more.className = 'dup-review-empty';
            more.textContent = t('dupReview_moreRemaining', String(remaining));
            body.appendChild(more);
        }
    }

    const footer = buildModalFooter();

    showModal({
        title: t('dupReview_modalTitle'),
        body,
        footer,
    });
}

function buildModalFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'dup-review-modal-footer';

    const bulkBtn = document.createElement('button');
    bulkBtn.type = 'button';
    bulkBtn.className = 'btn btn-primary btn-small';
    bulkBtn.textContent = t('dupReview_bulkApplyBtn');

    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'btn btn-secondary btn-small';
    laterBtn.textContent = t('dupReview_laterBtn');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-outline btn-small';
    closeBtn.textContent = t('dupReview_closeBtn');

    bulkBtn.addEventListener('click', () => {
        void handleBulkApply([bulkBtn, laterBtn, closeBtn]);
    });
    laterBtn.addEventListener('click', () => {
        handleDeferToLater();
    });
    closeBtn.addEventListener('click', () => {
        hideModal();
    });

    footer.appendChild(bulkBtn);
    footer.appendChild(laterBtn);
    footer.appendChild(closeBtn);
    return footer;
}

function handleDeferToLater(): void {
    deferredThisSession = true;
    hideModal();
    // 「どこから続きを再開できるかを必ず案内する」（Issue #147 ユーザー確定事項 2026-09-03）
    showToast(t('dupReview_deferredReminder'), 6000);
}

// ---------------------------------------------------------------------------
// 1組の表示
// ---------------------------------------------------------------------------

function buildPairRow(
    candidate: DuplicateCandidate,
    refsById: Map<string, Reference>,
    decisionCounts: Map<string, DecisionCount>
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dup-review-pair';
    row.appendChild(buildPairHeader(candidate));

    const survivorA = resolveSurvivor(candidate.ref_id_a, refsById);
    const survivorB = resolveSurvivor(candidate.ref_id_b, refsById);
    const refA = !survivorA.broken ? refsById.get(survivorA.refId) : undefined;
    const refB = !survivorB.broken ? refsById.get(survivorB.refId) : undefined;
    const broken = survivorA.broken || survivorB.broken || !refA || !refB;

    if (broken || !refA || !refB) {
        const msg = document.createElement('p');
        msg.className = 'dup-review-broken-message';
        msg.textContent = t('dupReview_brokenPair');
        row.appendChild(msg);
        // 相互削除（duplicate_of[A]=B かつ duplicate_of[B]=A）に限り「修復する」ボタンを出す
        // （Issue #147）。判定は候補の元の ref_id_a/ref_id_b を直接見る（resolveSurvivor() が
        // 循環検出時に返す refId は循環に入った時点の行であり、必ずしも ref_id_a/ref_id_b
        // 自身とは限らないため）。相互削除でない broken（物理削除で参照先が消えた等）は
        // 生存者を安全に決められないためボタンを出さない。
        const mutuallyDeleted = arePairRefsMutuallyDeleted(candidate.ref_id_a, candidate.ref_id_b, refsById);
        row.appendChild(buildPairActions(candidate, undefined, undefined, mutuallyDeleted));
        return row;
    }

    row.appendChild(buildCompareTable(refA, refB));
    row.appendChild(buildDecisionCountsRow(refA.ref_id, refB.ref_id, decisionCounts));
    row.appendChild(buildPairActions(candidate, refA, refB, false));

    return row;
}

function buildPairHeader(candidate: DuplicateCandidate): HTMLElement {
    const header = document.createElement('div');
    header.className = 'dup-review-pair-header';

    const badge = document.createElement('span');
    badge.className = 'dup-review-match-badge';
    badge.textContent = t(MATCH_TYPE_LABEL_KEYS[candidate.match_type] ?? 'dupReview_matchType_title');
    header.appendChild(badge);

    const key = document.createElement('span');
    key.className = 'dup-review-match-key';
    key.textContent = candidate.match_key;
    header.appendChild(key);

    return header;
}

/**
 * 左右比較テーブル。diffReferenceFields() の戻り値をそのまま順に並べ、differs な行だけ
 * 強調する。値は textContent で挿入するため escapeHtml() は不要（外部由来の title/journal 等を
 * innerHTML に載せないため、この方針で安全性を担保する）。
 */
function buildCompareTable(refA: Reference, refB: Reference): HTMLElement {
    const table = document.createElement('table');
    table.className = 'dup-review-compare-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const thField = document.createElement('th');
    thField.textContent = t('dupReview_fieldColumnHeader');
    const thLeft = document.createElement('th');
    thLeft.textContent = t('dupReview_leftColumnHeader');
    const thRight = document.createElement('th');
    thRight.textContent = t('dupReview_rightColumnHeader');
    headRow.append(thField, thLeft, thRight);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const fieldRow of diffReferenceFields(refA, refB)) {
        const tr = document.createElement('tr');
        if (fieldRow.differs) tr.className = 'dup-review-diff-row';

        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = fieldLabel(fieldRow.field);
        tr.appendChild(th);

        const tdA = document.createElement('td');
        tdA.textContent = fieldRow.valueA || '—';
        tr.appendChild(tdA);

        const tdB = document.createElement('td');
        tdB.textContent = fieldRow.valueB || '—';
        tr.appendChild(tdB);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return table;
}

function buildDecisionCountsRow(
    refIdA: string,
    refIdB: string,
    decisionCounts: Map<string, DecisionCount>
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dup-review-decision-counts';

    const left = document.createElement('span');
    left.textContent = formatDecisionCountLabel(decisionCounts, refIdA);
    const right = document.createElement('span');
    right.textContent = formatDecisionCountLabel(decisionCounts, refIdB);

    row.append(left, right);
    return row;
}

function buildPairActions(
    candidate: DuplicateCandidate,
    refA: Reference | undefined,
    refB: Reference | undefined,
    mutuallyDeleted: boolean
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'dup-review-pair-actions';

    const keepLeftBtn = document.createElement('button');
    keepLeftBtn.type = 'button';
    keepLeftBtn.className = 'btn btn-secondary btn-small';
    keepLeftBtn.textContent = t('dupReview_keepLeftBtn');

    const keepRightBtn = document.createElement('button');
    keepRightBtn.type = 'button';
    keepRightBtn.className = 'btn btn-secondary btn-small';
    keepRightBtn.textContent = t('dupReview_keepRightBtn');

    const separateBtn = document.createElement('button');
    separateBtn.type = 'button';
    separateBtn.className = 'btn btn-outline btn-small';
    separateBtn.textContent = t('dupReview_separateBtn');

    const buttons = [keepLeftBtn, keepRightBtn, separateBtn];

    if (!refA || !refB) {
        // 壊れたペア（duplicate_of チェーンの循環・参照先欠落）でも「別々の文献」は
        // updateDuplicateCandidateStatus() のみで References に触れないため安全に実行できる。
        // 「左を残す」「右を残す」は残す側を安全に決められないため disabled のままにする。
        // separateBtn の in-flight 制御は自分自身だけを渡す（buttons 全体を渡すと、
        // dismissPairDecision() の finally が keepLeft/keepRight まで再度有効化してしまう）。
        keepLeftBtn.disabled = true;
        keepRightBtn.disabled = true;
        separateBtn.addEventListener('click', () => {
            void dismissPairDecision(candidate, [separateBtn]);
        });

        actions.append(keepLeftBtn, keepRightBtn, separateBtn);

        // 相互削除（同時更新の競合）に限り「修復する」ボタンを追加する（Issue #147）。
        // 物理削除等の通常の broken には出さない（生存者を安全に決められないため）。
        // in-flight 制御は自分自身だけを渡す（separateBtn と同じ理由）。
        if (mutuallyDeleted) {
            const repairBtn = document.createElement('button');
            repairBtn.type = 'button';
            repairBtn.className = 'btn btn-secondary btn-small';
            repairBtn.textContent = t('dupReview_repairBtn');
            repairBtn.addEventListener('click', () => {
                void handleManualRepair(candidate, [repairBtn]);
            });
            actions.appendChild(repairBtn);
        }

        return actions;
    }

    const keepA = refA;
    const keepB = refB;
    keepLeftBtn.addEventListener('click', () => {
        void applyPairDecision(candidate, keepA.ref_id, keepB.ref_id, buttons);
    });
    keepRightBtn.addEventListener('click', () => {
        void applyPairDecision(candidate, keepB.ref_id, keepA.ref_id, buttons);
    });
    separateBtn.addEventListener('click', () => {
        void dismissPairDecision(candidate, buttons);
    });

    actions.append(keepLeftBtn, keepRightBtn, separateBtn);
    return actions;
}

// ---------------------------------------------------------------------------
// 相互削除ペアの修復（自動修復・手動「修復する」ボタンの共有ロジック、Issue #147）
// ---------------------------------------------------------------------------

/**
 * 相互削除ペア（duplicate_of[A]=B かつ duplicate_of[B]=A）を修復する。
 * applyPairDecision() の書き込み直後の自動修復と、壊れたペアに出す手動の「修復する」ボタンの
 * 両方から呼ぶ共有ロジック（二重実装しない）。
 *
 * 呼び出し直前に References を読み直し、まだ相互削除の状態が残っているかを再確認する
 * （他のレビュアーやこの関数の別の呼び出し元が先に直している可能性があるため）。
 * 既に直っていれば何も書き込まず repaired: false を返す。
 *
 * 生存者は chooseMutualDeletionSurvivor()（ref_id の辞書順のみで決める）で決め、
 * 生存者の duplicate_of を空へ戻しつつ、もう一方へ生存者を書く（setDuplicateOf() 1回）。
 */
async function repairMutualDeletion(
    refIdA: string,
    refIdB: string
): Promise<{ repaired: boolean; survivor?: string }> {
    const verifyRefs = await getReferences(state.spreadsheetId);
    const verifyRefsById = buildRefsById(verifyRefs);
    if (!arePairRefsMutuallyDeleted(refIdA, refIdB, verifyRefsById)) {
        return { repaired: false };
    }

    const { survivor, removed } = chooseMutualDeletionSurvivor(refIdA, refIdB);
    await setDuplicateOf(state.spreadsheetId, [
        { refId: survivor, duplicateOf: null },
        { refId: removed, duplicateOf: survivor },
    ]);
    return { repaired: true, survivor };
}

// ---------------------------------------------------------------------------
// 1組を適用する処理（「左を残す」/「右を残す」）
// ---------------------------------------------------------------------------

/**
 * 押した瞬間にもう一度読み直してから適用する（fulltext-publication-candidates.ts の
 * handleImportCandidate() と同じ理由。他のレビュアーが同じ組を先に処理している可能性があるため）。
 *
 * 警告（confirm）の根拠になる判定件数（nonAi）も References・候補と同じタイミングで
 * getDecisions() を読み直して作り直す。モーダル描画時点の件数を使うと、モーダルを開いたまま
 * 放置している間に他のレビュアーが判定を付けても警告が出ないまま適用されてしまうため、
 * 「適用の直前に読み直す」対象からこれだけ外すわけにはいかない。
 *
 * setDuplicateOf() → updateDuplicateCandidateStatus() の順序は変えないこと。
 * 後者を先にすると、後者が成功して前者が失敗した場合に「候補は決着済みなのに行は生きている」
 * ＝重複除去が黙って失われた状態になる。前者を先にすれば、後者が失敗しても行は正しく
 * 除外済みで、次回の再読み込みで isPairAlreadySettled() が survivor 収束を検出できる。
 *
 * 【同時更新対策】（Issue #147。Google Sheets の values API に CAS が無いため、
 * 排他制御ではなく「壊れても必ず表に出し、決定的に収束させる」方向で対処する）:
 * - 書き込み直前: 残す側（keepRefId）が fresh なデータで既に論理削除されていないかを見る。
 *   既に削除済みなら書き込まない（「消された行を指す duplicate_of」を新たに作らないため）。
 * - 書き込み直後: References を読み直し、相互削除（duplicate_of[A]=B かつ duplicate_of[B]=A）
 *   が起きていないか再検証する。起きていれば chooseMutualDeletionSurvivor() の辞書順ルールで
 *   決定的に修復し、結果をトーストで知らせる（黙って直さない）。
 */
async function applyPairDecision(
    candidate: DuplicateCandidate,
    keepRefId: string,
    removeRefId: string,
    buttons: HTMLButtonElement[]
): Promise<void> {
    if (applyInFlight.has(candidate.candidate_id)) return;
    applyInFlight.add(candidate.candidate_id);
    buttons.forEach((b) => { b.disabled = true; });

    try {
        const [freshRefs, freshCandidates, freshDecisionsData] = await Promise.all([
            getReferences(state.spreadsheetId),
            getDuplicateCandidates(state.spreadsheetId),
            getDecisions(state.spreadsheetId),
        ]);
        const freshRefsById = buildRefsById(freshRefs);
        const freshCandidate = freshCandidates.find((c) => c.candidate_id === candidate.candidate_id);

        if (!freshCandidate || isPairAlreadySettled(freshCandidate, freshRefsById)) {
            showToast(t('dupReview_alreadyProcessed'), 5000);
            await refreshModalContents();
            return;
        }

        const freshDecisionCounts = buildDecisionCounts(freshDecisionsData.map((d) => ({ decision: d.decision })));
        const nonAi = nonAiCountOf(freshDecisionCounts, removeRefId);
        if (nonAi > 0) {
            const proceed = confirm(t('dupReview_confirmRemoveWithDecisions', String(nonAi)));
            if (!proceed) return;
        }

        // 残す側が fresh なデータで既に論理削除されているなら書き込まない（同時更新対策）。
        const freshKeepRef = freshRefsById.get(keepRefId);
        if (freshKeepRef && isLogicallyDeleted(freshKeepRef)) {
            showToast(t('dupReview_alreadyProcessed'), 5000);
            await refreshModalContents();
            return;
        }

        try {
            await setDuplicateOf(state.spreadsheetId, [{ refId: removeRefId, duplicateOf: keepRefId }]);
        } catch (err) {
            console.error('[duplicate-review] setDuplicateOf に失敗:', err);
            showToast(t('dupReview_applyError', (err as Error).message), 6000);
            return;
        }

        // 書き込み直後に相互削除（同時更新の競合）が起きていないか再検証し、決定的に修復する
        // （repairMutualDeletion() は手動の「修復する」ボタンとも共有する。二重実装しない）。
        try {
            const result = await repairMutualDeletion(keepRefId, removeRefId);
            if (result.repaired) {
                showToast(t('dupReview_mutualDeletionRepaired'), 6000);
            }
        } catch (err) {
            console.error('[duplicate-review] 相互削除の検証/修復に失敗:', err);
            showToast(t('dupReview_mutualDeletionRepairError', (err as Error).message), 8000);
        }

        let statusUpdateOk = true;
        try {
            await updateDuplicateCandidateStatus(state.spreadsheetId, [{
                candidateId: candidate.candidate_id,
                status: 'merged',
                decidedBy: state.userEmail,
                keptRefId: keepRefId,
            }]);
        } catch (err) {
            console.error('[duplicate-review] updateDuplicateCandidateStatus に失敗:', err);
            statusUpdateOk = false;
        }

        invalidatePendingCountAndRerenderSection();
        await refreshModalContents();

        const messages = [statusUpdateOk ? t('dupReview_applyDone') : t('dupReview_statusUpdateFailedAfterRemoval')];
        let reloadOk = true;
        if (deps) {
            // deps.reloadAfterApply() を個別の try/catch で包む（Issue #147 外部レビュー指摘）。
            // ここで throw させたまま外側の catch-all に流すと、適用自体（setDuplicateOf /
            // updateDuplicateCandidateStatus）は成功しているにもかかわらず、外側catchの
            // dupReview_refreshError（「候補データの取得に失敗しました」）という事実と異なる
            // 文言が出てしまう。再読み込み失敗であることが分かる専用の文言に差し替える。
            try {
                await deps.reloadAfterApply();
            } catch (err) {
                console.error('[duplicate-review] reloadAfterApply に失敗:', err);
                reloadOk = false;
                messages.push(t('dupReview_reloadAfterApplyFailed'));
            }
        } else {
            messages.push(t('dupReview_depsMissing'));
        }
        showToast(messages.join(' / '), statusUpdateOk && deps && reloadOk ? 3000 : 8000);
    } catch (err) {
        // getDuplicateCandidates() 等の取得失敗がここへ流れてくる（Issue #147。
        // 以前は getDuplicateCandidates() が例外を握りつぶして空配列を返していたため、
        // このcatchが無くても freshCandidate が undefined になるだけで気付けなかった）。
        // 「他のレビュアーが処理済み」とは事実が異なるため、別の文言で知らせる。
        // deps.reloadAfterApply() の失敗はここには流れてこない（上の個別try/catchが拾う）。
        console.error('[duplicate-review] 適用処理に失敗:', err);
        showToast(t('dupReview_refreshError', (err as Error).message), 6000);
    } finally {
        applyInFlight.delete(candidate.candidate_id);
        buttons.forEach((b) => { b.disabled = false; });
    }
}

/**
 * 「別々の文献」。References には一切触れない（updateDuplicateCandidateStatus() のみ）。
 * 適用前の再読み直しと isPairAlreadySettled() チェックは個別適用と同じように行う。
 */
async function dismissPairDecision(candidate: DuplicateCandidate, buttons: HTMLButtonElement[]): Promise<void> {
    if (applyInFlight.has(candidate.candidate_id)) return;
    applyInFlight.add(candidate.candidate_id);
    buttons.forEach((b) => { b.disabled = true; });

    try {
        const [freshRefs, freshCandidates] = await Promise.all([
            getReferences(state.spreadsheetId),
            getDuplicateCandidates(state.spreadsheetId),
        ]);
        const freshRefsById = buildRefsById(freshRefs);
        const freshCandidate = freshCandidates.find((c) => c.candidate_id === candidate.candidate_id);

        if (!freshCandidate || isPairAlreadySettled(freshCandidate, freshRefsById)) {
            showToast(t('dupReview_alreadyProcessed'), 5000);
            await refreshModalContents();
            return;
        }

        try {
            await updateDuplicateCandidateStatus(state.spreadsheetId, [{
                candidateId: candidate.candidate_id,
                status: 'dismissed',
                decidedBy: state.userEmail,
            }]);
        } catch (err) {
            console.error('[duplicate-review] dismissed への更新に失敗:', err);
            showToast(t('dupReview_dismissError', (err as Error).message), 6000);
            return;
        }

        showToast(t('dupReview_dismissDone'), 3000);
        invalidatePendingCountAndRerenderSection();
        await refreshModalContents();
    } catch (err) {
        // getDuplicateCandidates() 等の取得失敗がここへ流れてくる（Issue #147。
        // 「他のレビュアーが処理済み」とは事実が異なるため、別の文言で知らせる）。
        console.error('[duplicate-review] 別々の文献への記録処理に失敗:', err);
        showToast(t('dupReview_refreshError', (err as Error).message), 6000);
    } finally {
        applyInFlight.delete(candidate.candidate_id);
        buttons.forEach((b) => { b.disabled = false; });
    }
}

/**
 * 「修復する」ボタン（相互削除ペアの手動回復、Issue #147）。自動修復に使う
 * repairMutualDeletion() をそのまま呼び、二重実装を避ける。
 *
 * repairMutualDeletion() は呼び出し直前に References を読み直し、既に相互削除の状態が
 * 解消されていれば（他のレビュアーが先に直した等）何も書き込まず repaired: false を返す。
 * その場合は「既に修復済み」の旨を表示するだけで済ませる（他の操作と同じ流儀）。
 *
 * 二重クリックガードと finally でのボタン復帰は applyPairDecision() / dismissPairDecision()
 * と同じ流儀（applyInFlight を candidate_id で共有する）。
 */
async function handleManualRepair(candidate: DuplicateCandidate, buttons: HTMLButtonElement[]): Promise<void> {
    if (applyInFlight.has(candidate.candidate_id)) return;
    applyInFlight.add(candidate.candidate_id);
    buttons.forEach((b) => { b.disabled = true; });

    try {
        const result = await repairMutualDeletion(candidate.ref_id_a, candidate.ref_id_b);
        showToast(
            result.repaired ? t('dupReview_manualRepairDone') : t('dupReview_manualRepairAlreadyDone'),
            4000
        );
        invalidatePendingCountAndRerenderSection();
        await refreshModalContents();
    } catch (err) {
        console.error('[duplicate-review] 手動修復に失敗:', err);
        showToast(t('dupReview_manualRepairError', (err as Error).message), 6000);
    } finally {
        applyInFlight.delete(candidate.candidate_id);
        buttons.forEach((b) => { b.disabled = false; });
    }
}

// ---------------------------------------------------------------------------
// 「自動判定ぶんをすべて適用」
// ---------------------------------------------------------------------------

/**
 * 対象候補を集めたら planBulkApply()（src/lib/duplicate-review.ts）へ渡し、連結成分単位で
 * 解決済みの更新計画を作る（Issue #147）。候補ごとに独立して chooseKeptRefId()
 * で残す側を決めていた旧実装は、同一DOIの3件 A/B/C から出る A-B・A-C の2ペアで
 * duplicate_of[A] に2回書き込む事故があったため、この形に置き換えた。
 */
async function handleBulkApply(buttons: HTMLButtonElement[]): Promise<void> {
    if (bulkApplyInFlight) return;
    bulkApplyInFlight = true;
    buttons.forEach((b) => { b.disabled = true; });

    try {
        const [refs, candidates, decisionsData] = await Promise.all([
            getReferences(state.spreadsheetId),
            getDuplicateCandidates(state.spreadsheetId),
            getDecisions(state.spreadsheetId),
        ]);
        const refsById = buildRefsById(refs);
        const decisionCounts = buildDecisionCounts(decisionsData.map((d) => ({ decision: d.decision })));

        const planInputs: BulkApplyCandidateInput[] = [];

        for (const candidate of candidates) {
            if (candidate.status !== 'suggested') continue;
            if (isPairAlreadySettled(candidate, refsById)) continue;

            const survivorA = resolveSurvivor(candidate.ref_id_a, refsById);
            const survivorB = resolveSurvivor(candidate.ref_id_b, refsById);
            if (survivorA.broken || survivorB.broken) continue;

            const refA = refsById.get(survivorA.refId);
            const refB = refsById.get(survivorB.refId);
            if (!refA || !refB) continue;

            if (!isAutoApplicableCandidate(candidate.match_type, refA, refB)) continue;

            planInputs.push({ candidateId: candidate.candidate_id, refIdA: refA.ref_id, refIdB: refB.ref_id });
        }

        if (planInputs.length === 0) {
            showToast(t('dupReview_bulkApplyNone'), 4000);
            return;
        }

        const plan = planBulkApply(planInputs, (refId) => nonAiCountOf(decisionCounts, refId));

        try {
            await setDuplicateOf(state.spreadsheetId, plan.duplicateOfUpdates);
        } catch (err) {
            console.error('[duplicate-review] 一括適用のsetDuplicateOfに失敗:', err);
            showToast(t('dupReview_bulkApplyError', (err as Error).message), 8000);
            return;
        }

        let statusUpdateOk = true;
        try {
            await updateDuplicateCandidateStatus(
                state.spreadsheetId,
                plan.statusUpdates.map((update) => ({
                    candidateId: update.candidateId,
                    status: 'merged' as const,
                    decidedBy: state.userEmail,
                    keptRefId: update.keptRefId,
                }))
            );
        } catch (err) {
            console.error('[duplicate-review] 一括適用のupdateDuplicateCandidateStatusに失敗:', err);
            statusUpdateOk = false;
        }

        invalidatePendingCountAndRerenderSection();
        await refreshModalContents();

        const messages = [
            statusUpdateOk
                ? t('dupReview_bulkApplyDone', String(plan.statusUpdates.length))
                : t('dupReview_bulkApplyPartialError', String(plan.statusUpdates.length)),
        ];
        let reloadOk = true;
        if (deps) {
            // applyPairDecision() と同じ理由で個別の try/catch にする。ここで throw させると、
            // setDuplicateOf / updateDuplicateCandidateStatus は成功しているのに外側catchの
            // dupReview_bulkApplyError（「一括適用に失敗しました」）が出て、実際には
            // 書き込み済みの作業を失敗として報告してしまう。
            try {
                await deps.reloadAfterApply();
            } catch (err) {
                console.error('[duplicate-review] 一括適用後の reloadAfterApply に失敗:', err);
                reloadOk = false;
                messages.push(t('dupReview_reloadAfterApplyFailed'));
            }
        } else {
            messages.push(t('dupReview_depsMissing'));
        }
        showToast(messages.join(' / '), statusUpdateOk && deps && reloadOk ? 4000 : 8000);
    } catch (err) {
        // deps.reloadAfterApply() の失敗はここには流れてこない（上の個別try/catchが拾う）。
        console.error('[duplicate-review] 一括適用に失敗:', err);
        showToast(t('dupReview_bulkApplyError', (err as Error).message), 8000);
    } finally {
        bulkApplyInFlight = false;
        buttons.forEach((b) => { b.disabled = false; });
    }
}

// ---------------------------------------------------------------------------
// 再スキャン
// ---------------------------------------------------------------------------

/**
 * References 全件を再スキャンして重複候補を保存する（セクションの「重複を再スキャン」ボタン）。
 *
 * 保存自体の除外（既出の組を弾く）は saveDuplicateCandidates() 内部の filterNewDuplicatePairs()
 * に任せる（ここで自前の除外ロジックを書かない）。ただしトースト文言で「新規に見つかった件数」を
 * 報告する必要があるため、同じ filterNewDuplicatePairs() を再利用して件数だけ事前に確認する
 * （保存先の判断自体は書き換えない。既存候補の再取得と保存の間にわずかな競合余地はあるが、
 * このUI操作の頻度・実害を踏まえて許容する）。
 */
export async function rescanDuplicates(): Promise<void> {
    if (!state.spreadsheetId) return;
    if (rescanInFlight) return;
    rescanInFlight = true;
    showLoading(true);

    try {
        const spreadsheetId = state.spreadsheetId;
        const [refs, existingCandidates] = await Promise.all([
            getReferences(spreadsheetId),
            getDuplicateCandidates(spreadsheetId),
        ]);
        const pairs = scanReferencesForDuplicatePairs(refs);
        const newPairs = filterNewDuplicatePairs(existingCandidates, pairs);

        await saveDuplicateCandidates(spreadsheetId, pairs);

        invalidatePendingCountAndRerenderSection();

        // 新規0件のときも必ず1行出す（サイレント成功を作らない）
        showToast(
            newPairs.length > 0
                ? t('dupReview_rescanDone', String(newPairs.length))
                : t('dupReview_rescanNone'),
            4000
        );
    } catch (err) {
        console.error('[duplicate-review] 再スキャンに失敗:', err);
        showToast(t('dupReview_rescanError', (err as Error).message), 6000);
    } finally {
        rescanInFlight = false;
        showLoading(false);
    }
}
