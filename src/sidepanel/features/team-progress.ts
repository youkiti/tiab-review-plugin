/**
 * チーム進捗パネル
 * TiAbタブとフルテキストタブの両方に、レビュアー全員（管理者・非管理者を問わず）の
 * 進捗（判定件数・最終判定日時のみ）を表示する。お互いの緊張感を保つのが目的。
 *
 * ブラインディング維持のため include/exclude の内訳は表示しない。
 * データは Decisions タブ全体（getDecisions）から件数のみを集計する。
 * 判定データはモジュール内にキャッシュし、🔄ボタンで再取得できる。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { getDecisions } from '../../lib/sheets-api';
import { platform } from '../../platform';
import {
    computeTeamProgress,
    isTiabSetFilterActive,
    isFulltextSetFilterActive,
    shortNameOf,
    percentOf,
    toTeamProgressRef,
    type TeamMemberProgress,
    type TeamProgressRef,
} from '../../lib/team-progress';
import { getAssignmentSetLabel } from './assignment';
import { getAvailableFulltextSets, getFulltextSetLabel } from '../../lib/fulltext-assignment';
import { isSharedFulltextPoolMember } from '../../lib/fulltext-candidates';
import type { Decision, ReferenceWithStatus } from '../../lib/types';

/** この日数以上判定がないメンバーに ⚠ を付ける */
const STALE_DAYS = 3;

type HostKind = 'tiab' | 'fulltext';

interface TeamProgressCache {
    spreadsheetId: string;
    baseRefs: TeamProgressRef[];
    decisions: Decision[];
    fetchedAt: Date;
}

let cache: TeamProgressCache | null = null;
// 分母計算用の全文献（担当割り振りで絞り込む前）。取得失敗後のリトライでも使う
let baseRefsStore: { spreadsheetId: string; refs: TeamProgressRef[] } | null = null;
/**
 * 取得中のプロジェクトID（null = 取得していない）。
 * 単なる boolean にすると「別プロジェクトの取得が飛んでいる間に開き直した」場合に
 * 新しい取得ごと捨ててしまい、cache=null / エラーなし / 取得中でもない詰み状態
 * （＝共著者の行が出ないまま「読み込み中…」で止まる）になるため、必ずIDで管理する。
 */
let inflightSpreadsheetId: string | null = null;
let loadError = false;

/** 現在のプロジェクトの判定データを取得中か */
function isLoadingCurrent(): boolean {
    return inflightSpreadsheetId !== null && inflightSpreadsheetId === state.spreadsheetId;
}

/** 現在のプロジェクトの判定データがキャッシュ済みか */
function hasCurrentCache(): boolean {
    return cache !== null && cache.spreadsheetId === state.spreadsheetId;
}
// 展開状態はホストごとに保持（デフォルトは折りたたみ）
const expanded: Record<HostKind, boolean> = { tiab: false, fulltext: false };
// 担当セットの絞り込み反映トグル。ホストごとに独立、既定 ON、セッション内のみ（永続化しない）
const setFilterEnabled: Record<HostKind, boolean> = { tiab: true, fulltext: true };
// TiAb側はツールバー内のドロップダウン表示のため、外側クリックで閉じる
let outsideClickListenerAdded = false;

function ensureOutsideClickListener(): void {
    if (outsideClickListenerAdded) return;
    outsideClickListenerAdded = true;
    document.addEventListener('click', (e) => {
        if (!expanded.tiab) return;
        try {
            if (!dom.teamProgressHost.contains(e.target as Node)) {
                expanded.tiab = false;
                renderHost('tiab');
            }
        } catch {
            // ホスト要素がないページでは何もしない
        }
    });
}

function hostOf(kind: HostKind): HTMLElement {
    return kind === 'tiab' ? dom.teamProgressHost : dom.fulltextTeamProgressHost;
}

/**
 * プロジェクト読み込み時に呼ぶ（担当割り振りで絞り込む前の全文献を渡す）
 *
 * preloadedDecisions を渡すと、この関数自身の getDecisions() 呼び出しを省略して
 * そのまま cache を同期的に温める（Issue #153 工程2 チャンク2: プロジェクト読み込み側が
 * 既に取得済みの Decisions を渡し、初回の重複取得をなくす。現状の唯一の呼び出し元
 * （project.ts の loadDataAndShowScreening）は常にこちらを通り、判定データ取得の通信は
 * 発生しない。PR #161 レビュー指摘対応で「判定データの取得は非同期」というこの docstring の
 * 記述を訂正）。preloadedDecisions を省略した場合だけ、従来どおり非同期の getDecisions() で
 * 取得し画面表示をブロックしない。🔄ボタン（buildFooter() 内）は
 * fetchDecisions() を直接呼んで独立に再取得する。
 */
