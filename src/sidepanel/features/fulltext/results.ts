/**
 * フルテキスト結果ビュー
 * 候補プールに対する各判定者（ヒト／AI）のフルテキスト判定をまとめ、
 *  - 集計に使う判定者をチェックボックスで選択（最小1人）
 *  - 組み入れは選択判定者の OR（誰か1人でも Include なら組み入れ）
 *  - 判定者間の不一致を検出・表示
 *  - PRISMA フルテキスト相の集計（候補→入手済→include/exclude/maybe、除外理由内訳）
 *  - CSV / RIS エクスポート（不一致がある場合は確認ポップアップ）
 * を提供する。
 *
 * データ供給:
 *  - キー開封後: ref.allFulltextDecisions（全レビュアー＋有効LLMの全文相判定）
 *  - キー未開封: ref.myFulltextDecision（自分の判定のみ）にフォールバック
 */

import { dom } from './dom';
import { dom as sharedDom } from '../../dom';
import { state } from '../../state';
import { t } from '../../../lib/i18n';
import { escapeHtml } from '../../utils/text';
import { escapeCSVField } from '../../utils/csv';
import { getProjectFulltextCandidateList } from '../screening/filters';
import { getReviewerLabel } from '../screening/reviewer-utils';
import { voteNoteText } from '../screening/decision-summary';
import { handleKeyToggle } from '../screening/actions';
import { showToast } from '../../ui/feedback';
import { renderFulltextAi } from './ai';
import { buildAdjudicationControls } from './adjudication';
import { excludeReasonLabel } from '../../../lib/exclude-reasons';
import { identificationRouteOf, splitByIdentificationRoute } from '../../../lib/identification-route';
import {
    computeFulltextConsensus,
    isAdjudicationKey,
} from '../../../lib/fulltext-consensus';
import type { ConsensusDecision, FulltextVote, FulltextConsensusResult } from '../../../lib/fulltext-consensus';
import {
    fulltextRetrievalStatus as retrievalStatus,
    judgeDecisionMap,
    collectFulltextJudges,
    effectiveFulltextJudges,
    buildFulltextVotesForConsensus as buildVotesForConsensus,
    getFulltextConsensus,
    summarizeFulltextCandidates as summarize,
    getFulltextResultsSummaryByRoute as libGetFulltextResultsSummaryByRoute,
} from '../../../lib/fulltext-results-summary';
import type { FulltextResultsSummary } from '../../../lib/fulltext-results-summary';
import type {
    ReferenceWithStatus,
} from '../../../lib/types';

const DECISION_ICON: Record<ConsensusDecision, string> = {
    include: '✓',
    exclude: '✕',
    maybe: '?',
    pending: '・',
};

// モジュールローカルUI状態
type FulltextViewMode = 'list' | 'ai' | 'results';
let currentMode: FulltextViewMode = 'list';
let resultsMode = false; // currentMode === 'results' のキャッシュ（既存呼び出し互換）
// 選択中の判定者キー（null = 既定で全員）。空集合は「全解除」状態として保持しない（最小1人）。
let enabledJudges: Set<string> | null = null;

// キー開閉後にフルテキストタブ全体を再描画するためのコールバック（fulltext/tab.ts から注入）
let _rerenderTab: (() => void) | null = null;
export function setFulltextResultsDeps(deps: { rerenderTab: () => void }): void {
    _rerenderTab = deps.rerenderTab;
}

export function isFulltextResultsMode(): boolean {
    return resultsMode;
}

/**
 * 結果ビューの判定者チェックボックス選択の現在値（未訪問・全解除は null）を返す。
 * features/manuscript.ts（初期バンドル）は本体未ロード時 null しか読めないため、
 * features/fulltext/lazy.ts 経由の委譲（本体ロード済みならこの値、未ロードなら null）で
 * 論文用テキスト生成の集計に反映する（フルテキストタブ未訪問時は従来どおり全員集計になる）。
 */
export function getEnabledJudgesSnapshot(): Set<string> | null {
    return enabledJudges ? new Set(enabledJudges) : null;
}

function reasonLabel(reason: string): string {
    if (!reason) return '(理由未記入)';
    return excludeReasonLabel(reason, state.excludeReasonItems);
}

