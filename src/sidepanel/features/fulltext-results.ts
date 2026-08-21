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

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { escapeCSVField } from '../utils/csv';
import { getProjectFulltextCandidateList } from './screening/filters';
import { getReviewerLabel } from './screening/reviewer-utils';
import { voteNoteText } from './screening/decision-summary';
import { handleKeyToggle } from './screening/actions';
import { showToast } from '../ui/feedback';
import { renderFulltextAi, reloadReferences as reloadFulltextReferences } from './fulltext-ai';
import { excludeReasonLabel } from '../../lib/exclude-reasons';
import { getClientVersion } from '../../lib/client-version';
import { saveDecision } from '../../lib/sheets-api';
import {
    computeFulltextConsensus,
    isAdjudicationKey,
    adjudicationReviewerId,
} from '../../lib/fulltext-consensus';
import type { ConsensusDecision, FulltextVote, FulltextConsensusResult } from '../../lib/fulltext-consensus';
import type {
    ReferenceWithStatus,
    Decision,
    FulltextStatus,
    FulltextAdjudicationNote,
    FulltextAdjudicationVoteSnapshot,
} from '../../lib/types';

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

// キー開閉後にフルテキストタブ全体を再描画するためのコールバック（fulltext-tab から注入）
let _rerenderTab: (() => void) | null = null;
export function setFulltextResultsDeps(deps: { rerenderTab: () => void }): void {
    _rerenderTab = deps.rerenderTab;
}

export function isFulltextResultsMode(): boolean {
    return resultsMode;
}

function reasonLabel(reason: string): string {
    if (!reason) return '(理由未記入)';
    return excludeReasonLabel(reason, state.excludeReasonItems);
}

/** 入手状態（未記録は not_retrieved 扱い） */
function retrievalStatus(ref: ReferenceWithStatus): FulltextStatus {
    return ref.fulltext_status ?? 'not_retrieved';
}

function isObtained(ref: ReferenceWithStatus): boolean {
    const s = retrievalStatus(ref);
    return (s === 'cached' || s === 'retrieved') && !!ref.fulltext_url;
}

/**
 * 文献ごとに「判定者キー → 最新のフルテキスト判定」をマップ化する。
 * キー開封後は allFulltextDecisions、未開封時は myFulltextDecision のみ。
 */
function judgeDecisionMap(ref: ReferenceWithStatus): Map<string, Decision> {
    const list: Decision[] =
        ref.allFulltextDecisions && ref.allFulltextDecisions.length > 0
            ? ref.allFulltextDecisions
            : ref.myFulltextDecision
                ? [ref.myFulltextDecision]
                : [];
    const map = new Map<string, Decision>();
    for (const d of list) {
        const key = (d.reviewer_id || '').trim();
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            map.set(key, d);
        }
    }
    return map;
}

/**
 * 全候補から判定者キーを収集（ヒトを先、AI(llm:)を後ろにソート）。
 * 裁定票（adjudication:）は判定者選択（チェックボックス）の対象から除外する。
 * ここでチェックを外せてしまうと、選択判定者に依存する合議計算から裁定票そのものが
 * 消えてしまい、裁定が無効化されてしまうため。
 */
function collectJudges(candidates: ReferenceWithStatus[]): string[] {
    const set = new Set<string>();
    for (const r of candidates) {
        for (const key of judgeDecisionMap(r).keys()) {
            if (isAdjudicationKey(key)) continue;
            set.add(key);
        }
    }
    if (set.size === 0 && state.userEmail) set.add(state.userEmail);
    return [...set].sort((a, b) => {
        const al = a.startsWith('llm:') ? 1 : 0;
        const bl = b.startsWith('llm:') ? 1 : 0;
        if (al !== bl) return al - bl;
        return a.localeCompare(b);
    });
}

/** 有効な判定者集合（全候補の判定者と enabledJudges の積。空なら全員にフォールバック） */
function effectiveJudges(allJudges: string[]): Set<string> {
    if (!enabledJudges) return new Set(allJudges);
    const eff = new Set(allJudges.filter(j => enabledJudges!.has(j)));
    if (eff.size === 0) return new Set(allJudges); // 安全弁（最小1人）
    return eff;
}

/**
 * ある文献について、合議計算（src/lib/fulltext-consensus.ts）に渡す票配列を組み立てる。
 * - 通常の判定者票: judges（チェックボックスで選択中の判定者集合）に含まれるものだけを渡す
 * - 裁定票（adjudication:）: judges の選択に関わらず常に含める
 *   （判定者選択のチェックボックスに出ないため、外して無効化される心配がない）
 */