export function initTeamProgress(
    fullRefs: ReferenceWithStatus[],
    preloadedDecisions?: { decision: Decision; rowIndex: number }[]
): void {
    const spreadsheetId = state.spreadsheetId;
    cache = null;
    loadError = false;
    expanded.tiab = false;
    expanded.fulltext = false;

    const baseRefs: TeamProgressRef[] = fullRefs.map(toTeamProgressRef);
    baseRefsStore = { spreadsheetId, refs: baseRefs };

    if (preloadedDecisions) {
        cache = {
            spreadsheetId,
            baseRefs,
            decisions: preloadedDecisions.map((r) => r.decision),
            fetchedAt: new Date(),
        };
        renderTeamProgress();
        return;
    }

    // 取得開始（同期的に「取得中」状態と初回描画まで進む）→ その後に念のため描画。
    // 既に同じプロジェクトを取得中で fetchDecisions が即 return した場合も、
    // 続く renderTeamProgress() が「読み込み中」を描くので空パネルにはならない。
    void fetchDecisions(spreadsheetId, baseRefs);
    renderTeamProgress();
}

/** Decisions タブを再取得して描画を更新する（🔄ボタン・初回読み込み） */
async function fetchDecisions(spreadsheetId: string, baseRefs: TeamProgressRef[]): Promise<void> {
    if (!spreadsheetId) return;
    // 抑止するのは「同じプロジェクトの二重取得」だけ。別プロジェクトの取得中でも新しい取得は必ず開始する
    if (inflightSpreadsheetId === spreadsheetId) return;
    inflightSpreadsheetId = spreadsheetId;
    loadError = false;
    renderTeamProgress();

    try {
        const rows = await getDecisions(spreadsheetId);
        // 取得中にプロジェクトが切り替わっていたら破棄（切替先の取得は別途走っている）
        if (state.spreadsheetId !== spreadsheetId) return;
        cache = {
            spreadsheetId,
            baseRefs,
            decisions: rows.map((r) => r.decision),
            fetchedAt: new Date(),
        };
    } catch (error) {
        console.error('[team-progress] 判定データの取得に失敗:', error);
        if (state.spreadsheetId === spreadsheetId) {
            loadError = true;
        }
    } finally {
        // 自分より後に始まった取得が inflight を握っている場合は触らない
        if (inflightSpreadsheetId === spreadsheetId) {
            inflightSpreadsheetId = null;
        }
        renderTeamProgress();
    }
}

/**
 * イベントリスナーを設定（sidepanel.ts から呼ぶ）
 * フルテキストページ（別タブ）で保存された判定を受信し、パネルへ即時反映する。
 * これによりフルテキストページから戻った時には最新の進捗が表示されている。
 */
export function setupTeamProgressListeners(): void {
    platform().onMessage((message) => {
        const msg = message as { type?: string; decision?: unknown; spreadsheetId?: string };
        if (
            msg?.type === 'team-progress:decision-saved' &&
            msg.decision &&
            msg.spreadsheetId === state.spreadsheetId
        ) {
            noteLocalTeamDecision(msg.decision as Decision);
        }
    });
}

/**
 * 自分の判定保存をキャッシュへ反映する（サーバー再取得なしで自分の行を最新化）
 * 同一 ref_id + reviewer_id + フェーズの既存行は置き換える（最新判定のみ有効の設計に合わせる）
 */
export function noteLocalTeamDecision(decision: Decision): void {
    if (!cache || cache.spreadsheetId !== state.spreadsheetId) return;
    const phase = decision.screening_phase ?? 'tiab';
    cache.decisions = cache.decisions.filter((d) =>
        !(d.ref_id === decision.ref_id &&
            d.reviewer_id === decision.reviewer_id &&
            (d.screening_phase ?? 'tiab') === phase)
    );
    cache.decisions.push(decision);
    renderTeamProgress();
}

/** 両ホスト（TiAbタブ・フルテキストタブ）を描画する */
export function renderTeamProgress(): void {
    renderHost('tiab');
    renderHost('fulltext');
}