/**
 * 判定者選択・除外理由リストは module-local な `enabledJudges`（チェックボックス選択）と
 * `state` に依存するため、`src/lib/fulltext-results-summary.ts` の純関数へ `state` の
 * 該当フィールドを渡す薄いラッパーとしてここに置く（judgeDecisionMap・
 * buildFulltextVotesForConsensus 等の純粋計算そのものはlib側にある）。
 */
function collectJudges(candidates: ReferenceWithStatus[]): string[] {
    return collectFulltextJudges(candidates, state.userEmail);
}

/** 有効な判定者集合（全候補の判定者と enabledJudges の積。空なら全員にフォールバック） */
function effectiveJudges(allJudges: string[]): Set<string> {
    return effectiveFulltextJudges(allJudges, enabledJudges);
}

/** 選択判定者＋裁定票から合議結果を計算する（表示・エクスポート双方の唯一の入口） */
function getConsensus(ref: ReferenceWithStatus, judges: Set<string>): FulltextConsensusResult {
    return getFulltextConsensus(ref, judges, state.excludeReasonItems);
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

export function renderFulltextResults(): void {
    if (!resultsMode) return;
    const candidates = getProjectFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);

    renderJudgeSelector(allJudges, judges);
    renderPrisma(candidates, judges);
    renderConflicts(candidates, judges);
    renderResultsList(candidates, judges);
}

function renderJudgeSelector(allJudges: string[], effective: Set<string>): void {
    // ブラインド解除トグル（admin のみ表示・状態同期）
    dom.fulltextBlindRow.classList.toggle('hidden', !state.isAdmin);
    dom.fulltextKeyToggle.checked = state.isKeyOpened;

    const list = dom.fulltextJudgeList;
    list.innerHTML = '';

    // キー未開封時は自分のみ＝判定者選択の意味が薄いので注記
    const blind = !state.isKeyOpened;
    dom.fulltextJudgeHint.classList.toggle('hidden', !blind);
    if (blind) {
        dom.fulltextJudgeHint.textContent = t('fulltext_resultsJudgesBlind');
    }

    for (const key of allJudges) {
        const item = document.createElement('label');
        item.className = 'fulltext-judge-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = effective.has(key);
        checkbox.dataset.judge = key;
        checkbox.addEventListener('change', () => handleJudgeToggle(allJudges, key, checkbox.checked));

        const span = document.createElement('span');
        span.textContent = getReviewerLabel(key, state.userEmail);
        if (key.startsWith('llm:')) span.classList.add('reviewer-llm');

        item.appendChild(checkbox);
        item.appendChild(span);
        list.appendChild(item);
    }
}

function handleJudgeToggle(allJudges: string[], key: string, checked: boolean): void {
    // 初回操作時は現状（全員）を実体化してから増減
    if (!enabledJudges) enabledJudges = new Set(allJudges);
    if (checked) {
        enabledJudges.add(key);
    } else {
        // 最小1人を保証
        const remaining = allJudges.filter(j => enabledJudges!.has(j) && j !== key);
        if (remaining.length === 0) {
            showToast(t('fulltext_exportNoJudge'), 3000);
            renderFulltextResults();
            return;
        }
        enabledJudges.delete(key);
    }
    renderFulltextResults();
}

/**
 * 現在の判定者選択に基づくフルテキスト相サマリを返す（論文用テキスト生成で使用）。
 *
 * database 腕（データベース検索由来）だけを集計する。Registry linkage 行
 * （related_ref_id 非空）はここに混ぜない（Issue #120: 二重計上防止）。
 * Registry linkage 行を含む集計が必要な場合は getFulltextResultsSummaryByRoute() を使う。
 */
export function getFulltextResultsSummary(): FulltextResultsSummary {
    return getFulltextResultsSummaryByRoute().database;
}

/**
 * フルテキスト相サマリを同定経路（database / registryLinkage）別に分けて返す。
 * PRISMA の「other methods」腕（レジストリ連携由来）の集計に使う（Issue #120）。
 *
 * 集計の純粋計算は src/lib/fulltext-results-summary.ts（getFulltextResultsSummaryByRoute）へ
 * 切り出した（Issue #155（#150 工程4）。features/manuscript.ts が初期バンドルのまま同じ集計を
 * 呼べるようにするため）。ここでは module-local な判定者選択（enabledJudges）と state を
 * 渡すだけの薄いラッパー。
 */
