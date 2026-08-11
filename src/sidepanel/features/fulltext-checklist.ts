/**
 * fulltext-checklist.ts - フルテキストタブ先頭のセットアップチェックリスト
 *
 * 背景: フルテキストスクリーニング開始時に各レビュアーがつまずく点が3つある
 * （実際に研究チームで発生）:
 *   1. 自分の担当グループへの絞り込み方が分からない
 *   2. 他メンバーがアップロードしたPDFが drive.file スコープの制約で読めない
 *      （「読み取り権限を確認」ボタンの存在に気づかない）
 *   3. どこまで進んだか分からない
 * メール手順書なしで各自が自走できるように、状態から自動判定するチェックリストを
 * 候補リストビューの先頭に置く。
 *
 * 判定ロジック自体は ../../lib/fulltext-checklist-state.ts（純粋関数、DOM/i18n非依存）に
 * 集約し、本モジュールは以下だけを担う:
 *  - PDF読み取り権限チェック結果の取得（fulltext-regrant.ts の onRegrantResult 購読）と
 *    プロジェクトごとの永続化（chrome.storage.local）
 *  - チェックリストの描画とイベント配線
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { platform } from '../../platform';
import { getFulltextSetLabel } from '../../lib/fulltext-assignment';
import {
    computeFulltextChecklistState,
    regrantResultKey,
    type FulltextChecklistGroupState,
    type FulltextChecklistProgressState,
    type FulltextChecklistRegrantState,
    type FulltextRegrantKnownResult,
} from '../../lib/fulltext-checklist-state';
import { onRegrantResult, triggerFulltextRegrantCheck } from './fulltext-regrant';
import type { ReferenceWithStatus } from '../../lib/types';

// 前回確認結果の永続化キー。値は { [regrantResultKey(spreadsheetId, userEmail)]: StoredRegrantResult }
// （プロジェクト × アカウントごとに保持）。
// drive.file の可読性はユーザーごとに異なる（AGENTS.md参照）ため、spreadsheetId だけをキーに
// すると、同一サイドパネルでアカウントを切り替えたときに前アカウントの確認結果が漏れてしまう。
const STORAGE_KEY = 'fulltextRegrantCheckResults';

interface StoredRegrantResult {
    unreadableCount: number;
    totalCachedCount: number;
    checkedAt: string;
}

// regrantResultKey(spreadsheetId, userEmail) -> 直近のチェック結果
// （chrome.storage.local と同期。読み込みは初回描画時に一度だけ行う）
let storedResults: Record<string, StoredRegrantResult> = {};
let storedResultsLoaded = false;
// 今回の起動中に実際にチェックした（=信頼できる最新値の） regrantResultKey の集合。
// これに含まれない storedResults の値は「前回以前の保存値」として扱い、✅固定にしない。
const confirmedThisSession = new Set<string>();
// 永続化ロード完了後に再描画するため、直近に渡された候補リストを覚えておく
let lastCandidates: ReferenceWithStatus[] = [];
// ユーザーが手動で開閉した状態。再描画（renderFulltextTab は判定保存や
// フィルタ変更のたびに走る）でユーザーの選択を上書きしないために覚えておく。
// null = 手動操作なし（allComplete から自動決定）。プロジェクト or アカウント切替でリセットする。
let manualOpenOverride: boolean | null = null;
let lastRegrantResultKey = '';

function ensureStoredResultsLoaded(): void {
    if (storedResultsLoaded) return;
    storedResultsLoaded = true;
    void platform().storageGet([STORAGE_KEY]).then((stored) => {
        const map = stored[STORAGE_KEY] as Record<string, StoredRegrantResult> | undefined;
        if (map) storedResults = { ...map, ...storedResults };
        renderFulltextChecklist(lastCandidates);
    }).catch((error) => {
        console.warn('[fulltext-checklist] 前回確認結果の読み込みに失敗:', error);
    });
}

async function persistRegrantResult(key: string, result: StoredRegrantResult): Promise<void> {
    try {
        const stored = await platform().storageGet([STORAGE_KEY]);
        const map = { ...(stored[STORAGE_KEY] as Record<string, StoredRegrantResult> | undefined) };
        map[key] = result;
        await platform().storageSet({ [STORAGE_KEY]: map });
    } catch (error) {
        console.warn('[fulltext-checklist] 確認結果の保存に失敗:', error);
    }
}

/** イベントリスナー設定（setupFulltextTabListeners から呼ぶ） */
export function setupFulltextChecklistListeners(): void {
    onRegrantResult((result) => {
        const spreadsheetId = state.spreadsheetId;
        if (!spreadsheetId) return;
        const key = regrantResultKey(spreadsheetId, state.userEmail);
        confirmedThisSession.add(key);
        const entry: StoredRegrantResult = {
            unreadableCount: result.unreadableCount,
            totalCachedCount: result.totalCachedCount,
            checkedAt: result.checkedAt,
        };
        storedResults = { ...storedResults, [key]: entry };
        void persistRegrantResult(key, entry);
        renderFulltextChecklist(lastCandidates);
    });
}

