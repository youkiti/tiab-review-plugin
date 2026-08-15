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
    type FulltextChecklistFolderShareState,
    type FulltextChecklistGroupState,
    type FulltextChecklistLinkShareState,
    type FulltextChecklistProgressState,
    type FulltextChecklistRegrantState,
    type FulltextRegrantKnownResult,
} from '../../lib/fulltext-checklist-state';
import { onRegrantResult, triggerFulltextRegrantCheck } from './fulltext-regrant';
import { resetFulltextSetSelectionToMine } from './fulltext-assignment-ui';
import type { ReferenceWithStatus } from '../../lib/types';
import { getFilePermissions, getProjectDriveFolderId, getSpreadsheetPermissions, type SpreadsheetPermission } from '../../lib/sheets-api';
import { mergePermissionsForDisplay } from '../../lib/share-permissions';
import { buildSpreadsheetUrl } from '../../lib/share-invite';

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

// ---------------------------------------------------------------------------
// 項目5・6（管理者向け: リンク共有検出・フォルダ共有ズレ検出）用の権限データ
//
// フォルダ・スプレッドシートの権限一覧はDrive APIの読み取りクォータ対象のため、
// チェックリストの再描画（判定保存・フィルタ変更のたびに走る）のたびに叩くと
// 429を踏む（AGENTS.mdの429対策の思想）。spreadsheetId単位でモジュール内キャッシュし、
// プロジェクトが変わったときだけ取り直す。管理者以外は使わないため取得自体を行わない。
// ---------------------------------------------------------------------------

interface FulltextChecklistPermissionsSnapshot {
    linkShareRole: 'writer' | 'reader' | null;
    folderPermissionEmails: string[] | null;
    /** 「フォルダをDriveで開く」ボタンの遷移先。フォルダが無い/読めない場合は null */
    folderId: string | null;
}

let permissionsSnapshot: FulltextChecklistPermissionsSnapshot | null = null;
let permissionsSnapshotSpreadsheetId = '';
let permissionsSnapshotLoading = false;

/** プロジェクトごとに1回だけフォルダ・スプレッドシートの権限を取得し、結果をキャッシュする */
function ensurePermissionsSnapshotLoaded(spreadsheetId: string, isAdmin: boolean): void {
    if (!isAdmin) return; // 管理者以外の画面には出さないため取得しない
    if (permissionsSnapshotSpreadsheetId === spreadsheetId && (permissionsSnapshot !== null || permissionsSnapshotLoading)) return;

    permissionsSnapshotSpreadsheetId = spreadsheetId;
    permissionsSnapshot = null;
    permissionsSnapshotLoading = true;

    void loadPermissionsSnapshot(spreadsheetId).then((snapshot) => {
        // 取得中にプロジェクトが切り替わっていたら、古い結果は捨てて再描画もしない
        if (permissionsSnapshotSpreadsheetId !== spreadsheetId) return;
        permissionsSnapshot = snapshot;
        permissionsSnapshotLoading = false;
        renderFulltextChecklist(lastCandidates);
    }).catch((error) => {
        console.warn('[fulltext-checklist] 共有権限の取得に失敗:', error);
        permissionsSnapshotLoading = false;
    });
}

async function loadPermissionsSnapshot(spreadsheetId: string): Promise<FulltextChecklistPermissionsSnapshot> {
    let folderId: string | null = null;
    let folderPermissions: SpreadsheetPermission[] | null = null;
    try {
        folderId = await getProjectDriveFolderId(spreadsheetId);
        if (folderId) {
            folderPermissions = await getFilePermissions(folderId);
        }
    } catch (error) {
        console.warn('[fulltext-checklist] フォルダ権限の取得に失敗:', error);
        folderPermissions = null;
    }

    let sheetPermissions: SpreadsheetPermission[] | null = null;
    try {
        sheetPermissions = await getSpreadsheetPermissions(spreadsheetId);
    } catch (error) {
        console.warn('[fulltext-checklist] スプレッドシート権限の取得に失敗:', error);
    }

    // リンク共有の判定は共有リスト（sharing.ts）と同じ純粋関数を再利用し、判定ロジックを二重化しない
    const { linkShare } = mergePermissionsForDisplay(folderPermissions, sheetPermissions);
    const folderPermissionEmails = folderPermissions
        ? folderPermissions.map((p) => p.emailAddress).filter((e): e is string => typeof e === 'string' && e.length > 0)
        : null;

    return {
        linkShareRole: linkShare?.role ?? null,
        folderPermissionEmails,
        folderId,
    };
}

/**
 * ブラインドセーフな「本来レビューに参加するはずのメンバー」一覧（重複除去はしない。
 * lib側の computeFolderShare が大文字小文字を無視して重複を吸収する）。
 *
 * Decisions の reviewer_id からは集めない。Blind中は他人の human 票がクライアントに
 * 配られないため、これを使うと人によって missingEmails の結果が変わってしまう
 * （ブラインドセーフの要。AGENTS.md 参照）。代わりに全員に同じ値が見える Config 由来の
 * 割り振り設定（TiAb: state.assignmentConfig.reviewerMap ＋ フルテキスト:
 * state.fulltextAssignment.reviewerMap）の和集合を使う。
 */
