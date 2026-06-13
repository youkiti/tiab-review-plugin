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
import { getFulltextCandidateList } from './screening/filters';
import { getReviewerLabel } from './screening/reviewer-utils';
import { handleKeyToggle } from './screening/actions';
import { showToast } from '../ui/feedback';
import type { ReferenceWithStatus, Decision, FulltextStatus } from '../../lib/types';

type ConsensusDecision = 'include' | 'exclude' | 'maybe' | 'pending';

// PICOS 除外理由ラベル（fulltext.html の選択肢と一致）
const REASON_LABELS: Record<string, string> = {
    population: 'Population 不適合',
    intervention: 'Intervention 不適合',
    comparator: 'Comparator 不適合',
    outcome: 'Outcome 不適合',
    study_design: 'Study design 不適合',
    duplicate: '重複',
    other: 'その他',
};

const DECISION_ICON: Record<ConsensusDecision, string> = {
    include: '✓',
    exclude: '✕',
    maybe: '?',
    pending: '・',
};

// モジュールローカルUI状態
let resultsMode = false;
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
    return REASON_LABELS[reason] ?? reason;
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

/** 全候補から判定者キーを収集（ヒトを先、AI(llm:)を後ろにソート） */
function collectJudges(candidates: ReferenceWithStatus[]): string[] {
    const set = new Set<string>();
    for (const r of candidates) {
        for (const key of judgeDecisionMap(r).keys()) set.add(key);
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

interface Consensus {
    decision: ConsensusDecision;
    conflict: boolean;
    // 除外判定を出した判定者の理由（PRISMA内訳・CSV用）
    excludeReasons: Array<{ judge: string; reason: string; note?: string }>;
}

/**
 * 選択判定者の OR 合議。
 * - 誰か1人でも include → include
 * - そうでなく誰か maybe → maybe
 * - そうでなく誰か exclude → exclude
 * - 全員 pending/判定なし → pending
 * 不一致 = 非pendingの判定値が2種類以上
 */
function computeConsensus(ref: ReferenceWithStatus, judges: Set<string>): Consensus {
    const map = judgeDecisionMap(ref);
    const values = new Set<string>();
    const excludeReasons: Consensus['excludeReasons'] = [];
    for (const key of judges) {
        const d = map.get(key);
        if (!d || d.decision === 'pending') continue;
        values.add(d.decision);
        if (d.decision === 'exclude') {
            excludeReasons.push({ judge: key, reason: d.reason || '', note: d.note });
        }
    }
    let decision: ConsensusDecision = 'pending';
    if (values.has('include')) decision = 'include';
    else if (values.has('maybe')) decision = 'maybe';
    else if (values.has('exclude')) decision = 'exclude';
    return { decision, conflict: values.size >= 2, excludeReasons };
}

/** 除外記録の代表理由（最初の非空理由、無ければ other 相当の空） */
function representativeReason(c: Consensus): string {
    const withReason = c.excludeReasons.find(r => r.reason);
    return withReason ? withReason.reason : '';
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

export function renderFulltextResults(): void {
    if (!resultsMode) return;
    const candidates = getFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);

    renderJudgeSelector(allJudges, judges);
    renderPrisma(candidates, judges);
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

function renderPrisma(candidates: ReferenceWithStatus[], judges: Set<string>): void {
    const total = candidates.length;
    const obtained = candidates.filter(isObtained).length;

    let inc = 0, exc = 0, maybe = 0, pend = 0, conflict = 0;
    const reasonCounts = new Map<string, number>();
    for (const r of candidates) {
        const c = computeConsensus(r, judges);
        if (c.conflict) conflict++;
        switch (c.decision) {
            case 'include': inc++; break;
            case 'exclude':
                exc++;
                { const key = representativeReason(c);
                  reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1); }
                break;
            case 'maybe': maybe++; break;
            default: pend++;
        }
    }

    const lines: string[] = [];
    lines.push(`<div class="fulltext-prisma-title">${escapeHtml(t('fulltext_prismaTitle'))}</div>`);
    lines.push('<div class="fulltext-prisma-grid">');
    lines.push(prismaCell(t('fulltext_prismaCandidates', String(total))));
    lines.push(prismaCell(t('fulltext_prismaObtained', String(obtained))));
    lines.push(prismaCell(t('fulltext_prismaInclude', String(inc)), 'include'));
    lines.push(prismaCell(t('fulltext_prismaExclude', String(exc)), 'exclude'));
    lines.push(prismaCell(t('fulltext_prismaMaybe', String(maybe)), 'maybe'));
    lines.push(prismaCell(t('fulltext_prismaPending', String(pend)), 'pending'));
    if (conflict > 0) lines.push(prismaCell(t('fulltext_prismaConflict', String(conflict)), 'conflict'));
    lines.push('</div>');

    if (reasonCounts.size > 0) {
        lines.push(`<div class="fulltext-prisma-reasons-head">${escapeHtml(t('fulltext_prismaExclReasons'))}</div>`);
        lines.push('<ul class="fulltext-prisma-reasons">');
        for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
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
    const c = computeConsensus(ref, judgeSet);
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

    const conflictBadge = c.conflict
        ? `<span class="fulltext-result-conflict">${escapeHtml(t('fulltext_resultConflictBadge'))}</span>`
        : '';

    const reasonLine = c.decision === 'exclude' && representativeReason(c)
        ? `<span class="fulltext-result-reason">${escapeHtml(reasonLabel(representativeReason(c)))}</span>`
        : '';

    row.innerHTML = `
        <span class="fulltext-result-consensus ${c.decision}">${DECISION_ICON[c.decision]}</span>
        <span class="fulltext-result-body">
            <span class="fulltext-result-title">${escapeHtml(ref.title || ref.ref_id)}</span>
            <span class="fulltext-result-meta">${escapeHtml(metaParts.join(' · '))}</span>
            <span class="fulltext-result-footer">${conflictBadge}${reasonLine}<span class="fulltext-result-chips">${chips}</span></span>
        </span>
    `;
    return row;
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
    const conflicts = candidates.filter(r => computeConsensus(r, judges).conflict).length;
    if (conflicts > 0) {
        if (!window.confirm(t('fulltext_exportConflictConfirm', String(conflicts)))) {
            return false;
        }
    }
    return true;
}

function handleExportCsv(): void {
    const candidates = getFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);
    if (!preExportGuard(candidates, judges)) return;

    const orderedJudges = [...judges];
    const judgeLabels = orderedJudges.map(j => getReviewerLabel(j, state.userEmail));

    const headers = [
        'ref_id', 'title', 'year', 'journal', 'doi', 'pmid',
        'fulltext_status', 'consensus', 'conflict', 'exclusion_reason', 'note',
        ...judgeLabels,
    ];
    const rows: string[] = [headers.map(escapeCSVField).join(',')];

    for (const ref of candidates) {
        const c = computeConsensus(ref, judges);
        const map = judgeDecisionMap(ref);
        const note = c.excludeReasons.map(r => r.note).filter(Boolean).join(' / ');
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
            representativeReason(c),
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
    const candidates = getFulltextCandidateList();
    const allJudges = collectJudges(candidates);
    const judges = effectiveJudges(allJudges);
    if (!preExportGuard(candidates, judges)) return;

    // RIS は最終的な組み入れ集合（OR合議で include）を出力
    const included = candidates.filter(r => computeConsensus(r, judges).decision === 'include');
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

/** リスト関連ブロック ⇄ 結果ブロックの表示を切り替える */
function applyModeVisibility(): void {
    const section = dom.fulltextSection;
    const retrieval = section.querySelector('.fulltext-retrieval');
    const filterRow = section.querySelector('.fulltext-filter-row');
    retrieval?.classList.toggle('hidden', resultsMode);
    filterRow?.classList.toggle('hidden', resultsMode);
    dom.fulltextListDiv.classList.toggle('hidden', resultsMode);
    dom.fulltextResultsDiv.classList.toggle('hidden', !resultsMode);

    dom.fulltextModeListBtn.classList.toggle('active', !resultsMode);
    dom.fulltextModeResultsBtn.classList.toggle('active', resultsMode);
}

export function setFulltextMode(mode: 'list' | 'results'): void {
    resultsMode = mode === 'results';
    applyModeVisibility();
    if (resultsMode) renderFulltextResults();
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
    dom.fulltextModeResultsBtn?.addEventListener('click', () => setFulltextMode('results'));
    dom.fulltextExportCsvBtn?.addEventListener('click', () => handleExportCsv());
    dom.fulltextExportRisBtn?.addEventListener('click', () => handleExportRis());
    dom.fulltextKeyToggle?.addEventListener('change', () => { void handleBlindToggle(); });
}