function myFulltextDecidedCount(candidates: ReferenceWithStatus[]): number {
    return candidates.filter((r) => {
        const d = r.myFulltextDecision;
        return !!d && d.decision !== 'pending';
    }).length;
}

/**
 * 表示用バージョン文字列。拡張版は chrome.runtime.getManifest().version、
 * それ以外（Web版等。理論上は capabilities.fulltext=false で本タブごと非表示なので到達しない）は
 * platform().getVersionString() を試み、どちらも得られなければ null（=行を非表示）にする。
 */
function getVersionForDisplay(): string | null {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
            const version = chrome.runtime.getManifest().version;
            if (version) return version;
        }
    } catch {
        // 拡張コンテキスト外では chrome 参照自体が例外になりうる
    }
    try {
        return platform().getVersionString() || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

/** フルテキストタブの描画（renderFulltextTab）から呼ぶ */
export function renderFulltextChecklist(candidates: ReferenceWithStatus[]): void {
    lastCandidates = candidates;
    ensureStoredResultsLoaded();

    let host: HTMLElement;
    try {
        host = dom.fulltextChecklistHost;
    } catch {
        return; // ホスト要素がないページ（テスト環境等）では何もしない
    }

    if (!state.spreadsheetId) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }

    const key = regrantResultKey(state.spreadsheetId, state.userEmail);

    // プロジェクトまたはアカウントが切り替わったら手動開閉の記憶をリセット
    // （userEmail の変化も拾うことで、アカウント切替時に前アカウントの「権限OK」表示を
    // そのまま引き継がないようにする）
    if (key !== lastRegrantResultKey) {
        lastRegrantResultKey = key;
        manualOpenOverride = null;
    }

    // regrant（読み取り権限確認）機能は fulltext-regrant.ts 自体には capability 分岐が無く、
    // フルテキストタブ全体が capabilities.fulltext で出し分けられていることに乗っかっている
    // （bootstrap.ts が caps.fulltext=false でタブボタンごと隠す）。ここでも同じフラグを使う。
    const regrantAvailable = platform().capabilities.fulltext;
    const stored = storedResults[key];
    const regrantResult: FulltextRegrantKnownResult | null = stored
        ? { ...stored, freshness: confirmedThisSession.has(key) ? 'session' : 'persisted' }
        : null;

    const checklist = computeFulltextChecklistState({
        version: getVersionForDisplay(),
        assignment: state.fulltextAssignment,
        selectedFulltextSets: state.selectedFulltextSets,
        userEmail: state.userEmail,
        visibleCandidateCount: candidates.length,
        decidedCount: myFulltextDecidedCount(candidates),
        regrantAvailable,
        regrantResult,
    });

    host.classList.remove('hidden');
    host.innerHTML = '';
    host.appendChild(buildPanel(checklist.allComplete, [
        checklist.version.visible ? buildRow('ok', t('fulltext_checklist_version', checklist.version.version)) : null,
        checklist.group.visible ? buildGroupRow(checklist.group) : null,
        checklist.regrant.visible ? buildRegrantRow(checklist.regrant) : null,
        buildProgressRow(checklist.progress),
    ].filter((el): el is HTMLElement => el !== null)));
}