export function getFulltextResultsSummaryByRoute(): {
    database: FulltextResultsSummary;
    registryLinkage: FulltextResultsSummary;
} {
    const candidates = getProjectFulltextCandidateList();
    return libGetFulltextResultsSummaryByRoute(candidates, {
        enabledJudges,
        excludeReasonItems: state.excludeReasonItems,
        userEmail: state.userEmail,
    });
}

function renderPrisma(candidates: ReferenceWithStatus[], judges: Set<string>): void {
    // database 腕とother methods腕（Registry linkage由来）に分けて集計する（Issue #120）。
    // registryLinkage が0件のときは database === candidates なので、以下の出力は現行と
    // 1文字も変わらない。
    const { database, registryLinkage } = splitByIdentificationRoute(candidates);
    const s = summarize(database, judges, state.excludeReasonItems);
    const { sought: total, obtained, include: inc, exclude: exc, maybe, pending: pend, unresolved } = s;

    const lines: string[] = [];
    lines.push(`<div class="fulltext-prisma-title">${escapeHtml(t('fulltext_prismaTitle'))}</div>`);
    lines.push('<div class="fulltext-prisma-grid">');
    lines.push(prismaCell(t('fulltext_prismaCandidates', String(total))));
    lines.push(prismaCell(t('fulltext_prismaObtained', String(obtained))));
    lines.push(prismaCell(t('fulltext_prismaInclude', String(inc)), 'include'));
    lines.push(prismaCell(t('fulltext_prismaExclude', String(exc)), 'exclude'));
    lines.push(prismaCell(t('fulltext_prismaMaybe', String(maybe)), 'maybe'));
    lines.push(prismaCell(t('fulltext_prismaPending', String(pend)), 'pending'));
    // 「不一致」は裁定済みなら完了扱いにするため、生の conflict ではなく未解消件数を出す
    if (unresolved > 0) lines.push(prismaCell(t('fulltext_prismaUnresolved', String(unresolved)), 'conflict'));
    lines.push('</div>');

    if (s.reasons.length > 0) {
        lines.push(`<div class="fulltext-prisma-reasons-head">${escapeHtml(t('fulltext_prismaExclReasons'))}</div>`);
        lines.push('<ul class="fulltext-prisma-reasons">');
        for (const { reason, count } of s.reasons) {
            lines.push(`<li>${escapeHtml(reasonLabel(reason))}: ${count}</li>`);
        }
        lines.push('</ul>');
    }

    // other methods腕（Registry linkage）: 該当0件なら何も追加しない
    // （registryLinkage.length === 0 のとき rl.sought は必ず0になる）。
    if (registryLinkage.length > 0) {
        const rl = summarize(registryLinkage, judges, state.excludeReasonItems);
        if (rl.sought > 0) {
            lines.push(`<div class="fulltext-prisma-title">${escapeHtml(t('fulltext_prismaOtherMethodsTitle'))}</div>`);
            lines.push('<div class="fulltext-prisma-grid">');
            lines.push(prismaCell(t('fulltext_prismaOtherMethodsIdentified', String(rl.sought))));
            lines.push(prismaCell(t('fulltext_prismaOtherMethodsObtained', String(rl.obtained))));
            lines.push(prismaCell(t('fulltext_prismaOtherMethodsExclude', String(rl.exclude)), 'exclude'));
            lines.push(prismaCell(t('fulltext_prismaOtherMethodsInclude', String(rl.include)), 'include'));
            lines.push('</div>');

            if (rl.reasons.length > 0) {
                lines.push(`<div class="fulltext-prisma-reasons-head">${escapeHtml(t('fulltext_prismaExclReasons'))}</div>`);
                lines.push('<ul class="fulltext-prisma-reasons">');
                for (const { reason, count } of rl.reasons) {
                    lines.push(`<li>${escapeHtml(reasonLabel(reason))}: ${count}</li>`);
                }
                lines.push('</ul>');
            }
        }
    }

    dom.fulltextPrismaDiv.innerHTML = lines.join('');
}

function prismaCell(text: string, cls = ''): string {
    return `<div class="fulltext-prisma-cell ${cls}">${escapeHtml(text)}</div>`;
}