function renderHost(kind: HostKind): void {
    let host: HTMLElement;
    try {
        host = hostOf(kind);
    } catch {
        return; // ホスト要素がないページでは何もしない
    }
    if (kind === 'tiab') {
        ensureOutsideClickListener();
    }

    if (!state.spreadsheetId) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }

    const members = hasCurrentCache() && cache
        ? computeTeamProgress({
            refs: cache.baseRefs,
            decisions: cache.decisions,
            assignmentConfig: state.assignmentConfig,
            poolRule: state.fulltextPoolRule,
            fulltextAssignment: state.fulltextAssignment,
            userEmail: state.userEmail,
            // その画面の下にあるチェックボックスだけで絞る（TiAbホストはTiAbの選択のみ、
            // フルテキストホストはフルテキストの選択のみを見る）。逆側のフェーズの絞り込みは
            // 渡さない — 渡すと「開いただけの別タブの選択」で見えていた数字が消える事故になる
            tiabSetFilter: (kind === 'tiab' && setFilterEnabled.tiab)
                ? { availableSets: state.assignmentSets, selectedSets: state.selectedAssignmentSets }
                : undefined,
            fulltextSetFilter: (kind === 'fulltext' && setFilterEnabled.fulltext)
                ? { selectedSets: state.selectedFulltextSets }
                : undefined,
        })
        : null;

    // 一人プロジェクトでは表示しない（自分の進捗は既存表示と重複するため）
    if (members && members.length < 2 && !isLoadingCurrent() && !loadError) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }

    host.classList.remove('hidden');
    host.innerHTML = '';
    host.appendChild(buildPanel(kind, members));
}

function buildPanel(kind: HostKind, members: TeamMemberProgress[] | null): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'team-progress';

    // ---- ヘッダー行（常時表示・クリックで展開） ----
    const header = document.createElement('div');
    header.className = 'team-progress-header';
    header.setAttribute('role', 'button');
    header.title = t('teamProgress_toggleTitle');
    header.innerHTML = `
        <span class="team-progress-caret">${expanded[kind] ? '▾' : '▸'}</span>
        <span class="team-progress-title">👥 ${escapeHtml(t('teamProgress_title'))}</span>
        <span class="team-progress-summary">${buildSummaryHtml(kind, members)}</span>
    `;
    header.addEventListener('click', (e) => {
        // 再描画で要素が差し替わると外側クリック判定が誤作動するため伝播を止める
        e.stopPropagation();
        expanded[kind] = !expanded[kind];
        renderHost(kind);
    });
    panel.appendChild(header);

    if (!expanded[kind]) {
        return panel;
    }

    // ---- 展開ボディ ----
    const body = document.createElement('div');
    body.className = 'team-progress-body';

    body.appendChild(buildScopeFilterRow(kind));

    if (!members && isLoadingCurrent()) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'team-progress-loading';
        loadingDiv.textContent = t('teamProgress_loading');
        body.appendChild(loadingDiv);
    } else if (!members) {
        // 取得失敗、または（あってはならないが）取得が走らないまま止まった場合。
        // 「読み込み中…」のまま固まって見えるより、🔄で復帰できるエラー表示にする
        const error = document.createElement('div');
        error.className = 'team-progress-error';
        error.textContent = t('teamProgress_error');
        body.appendChild(error);
    } else {
        body.appendChild(buildTable(members));
    }

    body.appendChild(buildFooter());
    panel.appendChild(body);
    return panel;
}

/**
 * 担当セット絞り込みトグル + 対象セット名の表示行
 * トグルは TiAb ホスト・フルテキストホストで独立（setFilterEnabled）。既定 ON
 */