function buildVotesForConsensus(ref: ReferenceWithStatus, judges: Set<string>): FulltextVote[] {
    const map = judgeDecisionMap(ref);
    const votes: FulltextVote[] = [];
    for (const [key, d] of map) {
        if (!isAdjudicationKey(key) && !judges.has(key)) continue;
        votes.push({ judge: key, decision: d.decision, reason: d.reason, note: d.note, decidedAt: d.decided_at });
    }
    return votes;
}

/** 選択判定者＋裁定票から合議結果を計算する（表示・エクスポート双方の唯一の入口） */
function getConsensus(ref: ReferenceWithStatus, judges: Set<string>): FulltextConsensusResult {
    return computeFulltextConsensus(buildVotesForConsensus(ref, judges), state.excludeReasonItems);
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
 * フルテキスト相の集計サマリ（結果ビューのPRISMA表示・論文用テキスト生成で共用）
 *
 * conflict と reasonConflict は意図的に別枠で持つ（決してマージしないこと）。
 * `conflict` は論文原稿の "Disagreements between screeners (n = …)" にそのまま使われる数値であり、
 * SR の報告慣行では screener 間の disagreement は組入/除外などの「判定」不一致を指す。
 * ここに理由だけの相違（reasonConflict）を混ぜると、論文で報告する数字の意味が変わってしまう。
 */
export interface FulltextResultsSummary {
    sought: number;        // 候補（Reports sought for retrieval）
    obtained: number;      // 入手済（Reports assessed for eligibility）
    notRetrieved: number;  // 未入手
    include: number;
    exclude: number;
    maybe: number;
    pending: number;
    conflict: number;       // 判定不一致のみ（裁定済みも含む生の件数）
    reasonConflict: number; // 理由不一致のみ（裁定済みも含む生の件数）。conflict とは合算しない
    unresolved: number;     // うち未解消（(conflict||reasonConflict) && !adjudicated）
    reasons: Array<{ reason: string; count: number }>;  // 除外理由（件数降順、生キー）
    judges: string[];      // 集計に使った判定者キー
}

function summarize(candidates: ReferenceWithStatus[], judges: Set<string>): FulltextResultsSummary {
    const obtained = candidates.filter(isObtained).length;

    let inc = 0, exc = 0, maybe = 0, pend = 0, conflict = 0, reasonConflict = 0, unresolved = 0;
    const reasonCounts = new Map<string, number>();
    for (const r of candidates) {
        const c = getConsensus(r, judges);
        if (c.conflict) conflict++;
        if (c.reasonConflict) reasonConflict++;
        if (c.unresolved) unresolved++;
        switch (c.decision) {
            case 'include': inc++; break;
            case 'exclude':
                exc++;
                reasonCounts.set(c.primaryReason, (reasonCounts.get(c.primaryReason) ?? 0) + 1);
                break;
            case 'maybe': maybe++; break;
            default: pend++;
        }
    }

    return {
        sought: candidates.length,
        obtained,
        notRetrieved: candidates.length - obtained,
        include: inc,
        exclude: exc,
        maybe,
        pending: pend,
        conflict,
        reasonConflict,
        unresolved,
        reasons: [...reasonCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => ({ reason, count })),
        judges: [...judges],
    };
}

/**
 * 現在の判定者選択に基づくフルテキスト相サマリを返す（論文用テキスト生成で使用）
 */
export function getFulltextResultsSummary(): FulltextResultsSummary {
    const candidates = getProjectFulltextCandidateList();
    const judges = effectiveJudges(collectJudges(candidates));
    return summarize(candidates, judges);
}

function renderPrisma(candidates: ReferenceWithStatus[], judges: Set<string>): void {
    const s = summarize(candidates, judges);
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

    body.appendChild(buildAdjudicationControls(ref, votes, consensus.adjudicated));

    details.appendChild(body);
    return details;
}

function buildAdjudicationControls(ref: ReferenceWithStatus, votes: FulltextVote[], alreadyAdjudicated: boolean): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fulltext-conflict-controls';

    const head = document.createElement('div');
    head.className = 'fulltext-conflict-controls-head';
    head.textContent = t(alreadyAdjudicated ? 'fulltext_conflictRedoHead' : 'fulltext_conflictResolveHead');
    wrap.appendChild(head);

    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'fulltext-conflict-controls-buttons';

    const btnInclude = document.createElement('button');
    btnInclude.type = 'button';
    btnInclude.className = 'btn btn-small btn-include';
    btnInclude.textContent = t('fulltext_conflictAdjudicateInclude');
    btnInclude.addEventListener('click', () => { void handleAdjudicate(ref, 'include', undefined, votes); });
    buttonsRow.appendChild(btnInclude);

    const btnMaybe = document.createElement('button');
    btnMaybe.type = 'button';
    btnMaybe.className = 'btn btn-small btn-maybe';
    btnMaybe.textContent = t('fulltext_conflictAdjudicateMaybe');
    btnMaybe.addEventListener('click', () => { void handleAdjudicate(ref, 'maybe', undefined, votes); });
    buttonsRow.appendChild(btnMaybe);

    wrap.appendChild(buttonsRow);

    // 除外理由の優先順位ルール（スクリーニング側 .ft-reason-priority-note と同趣旨）。
    // 最終的な理由を決める裁定の場面でこそ効くルールなので、理由セレクトの直前に明示する。
    const reasonPriorityNote = document.createElement('div');
    reasonPriorityNote.className = 'fulltext-conflict-reason-priority-note';
    reasonPriorityNote.textContent = t('fulltext_conflictReasonPriorityNote');
    wrap.appendChild(reasonPriorityNote);

    const excludeRow = document.createElement('div');
    excludeRow.className = 'fulltext-conflict-controls-exclude-row';

    const reasonSelect = document.createElement('select');
    reasonSelect.className = 'fulltext-conflict-reason-select';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = t('fulltext_conflictReasonPlaceholder');
    reasonSelect.appendChild(placeholderOpt);
    // 選択肢はプロジェクト設定（Config タブ fulltext_exclude_reasons）から。
    // スクリーニング側（fulltext.ts の renderReasonOptions）と同じ配列・同じ並び。
    state.excludeReasonItems.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = item.key;
        opt.textContent = `${idx + 1}. ${item.label}`;
        reasonSelect.appendChild(opt);
    });

    const btnExclude = document.createElement('button');
    btnExclude.type = 'button';
    btnExclude.className = 'btn btn-small btn-exclude';
    btnExclude.textContent = t('fulltext_conflictAdjudicateExclude');
    btnExclude.addEventListener('click', () => { void handleAdjudicate(ref, 'exclude', reasonSelect.value, votes); });

    excludeRow.appendChild(reasonSelect);
    excludeRow.appendChild(btnExclude);
    wrap.appendChild(excludeRow);

    return wrap;
}