function renderResultsList(candidates: ReferenceWithStatus[], judges: Set<string>): void {
    const listDiv = dom.fulltextResultsListDiv;
    listDiv.innerHTML = '';

    if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'fulltext-empty';
        empty.textContent = t('fulltext_resultEmpty');
        listDiv.appendChild(empty);
        return;
    }

    const orderedJudges = [...judges].sort((a, b) => {
        const al = a.startsWith('llm:') ? 1 : 0;
        const bl = b.startsWith('llm:') ? 1 : 0;
        if (al !== bl) return al - bl;
        return a.localeCompare(b);
    });

    for (const ref of candidates) {
        listDiv.appendChild(buildResultRow(ref, orderedJudges));
    }
}

function buildResultRow(ref: ReferenceWithStatus, orderedJudges: string[]): HTMLElement {
    const judgeSet = new Set(orderedJudges);
    const c = getConsensus(ref, judgeSet);
    const map = judgeDecisionMap(ref);

    const row = document.createElement('div');
    row.className = `fulltext-result-row consensus-${c.decision}`;

    const metaParts: string[] = [];
    if (ref.year) metaParts.push(String(ref.year));
    if (ref.journal) metaParts.push(ref.journal);

    // 各判定者のミニチップ
    const chips = orderedJudges.map(key => {
        const d = map.get(key);
        const dec = (d?.decision as ConsensusDecision) ?? 'pending';
        const label = getReviewerLabel(key, state.userEmail);
        return `<span class="fulltext-judge-chip chip-${dec}" title="${escapeHtml(label)}">${DECISION_ICON[dec]}</span>`;
    }).join('');

    // 裁定済みなら解決済みバッジのみ、未裁定なら判定不一致・理由不一致を区別して出す
    let badges = '';
    if (c.adjudicated) {
        badges = `<span class="fulltext-result-adjudicated">${escapeHtml(t('fulltext_conflictResolved'))}</span>`;
    } else {
        if (c.conflict) badges += `<span class="fulltext-result-conflict">${escapeHtml(t('fulltext_resultConflictBadge'))}</span>`;
        if (c.reasonConflict) badges += `<span class="fulltext-result-reason-conflict">${escapeHtml(t('fulltext_resultReasonConflictBadge'))}</span>`;
    }

    const reasonLine = c.decision === 'exclude' && c.primaryReason
        ? `<span class="fulltext-result-reason">${escapeHtml(reasonLabel(c.primaryReason))}</span>`
        : '';

    row.innerHTML = `
        <span class="fulltext-result-consensus ${c.decision}">${DECISION_ICON[c.decision]}</span>
        <span class="fulltext-result-body">
            <span class="fulltext-result-title">${escapeHtml(ref.title || ref.ref_id)}</span>
            <span class="fulltext-result-meta">${escapeHtml(metaParts.join(' · '))}</span>
            <span class="fulltext-result-footer">${badges}${reasonLine}<span class="fulltext-result-chips">${chips}</span></span>
        </span>
    `;

    // 行クリックでフルテキストページ（PDF＋AIハイライト）を新規タブで開く
    row.classList.add('fulltext-result-clickable');
    row.title = t('fulltext_resultOpenHint');
    row.addEventListener('click', () => {
        const url = chrome.runtime.getURL('fulltext/fulltext.html') + `?ref_id=${encodeURIComponent(ref.ref_id)}`;
        chrome.tabs.create({ url });
    });
    return row;
}

// ---------------------------------------------------------------------------
// 不一致の解消（判定後レビュー内の新セクション）
//
// キー開封後（state.isKeyOpened）だけ表示する。ブラインド中は他レビュアーの人間票が
// そもそもクライアントに配られない（filterDecisionsForBlind）ため、不一致の検出自体が成立しない。
//
// 一覧は「判定不一致・理由不一致のいずれかがある文献」を対象にする（裁定済みも含む）。
// 裁定前は「未解決」、裁定済みは裁定者・日時を表示し、その場でやり直し（再確定）もできる。
// ---------------------------------------------------------------------------

function decisionText(d: ConsensusDecision): string {
    switch (d) {
        case 'include': return t('fulltext_conflictDecisionInclude');
        case 'exclude': return t('fulltext_conflictDecisionExclude');
        case 'maybe': return t('fulltext_conflictDecisionMaybe');
        default: return t('fulltext_conflictDecisionPending');
    }
}