function buildScopeFilterRow(kind: HostKind): HTMLElement {
    const row = document.createElement('div');
    row.className = 'team-progress-scope-row';

    const label = document.createElement('label');
    label.className = 'team-progress-scope-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = setFilterEnabled[kind];
    checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        setFilterEnabled[kind] = checkbox.checked;
        renderHost(kind);
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${t('teamProgress_scopeFilterLabel')}`));
    row.appendChild(label);

    if (setFilterEnabled[kind]) {
        const scopeText = buildScopeLine(kind);
        if (scopeText) {
            const scopeSpan = document.createElement('span');
            scopeSpan.className = 'team-progress-scope-line';
            scopeSpan.textContent = scopeText;
            row.appendChild(scopeSpan);
        }
    }

    return row;
}

/**
 * 「対象: グループ1, グループ3」のような絞り込み対象セット名の表示。
 * そのホスト自身のフェーズの絞り込みが実際に効いているときだけ返す
 * （TiAbホストはTiAb選択のみ、フルテキストホストはフルテキスト選択のみを見る。
 * renderHost() が渡す tiabSetFilter/fulltextSetFilter と対応させている）。
 * TiAb 側は getAssignmentSetLabel()（features/assignment.ts）、
 * フルテキスト側は getFulltextSetLabel()（lib/fulltext-assignment.ts）でラベル化する。
 */
function buildScopeLine(kind: HostKind): string | null {
    if (kind === 'tiab') {
        const tiabActive = isTiabSetFilterActive(
            state.assignmentConfig.status === 'configured',
            state.assignmentSets,
            state.selectedAssignmentSets
        );
        if (!tiabActive) return null;
        const labels = Array.from(state.assignmentSets)
            .filter((setId) => state.selectedAssignmentSets.has(setId))
            .map((setId) => getAssignmentSetLabel(setId));
        if (labels.length === 0) return null;
        return t('teamProgress_scopeLabel', labels.join(', '));
    }

    const fulltextActive = isFulltextSetFilterActive(state.fulltextAssignment, state.selectedFulltextSets);
    if (!fulltextActive) return null;
    const labels = Array.from(getAvailableFulltextSets(state.fulltextAssignment, hasUnassignedFulltextPoolRefs()))
        .filter((setId) => state.selectedFulltextSets.has(setId))
        .map((setId) => getFulltextSetLabel(setId));
    if (labels.length === 0) return null;
    return t('teamProgress_scopeLabel', labels.join(', '));
}

/**
 * 候補プールに「未割り当て」（fulltext_set 空だがプールルール/取り込み行で候補入り）の
 * 文献が実在するか。対象セット名の表示（buildScopeLine）で、選択されていても実在しない
 * 「未割り当て」ラベルを出さないようにするための判定。
 * decisionsByRef は都度作り直す（呼び出しは絞り込み表示時のみで頻度が低いため、
 * computeTeamProgress() 側の状態を持ち回して二重管理にするより単純さを優先している）。
 */
function hasUnassignedFulltextPoolRefs(): boolean {
    if (!hasCurrentCache() || !cache) return false;
    const decisionsByRef = new Map<string, Decision[]>();
    for (const d of cache.decisions) {
        const list = decisionsByRef.get(d.ref_id);
        if (list) {
            list.push(d);
        } else {
            decisionsByRef.set(d.ref_id, [d]);
        }
    }
    return cache.baseRefs.some((r) => {
        if ((r.fulltext_set || '').trim() !== '') return false;
        return isSharedFulltextPoolMember({
            ref: r,
            decisions: decisionsByRef.get(r.ref_id) ?? [],
            poolRule: state.fulltextPoolRule,
            assignment: state.fulltextAssignment,
        });
    });
}

/** ヘッダーの要約（例: "自分 68% · tanaka 82% · sato 36%"） */
function buildSummaryHtml(kind: HostKind, members: TeamMemberProgress[] | null): string {
    // members が null = 現在のプロジェクトのキャッシュがない状態。
    // 取得中なら「読み込み中」、そうでなければ取得できていないので「失敗」を出す（空欄にはしない）
    if (!members) {
        return escapeHtml(isLoadingCurrent() ? t('teamProgress_loading') : t('teamProgress_error'));
    }

    const parts = members.map((m) => {
        const name = m.isSelf ? t('teamProgress_you') : shortNameOf(m.email);
        const useFulltext = kind === 'fulltext' && m.fulltextTotal !== null;
        const inScope = useFulltext ? m.fulltextInScope : m.tiabInScope;
        const pct = !inScope
            ? '—'
            : useFulltext
                ? `${percentOf(m.fulltextDone ?? 0, m.fulltextTotal as number)}%`
                : `${percentOf(m.tiabDone, m.tiabTotal)}%`;
        const cls = m.isSelf ? 'team-progress-summary-self' : '';
        return `<span class="${cls}">${escapeHtml(name)} ${pct}</span>`;
    });
    return parts.join('<span class="team-progress-sep"> · </span>');
}

function buildTable(members: TeamMemberProgress[]): HTMLElement {
    const table = document.createElement('table');
    table.className = 'team-progress-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>${escapeHtml(t('teamProgress_colReviewer'))}</th>
            <th>TiAb</th>
            <th>${escapeHtml(t('teamProgress_colFulltext'))}</th>
            <th>${escapeHtml(t('teamProgress_colLast'))}</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const m of members) {
        const tr = document.createElement('tr');
        if (m.isSelf) tr.classList.add('is-self');

        const name = m.isSelf
            ? `${shortNameOf(m.email)} (${t('teamProgress_you')})`
            : shortNameOf(m.email);

        const tiabCell = m.tiabInScope
            ? buildCountCellHtml(m.tiabDone, m.tiabTotal)
            : `<span class="team-progress-muted" title="${escapeHtml(t('teamProgress_outOfScope'))}">—</span>`;

        const fulltextCell = m.fulltextTotal === null
            ? `<span class="team-progress-muted" title="${escapeHtml(t('teamProgress_poolUnset'))}">—</span>`
            : m.fulltextInScope
                ? buildCountCellHtml(m.fulltextDone ?? 0, m.fulltextTotal)
                : `<span class="team-progress-muted" title="${escapeHtml(t('teamProgress_outOfScope'))}">—</span>`;

        tr.innerHTML = `
            <td class="team-progress-name" title="${escapeHtml(m.email)}">${escapeHtml(name)}</td>
            <td>${tiabCell}</td>
            <td>${fulltextCell}</td>
            <td class="team-progress-last">${buildLastActivityHtml(m)}</td>
        `;
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const wrapper = document.createElement('div');
    wrapper.className = 'team-progress-table-wrapper';
    wrapper.appendChild(table);
    return wrapper;
}

/** 件数セル: ミニ進捗バー + "342/500 (68%)" */
function buildCountCellHtml(done: number, total: number): string {
    const pct = percentOf(done, total);
    return `
        <div class="team-progress-cell">
            <div class="team-progress-bar"><div class="team-progress-bar-fill" style="width:${pct}%"></div></div>
            <span class="team-progress-count">${done}/${total} (${pct}%)</span>
        </div>
    `;
}

/** 最終判定セル: 相対時刻 + 停滞警告（残作業があり STALE_DAYS 日以上判定なし） */
function buildLastActivityHtml(m: TeamMemberProgress): string {
    if (!m.lastDecidedAt) {
        return `<span class="team-progress-muted">${escapeHtml(t('teamProgress_never'))}</span>`;
    }
    const last = new Date(m.lastDecidedAt);
    if (Number.isNaN(last.getTime())) {
        return `<span class="team-progress-muted">—</span>`;
    }

    const relative = formatRelativeTime(last);
    const hasRemaining = m.tiabDone < m.tiabTotal ||
        (m.fulltextTotal !== null && (m.fulltextDone ?? 0) < m.fulltextTotal);
    const daysAgo = (Date.now() - last.getTime()) / (24 * 60 * 60 * 1000);

    if (hasRemaining && daysAgo >= STALE_DAYS) {
        const warnTitle = escapeHtml(t('teamProgress_staleTitle', String(STALE_DAYS)));
        return `<span class="team-progress-stale" title="${warnTitle}">⚠ ${escapeHtml(relative)}</span>`;
    }
    return escapeHtml(relative);
}

function formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / (60 * 1000));
    if (minutes < 1) return t('teamProgress_relJustNow');
    if (minutes < 60) return t('teamProgress_relMinutes', String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('teamProgress_relHours', String(hours));
    const days = Math.floor(hours / 24);
    return t('teamProgress_relDays', String(days));
}

/** フッター: 最終更新時刻 + 🔄更新ボタン */
function buildFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'team-progress-footer';

    const updatedAt = document.createElement('span');
    updatedAt.className = 'team-progress-updated';
    if (hasCurrentCache() && cache) {
        const hh = String(cache.fetchedAt.getHours()).padStart(2, '0');
        const mm = String(cache.fetchedAt.getMinutes()).padStart(2, '0');
        updatedAt.textContent = t('teamProgress_updatedAt', `${hh}:${mm}`);
    }
    footer.appendChild(updatedAt);

    const loading = isLoadingCurrent();
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-xsmall btn-outline team-progress-refresh';
    refreshBtn.textContent = loading ? t('teamProgress_refreshing') : `🔄 ${t('teamProgress_refresh')}`;
    refreshBtn.disabled = loading;
    refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseRefs =
            (baseRefsStore?.spreadsheetId === state.spreadsheetId ? baseRefsStore.refs : null)
            ?? cache?.baseRefs
            ?? state.references.map(toTeamProgressRef);
        void fetchDecisions(state.spreadsheetId, baseRefs);
    });
    footer.appendChild(refreshBtn);

    return footer;
}