/** 裁定を確定して保存する。裁定票は追記専用経路（-human-adjudication）に乗り、やり直しの履歴も残る。 */
async function handleAdjudicate(
    ref: ReferenceWithStatus,
    decision: 'include' | 'exclude' | 'maybe',
    reason: string | undefined,
    votes: FulltextVote[]
): Promise<void> {
    const email = state.userEmail;
    if (!email) return;

    if (decision === 'exclude' && !reason) {
        showToast(t('fulltext_conflictReasonRequired'), 3000);
        return;
    }

    const snapshot: FulltextAdjudicationVoteSnapshot[] = votes
        .filter(v => !isAdjudicationKey(v.judge))
        .map(v => ({ judge: v.judge, decision: v.decision, reason: v.reason, note: v.note }));

    const now = new Date().toISOString();
    const note: FulltextAdjudicationNote = {
        type: 'fulltext_adjudication',
        adjudicated_by: email,
        adjudicated_at: now,
        votes: snapshot,
    };

    const decisionObj: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: adjudicationReviewerId(email),
        decision,
        reason: decision === 'exclude' ? reason : undefined,
        note: JSON.stringify(note),
        decided_at: now,
        client_version: getClientVersion('-human-adjudication'),
        screening_phase: 'fulltext',
    };

    try {
        await saveDecision(state.spreadsheetId, decisionObj);
        showToast(t('fulltext_conflictAdjudicateSaved'), 3000);
        // 既存の参照再読込パターン（fulltext-ai.ts の reloadReferences）を再利用して state を更新し、
        // 合議表示（結果一覧・PRISMA・この不一致解消セクション自体）を最新化する
        await reloadFulltextReferences(state.spreadsheetId);
        renderFulltextResults();
    } catch (err) {
        console.error('[fulltext-results] adjudication save failed:', err);
        showToast(t('fulltext_conflictAdjudicateSaveFailed'), 4000);
    }
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

    const headers = [
        'ref_id', 'title', 'year', 'journal', 'doi', 'pmid',
        'fulltext_status', 'consensus', 'conflict', 'reason_conflict', 'adjudicated', 'adjudicated_by',
        'exclusion_reason', 'note',
        ...judgeLabels,
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
        rows.push([...base, ...perJudge].map(escapeCSVField).join(','));
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
    const section = dom.fulltextSection;
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
 * （handleKeyToggle は screening 側のチェックボックス dom.keyToggleInput を正とするため、
 *  先にその状態を合わせてから呼び、完了後に実状態へ同期する）
 */
async function handleBlindToggle(): Promise<void> {
    const open = dom.fulltextKeyToggle.checked;
    dom.keyToggleInput.checked = open;
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