function formatAdjudicatedAt(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function renderConflicts(candidates: ReferenceWithStatus[], judges: Set<string>): void {
    const host = dom.fulltextConflictsDiv;
    const listDiv = dom.fulltextConflictsListDiv;
    const summaryDiv = dom.fulltextConflictsSummaryDiv;

    const visible = state.isKeyOpened;
    host.classList.toggle('hidden', !visible);
    if (!visible) {
        listDiv.innerHTML = '';
        summaryDiv.textContent = '';
        return;
    }

    const items = candidates
        .map(ref => {
            const votes = buildVotesForConsensus(ref, judges);
            return { ref, votes, consensus: computeFulltextConsensus(votes, state.excludeReasonItems) };
        })
        .filter(({ consensus }) => consensus.conflict || consensus.reasonConflict);

    // 未解決を先に出す
    items.sort((a, b) => Number(b.consensus.unresolved) - Number(a.consensus.unresolved));

    const unresolvedCount = items.filter(i => i.consensus.unresolved).length;
    summaryDiv.textContent = t('fulltext_conflictsSummary', [String(unresolvedCount), String(items.length)]);

    listDiv.innerHTML = '';
    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'fulltext-conflicts-empty';
        empty.textContent = t('fulltext_conflictsEmpty');
        listDiv.appendChild(empty);
        return;
    }

    for (const { ref, votes, consensus } of items) {
        listDiv.appendChild(buildConflictItem(ref, votes, consensus));
    }
}

function buildConflictItem(
    ref: ReferenceWithStatus,
    votes: FulltextVote[],
    consensus: FulltextConsensusResult
): HTMLElement {
    const details = document.createElement('details');
    details.className = `fulltext-conflict-item ${consensus.unresolved ? 'unresolved' : 'resolved'}`;

    const summary = document.createElement('summary');
    summary.className = 'fulltext-conflict-summary';
    const badgeParts: string[] = [];
    badgeParts.push(consensus.unresolved
        ? `<span class="fulltext-conflict-status status-unresolved">${escapeHtml(t('fulltext_conflictUnresolved'))}</span>`
        : `<span class="fulltext-conflict-status status-resolved">${escapeHtml(t('fulltext_conflictResolved'))}</span>`);
    if (consensus.conflict) {
        badgeParts.push(`<span class="fulltext-conflict-badge badge-decision">${escapeHtml(t('fulltext_resultConflictBadge'))}</span>`);
    }
    if (consensus.reasonConflict) {
        badgeParts.push(`<span class="fulltext-conflict-badge badge-reason">${escapeHtml(t('fulltext_resultReasonConflictBadge'))}</span>`);
    }
    summary.innerHTML = `
        <span class="fulltext-conflict-title">${escapeHtml(ref.title || ref.ref_id)}</span>
        <span class="fulltext-conflict-badges">${badgeParts.join('')}</span>
    `;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'fulltext-conflict-body';

    // 各判定者の判定・理由・メモを並べて表示（裁定票自体は「判定者」として出さず、下の裁定済み情報で示す）
    const voteList = document.createElement('div');
    voteList.className = 'fulltext-conflict-votes';
    for (const v of votes) {
        if (isAdjudicationKey(v.judge)) continue;
        const row = document.createElement('div');
        row.className = `fulltext-conflict-vote-row vote-${v.decision}`;
        const noteText = voteNoteText(v.judge, v.note);
        row.innerHTML = `
            <span class="fulltext-conflict-vote-judge">${escapeHtml(getReviewerLabel(v.judge, state.userEmail))}</span>
            <span class="fulltext-conflict-vote-decision">${DECISION_ICON[v.decision]} ${escapeHtml(decisionText(v.decision))}</span>
            ${v.decision === 'exclude' && v.reason ? `<span class="fulltext-conflict-vote-reason">${escapeHtml(reasonLabel(v.reason))}</span>` : ''}
            ${noteText ? `<span class="fulltext-conflict-vote-note">${escapeHtml(noteText)}</span>` : ''}
        `;
        voteList.appendChild(row);
    }
    body.appendChild(voteList);

    if (consensus.adjudicated) {
        const info = document.createElement('div');
        info.className = 'fulltext-conflict-adjudicated-info';
        info.textContent = t('fulltext_conflictAdjudicatedBy', [
            consensus.adjudicatedBy || '',
            formatAdjudicatedAt(consensus.adjudicatedAt),
        ]);
        body.appendChild(info);
        if (consensus.adjudicationMemo) {
            const memo = document.createElement('div');
            memo.className = 'fulltext-conflict-adjudicated-memo';
            memo.textContent = `${t('fulltext_conflictMemoLabel')}: ${consensus.adjudicationMemo}`;
            body.appendChild(memo);
        }
    }

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-small btn-secondary fulltext-conflict-open-btn';
    openBtn.textContent = t('fulltext_conflictOpenPdf');
    openBtn.addEventListener('click', () => {
        const url = chrome.runtime.getURL('fulltext/fulltext.html') + `?ref_id=${encodeURIComponent(ref.ref_id)}`;
        chrome.tabs.create({ url });
    });
    body.appendChild(openBtn);

    body.appendChild(buildAdjudicationControls(ref, votes, consensus.adjudicated, consensus.adjudicationMemo, renderFulltextResults));

    details.appendChild(body);
    return details;
}

