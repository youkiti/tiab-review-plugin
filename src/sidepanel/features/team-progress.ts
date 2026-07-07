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
import {
    computeTeamProgress,
    shortNameOf,
    percentOf,
    type TeamMemberProgress,
    type TeamProgressRef,
} from '../../lib/team-progress';
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
let loading = false;
let loadError = false;
// 展開状態はホストごとに保持（デフォルトは折りたたみ）
const expanded: Record<HostKind, boolean> = { tiab: false, fulltext: false };
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
 * 判定データの取得は非同期で行い、画面表示をブロックしない。
 */
export function initTeamProgress(fullRefs: ReferenceWithStatus[]): void {
    const spreadsheetId = state.spreadsheetId;
    cache = null;
    loadError = false;
    expanded.tiab = false;
    expanded.fulltext = false;

    const baseRefs: TeamProgressRef[] = fullRefs.map((r) => ({
        ref_id: r.ref_id,
        screening_set: r.screening_set,
        fulltext_set: r.fulltext_set,
    }));
    baseRefsStore = { spreadsheetId, refs: baseRefs };

    renderTeamProgress();
    void fetchDecisions(spreadsheetId, baseRefs);
}

/** Decisions タブを再取得して描画を更新する（🔄ボタン・初回読み込み） */
async function fetchDecisions(spreadsheetId: string, baseRefs: TeamProgressRef[]): Promise<void> {
    if (loading) return;
    loading = true;
    loadError = false;
    renderTeamProgress();

    try {
        const rows = await getDecisions(spreadsheetId);
        // 取得中にプロジェクトが切り替わっていたら破棄
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
        loading = false;
        renderTeamProgress();
    }
}

/**
 * イベントリスナーを設定（sidepanel.ts から呼ぶ）
 * フルテキストページ（別タブ）で保存された判定を受信し、パネルへ即時反映する。
 * これによりフルテキストページから戻った時には最新の進捗が表示されている。
 */
export function setupTeamProgressListeners(): void {
    chrome.runtime.onMessage.addListener((message) => {
        if (
            message?.type === 'team-progress:decision-saved' &&
            message.decision &&
            message.spreadsheetId === state.spreadsheetId
        ) {
            noteLocalTeamDecision(message.decision as Decision);
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

    const members = cache && cache.spreadsheetId === state.spreadsheetId
        ? computeTeamProgress({
            refs: cache.baseRefs,
            decisions: cache.decisions,
            assignmentConfig: state.assignmentConfig,
            poolRule: state.fulltextPoolRule,
            fulltextAssignment: state.fulltextAssignment,
            userEmail: state.userEmail,
        })
        : null;

    // 一人プロジェクトでは表示しない（自分の進捗は既存表示と重複するため）
    if (members && members.length < 2 && !loading && !loadError) {
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

    if (loadError && !members) {
        const error = document.createElement('div');
        error.className = 'team-progress-error';
        error.textContent = t('teamProgress_error');
        body.appendChild(error);
    } else if (!members) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'team-progress-loading';
        loadingDiv.textContent = t('teamProgress_loading');
        body.appendChild(loadingDiv);
    } else {
        body.appendChild(buildTable(members));
    }

    body.appendChild(buildFooter());
    panel.appendChild(body);
    return panel;
}

/** ヘッダーの要約（例: "自分 68% · tanaka 82% · sato 36%"） */
function buildSummaryHtml(kind: HostKind, members: TeamMemberProgress[] | null): string {
    if (loading && !cache) return escapeHtml(t('teamProgress_loading'));
    if (loadError && !cache) return escapeHtml(t('teamProgress_error'));
    if (!members) return '';

    const parts = members.map((m) => {
        const name = m.isSelf ? t('teamProgress_you') : shortNameOf(m.email);
        const pct = kind === 'fulltext' && m.fulltextTotal !== null
            ? `${percentOf(m.fulltextDone ?? 0, m.fulltextTotal)}%`
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

        const fulltextCell = m.fulltextTotal !== null
            ? buildCountCellHtml(m.fulltextDone ?? 0, m.fulltextTotal)
            : `<span class="team-progress-muted" title="${escapeHtml(t('teamProgress_poolUnset'))}">—</span>`;

        tr.innerHTML = `
            <td class="team-progress-name" title="${escapeHtml(m.email)}">${escapeHtml(name)}</td>
            <td>${buildCountCellHtml(m.tiabDone, m.tiabTotal)}</td>
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
    if (cache && cache.spreadsheetId === state.spreadsheetId) {
        const hh = String(cache.fetchedAt.getHours()).padStart(2, '0');
        const mm = String(cache.fetchedAt.getMinutes()).padStart(2, '0');
        updatedAt.textContent = t('teamProgress_updatedAt', `${hh}:${mm}`);
    }
    footer.appendChild(updatedAt);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-xsmall btn-outline team-progress-refresh';
    refreshBtn.textContent = loading ? t('teamProgress_refreshing') : `🔄 ${t('teamProgress_refresh')}`;
    refreshBtn.disabled = loading;
    refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseRefs =
            (baseRefsStore?.spreadsheetId === state.spreadsheetId ? baseRefsStore.refs : null)
            ?? cache?.baseRefs
            ?? state.references.map((r) => ({ ref_id: r.ref_id, screening_set: r.screening_set, fulltext_set: r.fulltext_set }));
        void fetchDecisions(state.spreadsheetId, baseRefs);
    });
    footer.appendChild(refreshBtn);

    return footer;
}