function buildPanel(allComplete: boolean, rows: HTMLElement[]): HTMLElement {
    const details = document.createElement('details');
    details.className = 'fulltext-checklist-panel';
    // 手動で開閉されていればそれを優先（再描画のたびに勝手に開き直さない）
    details.open = manualOpenOverride !== null ? manualOpenOverride : !allComplete;

    const summary = document.createElement('summary');
    summary.className = 'fulltext-checklist-summary';
    summary.textContent = allComplete ? t('fulltext_checklist_collapsedSummary') : t('fulltext_checklist_heading');
    summary.addEventListener('click', () => {
        // details の open 反映は click の既定動作の後なので、次のタスクで読む
        setTimeout(() => { manualOpenOverride = details.open; }, 0);
    });
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'fulltext-checklist-body';
    for (const row of rows) body.appendChild(row);
    details.appendChild(body);

    return details;
}

type RowStatus = 'ok' | 'warn' | 'pending';

function buildRow(status: RowStatus, text: string): HTMLElement {
    const row = document.createElement('div');
    row.className = `fulltext-checklist-row fulltext-checklist-row--${status}`;

    const icon = document.createElement('span');
    icon.className = 'fulltext-checklist-icon';
    icon.textContent = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '▢';
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'fulltext-checklist-label';
    label.textContent = text;
    row.appendChild(label);

    return row;
}

function buildGroupRow(g: FulltextChecklistGroupState): HTMLElement {
    const text = g.narrowed
        ? t('fulltext_checklist_groupNarrowed', [g.groupIds.map(getFulltextSetLabel).join(', '), String(g.visibleCount)])
        : t('fulltext_checklist_groupAll', String(g.visibleCount));
    return buildRow('ok', text);
}

function buildProgressRow(p: FulltextChecklistProgressState): HTMLElement {
    const text = t('fulltext_checklist_progress', [String(p.done), String(p.total)]);
    return buildRow(p.complete ? 'ok' : 'pending', text);
}

function buildRegrantRow(r: FulltextChecklistRegrantState): HTMLElement {
    if (r.kind === 'ok') {
        return buildRow('ok', t('fulltext_checklist_regrantOk', String(r.totalCachedCount)));
    }

    let text: string;
    let btnLabel: string;
    if (r.kind === 'unreadable') {
        text = t('fulltext_checklist_regrantUnreadable', String(r.unreadableCount));
        btnLabel = t('fulltext_checklist_regrantGrantBtn');
    } else if (r.kind === 'previous') {
        const when = r.checkedAt ? formatCheckedAt(r.checkedAt) : '';
        text = r.unreadableCount === 0
            ? t('fulltext_checklist_regrantPreviousOk', when)
            : t('fulltext_checklist_regrantPreviousUnreadable', [when, String(r.unreadableCount)]);
        btnLabel = t('fulltext_checklist_regrantCheckBtn');
    } else {
        text = t('fulltext_checklist_regrantUnchecked');
        btnLabel = t('fulltext_checklist_regrantCheckBtn');
    }

    const row = buildRow('warn', text);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-xsmall btn-outline fulltext-checklist-action-btn';
    btn.textContent = btnLabel;
    btn.addEventListener('click', () => triggerFulltextRegrantCheck());
    row.appendChild(btn);
    return row;
}

/** ISO日時を "YYYY-MM-DD HH:MM" 形式にする（i18n非依存。UI表示専用の簡易フォーマット） */
function formatCheckedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}