// ---------------------------------------------------------------------------
// エクスポート
// ---------------------------------------------------------------------------

function dateStamp(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function downloadBlob(content: string, filename: string, type: string): void {
    const bom = '﻿';
    const blob = new Blob([bom + content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** エクスポート前の共通チェック（候補有無・判定者有無・不一致確認） */
function preExportGuard(candidates: ReferenceWithStatus[], judges: Set<string>): boolean {
    if (candidates.length === 0) {
        showToast(t('fulltext_exportNoData'), 3000);
        return false;
    }
    if (judges.size === 0) {
        showToast(t('fulltext_exportNoJudge'), 3000);
        return false;
    }
    // 裁定済みの不一致は解消済みとして扱い、未解消のものだけを確認対象にする
    const unresolvedCount = candidates.filter(r => getConsensus(r, judges).unresolved).length;
    if (unresolvedCount > 0) {
        if (!window.confirm(t('fulltext_exportConflictConfirm', String(unresolvedCount)))) {
            return false;
        }
    }
    return true;
}

function handleExportCsv(): void {
    const candidates = getProjectFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);
    if (!preExportGuard(candidates, judges)) return;

    const orderedJudges = [...judges];
    const judgeLabels = orderedJudges.map(j => getReviewerLabel(j, state.userEmail));

    // 追加列は既存の固定列・判定者列のインデックスをずらさないよう末尾へ足す。
    // adjudication_memo は identification_route（Issue #120: database / registry_linkage）の後に置く。
    const headers = [
        'ref_id', 'title', 'year', 'journal', 'doi', 'pmid',
        'fulltext_status', 'consensus', 'conflict', 'reason_conflict', 'adjudicated', 'adjudicated_by',
        'exclusion_reason', 'note',
        ...judgeLabels,
        'identification_route',
        'adjudication_memo',
    ];
    const rows: string[] = [headers.map(escapeCSVField).join(',')];

    for (const ref of candidates) {
        const c = getConsensus(ref, judges);
        const map = judgeDecisionMap(ref);
        const note = c.excludeReasons.map(r => voteNoteText(r.judge, r.note)).filter(Boolean).join(' / ');
        const base = [
            ref.ref_id,
            ref.title || '',
            ref.year ? String(ref.year) : '',
            ref.journal || '',
            ref.doi || '',
            ref.pmid || '',
            retrievalStatus(ref),
            c.decision,
            c.conflict ? 'yes' : 'no',
            c.reasonConflict ? 'yes' : 'no',
            c.adjudicated ? 'yes' : 'no',
            c.adjudicatedBy || '',
            c.primaryReason,
            note,
        ];
        const perJudge = orderedJudges.map(j => map.get(j)?.decision ?? '');
        rows.push([...base, ...perJudge, identificationRouteOf(ref), c.adjudicationMemo || ''].map(escapeCSVField).join(','));
    }

    const filename = `fulltext_results_${dateStamp()}_${candidates.length}.csv`;
    downloadBlob(rows.join('\r\n'), filename, 'text/csv;charset=utf-8');
    showToast(t('fulltext_exportCsvDone', String(candidates.length)), 3000);
}

function handleExportRis(): void {
    const candidates = getProjectFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);
    if (!preExportGuard(candidates, judges)) return;

    // RIS は最終的な組み入れ集合（裁定があればそれを優先、無ければOR合議で include）を出力
    const included = candidates.filter(r => getConsensus(r, judges).decision === 'include');
    if (included.length === 0) {
        showToast(t('fulltext_exportNoData'), 3000);
        return;
    }

    const lines: string[] = [];
    for (const ref of included) {
        lines.push('TY  - JOUR');
        if (ref.title) lines.push(`TI  - ${ref.title}`);
        if (ref.authors) {
            for (const author of ref.authors.split(/[;,]\s*/).filter(Boolean)) {
                lines.push(`AU  - ${author}`);
            }
        }
        if (ref.journal) lines.push(`JO  - ${ref.journal}`);
        if (ref.year) lines.push(`PY  - ${ref.year}`);
        if (ref.volume) lines.push(`VL  - ${ref.volume}`);
        if (ref.issue) lines.push(`IS  - ${ref.issue}`);
        if (ref.pages) lines.push(`SP  - ${ref.pages}`);
        if (ref.doi) lines.push(`DO  - ${ref.doi}`);
        if (ref.pmid) lines.push(`AN  - ${ref.pmid}`);
        if (ref.abstract) lines.push(`AB  - ${ref.abstract}`);
        if (ref.fulltext_url) lines.push(`UR  - ${ref.fulltext_url}`);
        lines.push('ER  - ');
        lines.push('');
    }

    const filename = `fulltext_included_${dateStamp()}_${included.length}.ris`;
    downloadBlob(lines.join('\r\n'), filename, 'application/x-research-info-systems');
    showToast(t('fulltext_exportRisDone', String(included.length)), 3000);
}

// ---------------------------------------------------------------------------
// ビュー切替・イベント
// ---------------------------------------------------------------------------

/** 候補リスト / AI判定 / 判定後レビュー の表示を切り替える */
function applyModeVisibility(): void {
    const section = sharedDom.fulltextSection;
    const retrieval = section.querySelector('.fulltext-retrieval');
    const filterRow = section.querySelector('.fulltext-filter-row');
    const isList = currentMode === 'list';
    const isAi = currentMode === 'ai';
    const isResults = currentMode === 'results';

    // 候補リスト系ブロック（取得・フィルタ・一覧）は list モードのみ表示
    retrieval?.classList.toggle('hidden', !isList);
    filterRow?.classList.toggle('hidden', !isList);
    dom.fulltextListDiv.classList.toggle('hidden', !isList);
    dom.fulltextAiDiv.classList.toggle('hidden', !isAi);
    dom.fulltextResultsDiv.classList.toggle('hidden', !isResults);

    dom.fulltextModeListBtn.classList.toggle('active', isList);
    dom.fulltextModeAiBtn.classList.toggle('active', isAi);
    dom.fulltextModeResultsBtn.classList.toggle('active', isResults);
}

export function setFulltextMode(mode: FulltextViewMode): void {
    currentMode = mode;
    resultsMode = mode === 'results';
    applyModeVisibility();
    if (mode === 'results') renderFulltextResults();
    else if (mode === 'ai') renderFulltextAi();
}

/**
 * ブラインド解除トグル。
 * 既存の screening 用 handleKeyToggle を再利用し、全タブ共有の isKeyOpened を更新する。
 * （handleKeyToggle は screening 側のチェックボックス sharedDom.keyToggleInput を正とするため、
 *  先にその状態を合わせてから呼び、完了後に実状態へ同期する）
 */
async function handleBlindToggle(): Promise<void> {
    const open = dom.fulltextKeyToggle.checked;
    sharedDom.keyToggleInput.checked = open;
    await handleKeyToggle();
    // handleKeyToggle はキャンセル/失敗時に元状態へ戻すため、実状態へ同期
    dom.fulltextKeyToggle.checked = state.isKeyOpened;
    // データが再読込されている可能性があるためタブ全体を再描画
    if (_rerenderTab) _rerenderTab();
    else renderFulltextResults();
}

export function setupFulltextResultsListeners(): void {
    dom.fulltextModeListBtn?.addEventListener('click', () => setFulltextMode('list'));
    dom.fulltextModeAiBtn?.addEventListener('click', () => setFulltextMode('ai'));
    dom.fulltextModeResultsBtn?.addEventListener('click', () => setFulltextMode('results'));
    dom.fulltextExportCsvBtn?.addEventListener('click', () => handleExportCsv());
    dom.fulltextExportRisBtn?.addEventListener('click', () => handleExportRis());
    dom.fulltextKeyToggle?.addEventListener('change', () => { void handleBlindToggle(); });
}