function knownReviewerEmailsFromConfig(): string[] {
    const emails: string[] = [];
    for (const reviewerMap of [state.assignmentConfig.reviewerMap, state.fulltextAssignment.reviewerMap]) {
        for (const reviewers of Object.values(reviewerMap || {})) {
            for (const email of reviewers || []) {
                const trimmed = (email || '').trim();
                if (trimmed) emails.push(trimmed);
            }
        }
    }
    return emails;
}

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

    ensurePermissionsSnapshotLoaded(state.spreadsheetId, state.isAdmin);

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

    // permissionsSnapshot は spreadsheetId 単位のキャッシュ。取得中/未取得（このプロジェクトでの
    // フェッチがまだ完了していない）場合は null 扱いにする（=項目5・6は取得完了まで非表示）。
    const snapshot = permissionsSnapshotSpreadsheetId === state.spreadsheetId ? permissionsSnapshot : null;

    const checklist = computeFulltextChecklistState({
        version: getVersionForDisplay(),
        assignment: state.fulltextAssignment,
        selectedFulltextSets: state.selectedFulltextSets,
        userEmail: state.userEmail,
        visibleCandidateCount: candidates.length,
        decidedCount: myFulltextDecidedCount(candidates),
        regrantAvailable,
        regrantResult,
        isAdmin: state.isAdmin,
        linkShareRole: snapshot?.linkShareRole ?? null,
        folderPermissionEmails: snapshot?.folderPermissionEmails ?? null,
        knownReviewerEmails: knownReviewerEmailsFromConfig(),
    });

    host.classList.remove('hidden');
    host.innerHTML = '';
    host.appendChild(buildPanel(checklist.allComplete, [
        checklist.version.visible ? buildRow('ok', t('fulltext_checklist_version', checklist.version.version)) : null,
        checklist.group.visible ? buildGroupRow(checklist.group) : null,
        checklist.regrant.visible ? buildRegrantRow(checklist.regrant) : null,
        buildProgressRow(checklist.progress),
        checklist.linkShare.visible ? buildLinkShareRow(checklist.linkShare) : null,
        checklist.folderShare.visible ? buildFolderShareRow(checklist.folderShare, snapshot?.folderId ?? null) : null,
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

type RowStatus = 'ok' | 'warn' | 'error' | 'pending';

function buildRow(status: RowStatus, text: string): HTMLElement {
    const row = document.createElement('div');
    row.className = `fulltext-checklist-row fulltext-checklist-row--${status}`;

    const icon = document.createElement('span');
    icon.className = 'fulltext-checklist-icon';
    icon.textContent = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : status === 'error' ? '❌' : '▢';
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'fulltext-checklist-label';
    label.textContent = text;
    row.appendChild(label);

    return row;
}

function buildGroupRow(g: FulltextChecklistGroupState): HTMLElement {
    if (g.kind === 'all') {
        // narrowed かどうかの判定は fulltext-checklist-state.ts の narrowed フィールドで完結しており、
        // ここでは読むだけ（絞り込みで一部グループだけ選択中なら「全候補を表示中」は事実と異なるため文言を出し分ける）
        const text = g.narrowed
            ? t('fulltext_checklist_groupNarrowed', [g.selectedGroupIds.map(getFulltextSetLabel).join(', '), String(g.visibleCount)])
            : t('fulltext_checklist_groupAll', String(g.visibleCount));
        return buildRow('ok', text);
    }
    if (g.kind === 'ok') {
        const text = t('fulltext_checklist_groupOk', [g.myGroupIds.map(getFulltextSetLabel).join(', '), String(g.visibleCount)]);
        return buildRow('ok', text);
    }

    const text = g.kind === 'extra'
        ? t('fulltext_checklist_groupExtra', [g.extraGroupIds.map(getFulltextSetLabel).join(', '), String(g.visibleCount)])
        : t('fulltext_checklist_groupMissing', [g.missingGroupIds.map(getFulltextSetLabel).join(', '), String(g.visibleCount)]);

    const row = buildRow('error', text);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-xsmall btn-outline fulltext-checklist-action-btn';
    btn.textContent = t('fulltext_checklist_groupFixBtn');
    btn.addEventListener('click', () => { void resetFulltextSetSelectionToMine(); });
    row.appendChild(btn);
    return row;
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

/**
 * リンク共有（type='anyone'）警告行。共有リストの警告バナー（sharing.ts の
 * buildLinkShareWarning）と同じ i18n キー（share_linkShareWarningWriter/Reader）を再利用し、
 * 文言を二重管理しない。writer は error（赤）、reader は warn（黄）。
 */
function buildLinkShareRow(l: FulltextChecklistLinkShareState): HTMLElement {
    const text = l.role === 'writer' ? t('share_linkShareWarningWriter') : t('share_linkShareWarningReader');
    const row = buildRow(l.role === 'writer' ? 'error' : 'warn', text);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-xsmall btn-outline fulltext-checklist-action-btn';
    btn.textContent = t('fulltext_checklist_linkShareOpenBtn');
    btn.addEventListener('click', () => {
        platform().openExternal(buildSpreadsheetUrl(state.spreadsheetId));
    });
    row.appendChild(btn);
    return row;
}

/**
 * フォルダ共有のズレ検出行。フォルダの実権限一覧に、Config由来の割り振り設定
 * （ブラインドセーフ。knownReviewerEmailsFromConfig 参照）にいる担当者が
 * 見当たらない場合に警告する。
 */
function buildFolderShareRow(f: FulltextChecklistFolderShareState, folderId: string | null): HTMLElement {
    if (f.kind === 'ok') {
        return buildRow('ok', t('fulltext_checklist_folderShareOk'));
    }

    const row = buildRow('warn', t('fulltext_checklist_folderShareMissing', f.missingEmails.join(', ')));
    if (folderId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-xsmall btn-outline fulltext-checklist-action-btn';
        btn.textContent = t('share_folderOpenDriveBtn');
        btn.addEventListener('click', () => {
            platform().openExternal(`https://drive.google.com/drive/folders/${folderId}`);
        });
        row.appendChild(btn);
    }
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
