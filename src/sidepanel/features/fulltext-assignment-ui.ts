/**
 * フルテキスト担当割り振りUI（フルテキストタブ内）
 *
 * 候補プール（FulltextPoolRule で確定した集合）が決まった段階で、プール内の文献を
 * グループ分割して担当レビュアーへ割り振る。TiAb の担当割り振りウィザードの
 * フルテキスト版で、以下を提供する:
 *  - 状態行: 割り振りの有無・自分の担当グループを表示（全ユーザー）
 *  - ウィザード（管理者のみ）: グループ数と担当者を指定して分割を作成/再シャッフル、
 *    担当者のみの変更（新規レビュアー追加）、未割り当て文献の追加配分、割り振りの解除
 *
 * デフォルト（status 'none'）は従来どおり全員が全候補を判定する。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { showLoading, showToast } from '../ui/feedback';
import { hideModal, showModal } from '../ui/modal';
import { platform } from '../../platform';
import {
    getSpreadsheetPermissions,
    saveFulltextAssignmentConfig,
    updateReferenceFulltextSets,
} from '../../lib/sheets-api';
import { setFulltextAssignment as syncSetFulltextAssignment } from '../store/compat';
import {
    createDefaultFulltextAssignment,
    buildFulltextSetAssignments,
    distributeUnassigned,
    fulltextSetOf,
    getFulltextSetsForUser,
    getFulltextSetLabel,
    normalizeFulltextReviewerMap,
    initialSelectedFulltextSets,
    normalizeStoredFulltextSets,
    canSeeFulltextRef,
} from '../../lib/fulltext-assignment';
import type { FulltextAssignmentConfig } from '../../lib/fulltext-assignment';
import { getFulltextPoolList } from './screening/filters';
import type { ReferenceWithStatus } from '../../lib/types';

// selectedFulltextSets の永続化キー。値は { [spreadsheetId]: string[] }（プロジェクトごとに保持）
const STORAGE_KEY = 'selectedFulltextSets';

let _rerenderTab: (() => void) | null = null;
let _wizardOpen = false;
// fulltext_set の書き込みは複数リクエストに分かれるため、二重実行すると
// 異なるシャッフル結果が混ざってシートが壊れる。実行中は再入を禁止する。
let _ftSaving = false;

/** 実行中はボタンを無効化し「割り振り中…」表示にする。戻り値で元に戻す */
function markButtonSaving(button: HTMLButtonElement | undefined): () => void {
    if (!button) return () => {};
    const originalLabel = button.textContent;
    button.disabled = true;
    button.classList.add('btn-loading');
    button.textContent = t('assignment_wizardCreating');
    return () => {
        button.disabled = false;
        button.classList.remove('btn-loading');
        button.textContent = originalLabel;
    };
}

export function setFulltextAssignmentDeps(deps: { rerenderTab: () => void }): void {
    _rerenderTab = deps.rerenderTab;
}

/** プール内で未割り当ての文献（割り振り後に候補入りした文献） */
function getUnassignedPoolRefs(config: FulltextAssignmentConfig): ReferenceWithStatus[] {
    if (config.status !== 'configured') return [];
    return getFulltextPoolList().filter((r) => fulltextSetOf(r, config) === 'unassigned');
}

/** プール内のグループ別件数 */
function countPoolBySet(config: FulltextAssignmentConfig): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ref of getFulltextPoolList()) {
        const setId = fulltextSetOf(ref, config);
        counts.set(setId, (counts.get(setId) ?? 0) + 1);
    }
    return counts;
}

// ---------------------------------------------------------------------------
// 状態行の描画
// ---------------------------------------------------------------------------

/**
 * グループごとの件数（全文献ベース）。
 * fulltext_set 列は割り振り時に References へ書き込まれるため、候補ルールの有無に関係なく
 * グループ別件数は正確に数えられる。非管理者の state.references は自分の担当分に絞られて
 * いるので、全員に同じ数字を見せるために state.allReferences を使う。
 */
function countAllRefsByFulltextSet(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ref of state.allReferences) {
        const setId = (ref.fulltext_set || '').trim();
        if (!setId) continue; // 未割り当ては候補プールが確定しないと数えられないため別扱い
        counts.set(setId, (counts.get(setId) ?? 0) + 1);
    }
    return counts;
}

/**
 * 「自分がこのセットの文献を持っているか」の件数（全文献ベース、canSeeFulltextRef 準拠）。
 * TiAb の canFilter 判定（visibleCounts）と同じ役割: 自分の担当外セットのチェックボックスを
 * 無効化するかどうかの根拠に使う（表示件数そのものは countAllRefsByFulltextSet を使う）。
 */
function countVisibleRefsByFulltextSet(config: FulltextAssignmentConfig): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ref of state.allReferences) {
        const setId = (ref.fulltext_set || '').trim();
        if (!setId) continue;
        if (!canSeeFulltextRef(ref, config, state.userEmail, state.isAdmin)) continue;
        counts.set(setId, (counts.get(setId) ?? 0) + 1);
    }
    return counts;
}

/**
 * 「どのグループが誰の担当か」の内訳を、TiAb の担当セットフィルタ（assignment.ts の
 * renderAssignmentFilters）と同じチェックボックスUIで描画する。
 * 未割り当て文献は仕様上「全員が対象」（取りこぼし防止）なので、担当者なしとは書かない。
 */
function renderFulltextAssignmentBreakdown(config: FulltextAssignmentConfig): void {
    let host: HTMLElement;
    let listDiv: HTMLElement;
    try {
        host = dom.fulltextAssignmentSets;
        listDiv = dom.fulltextAssignmentSetListDiv;
    } catch {
        return; // 要素がないページでは何もしない
    }

    listDiv.innerHTML = '';
    if (config.status !== 'configured') {
        host.classList.add('hidden');
        return;
    }
    host.classList.remove('hidden');

    const counts = countAllRefsByFulltextSet();
    const visibleCounts = countVisibleRefsByFulltextSet(config);
    const rows: Array<{ setId: string; count: number; reviewers: string[]; everyone: boolean }> = [];

    for (let i = 1; i <= config.groupCount; i += 1) {
        const setId = `ft-group-${i}`;
        rows.push({
            setId,
            count: counts.get(setId) ?? 0,
            reviewers: config.reviewerMap[setId] || [],
            everyone: false,
        });
    }

    // 未割り当て（割り振り後にプールへ流入した文献）の件数は候補プール依存で、
    // 非管理者の手元には全候補が揃わず正確に数えられない。管理者のときだけ出す。
    if (state.isAdmin) {
        const unassignedCount = getUnassignedPoolRefs(config).length;
        if (unassignedCount > 0) {
            rows.push({ setId: 'unassigned', count: unassignedCount, reviewers: [], everyone: true });
        }
    }

    for (const row of rows) {
        // 担当外セットの扱いは TiAb の canFilter と同じ条件式（管理者は常に操作可能）
        const canFilter = state.isAdmin
            || (visibleCounts.get(row.setId) ?? 0) > 0
            || state.selectedFulltextSets.has(row.setId);

        const wrapper = document.createElement('div');
        wrapper.className = canFilter ? 'source-file-item' : 'source-file-item is-out-of-scope';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `fulltext-assignment-set-${row.setId}`;
        checkbox.checked = canFilter && state.selectedFulltextSets.has(row.setId);
        checkbox.disabled = !canFilter;
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.addSelectedFulltextSet(row.setId);
            } else {
                state.removeSelectedFulltextSet(row.setId);
            }
            void persistSelectedFulltextSets();
            if (_rerenderTab) _rerenderTab();
        });

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        if (!canFilter) {
            label.title = t('assignment_filterOutOfScope');
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${getFulltextSetLabel(row.setId)} (${row.count})`;

        const reviewerSpan = document.createElement('span');
        reviewerSpan.className = 'assignment-set-reviewers';
        if (row.everyone) {
            reviewerSpan.textContent = ` — ${t('assignment_filterReviewersAll')}`;
        } else if (row.reviewers.length === 0) {
            reviewerSpan.textContent = ` — ${t('assignment_filterReviewersNone')}`;
        } else {
            reviewerSpan.append(' — ');
            const myEmail = normalizeEmail(state.userEmail);
            row.reviewers.forEach((email, index) => {
                if (index > 0) reviewerSpan.append(', ');
                const localPart = email.split('@')[0] || email;
                if (myEmail && normalizeEmail(email) === myEmail) {
                    // 管理者が意図せず自分をグループに残したままにする事故を可視化するため強調表示
                    const strong = document.createElement('strong');
                    strong.textContent = `${localPart}${t('ftAssign_selfSuffix')}`;
                    reviewerSpan.appendChild(strong);
                } else {
                    reviewerSpan.append(localPart);
                }
            });
            reviewerSpan.title = row.reviewers.join(', ');
        }

        label.appendChild(nameSpan);
        label.appendChild(reviewerSpan);

        wrapper.appendChild(checkbox);
        wrapper.appendChild(label);
        listDiv.appendChild(wrapper);
    }
}

/**
 * 選択状態を platform().storageSet で永続化する（サイドパネルは chrome.storage.local を直接呼ばない）。
 * 値は他プロジェクト分と共存する { [spreadsheetId]: string[] } 形式なので、読み直してから該当キーだけ更新する。
 */
async function persistSelectedFulltextSets(): Promise<void> {
    try {
        const stored = await platform().storageGet([STORAGE_KEY]);
        const map = { ...(stored[STORAGE_KEY] as Record<string, string[]> | undefined) };
        map[state.spreadsheetId] = Array.from(state.selectedFulltextSets);
        await platform().storageSet({ [STORAGE_KEY]: map });
    } catch (error) {
        console.warn('[ftAssign] 選択状態の保存に失敗:', error);
    }
}

/**
 * 担当セットフィルタの選択状態を初期化する（保存値の読み込み＋正規化、無ければ初期選択）。
 * project.ts の loadDataAndShowScreening から、state.fulltextAssignment 設定後に呼ぶ。
 */
export async function initializeFulltextAssignmentSelection(spreadsheetId: string, userEmail: string): Promise<void> {
    const config = state.fulltextAssignment;
    let selected = initialSelectedFulltextSets(config, userEmail);
    try {
        const stored = await platform().storageGet([STORAGE_KEY]);
        const map = stored[STORAGE_KEY] as Record<string, string[]> | undefined;
        const storedForProject = map?.[spreadsheetId];
        if (storedForProject) {
            selected = normalizeStoredFulltextSets(storedForProject, config, userEmail);
        }
    } catch (error) {
        console.warn('[ftAssign] 選択状態の読み込みに失敗:', error);
    }
    state.setSelectedFulltextSets(selected);
}

/**
 * 担当外グループを表示中/担当グループが選択から外れている状態を、担当グループだけの選択に戻す。
 * チェックリスト項目2の修復ボタン（fulltext-checklist.ts）から呼ぶ。
 */
export async function resetFulltextSetSelectionToMine(): Promise<void> {
    state.setSelectedFulltextSets(initialSelectedFulltextSets(state.fulltextAssignment, state.userEmail));
    await persistSelectedFulltextSets();
    if (_rerenderTab) _rerenderTab();
}

/** フルテキストタブの割り振り状態行を描画する（renderFulltextTab から呼ぶ） */
export function renderFulltextAssignmentRow(): void {
    const line = dom.fulltextAssignmentLine;
    const btn = dom.fulltextAssignmentEditBtn;
    const config = state.fulltextAssignment;

    btn.classList.toggle('hidden', !state.isAdmin);
    renderFulltextAssignmentBreakdown(config);

    if (config.status !== 'configured') {
        line.textContent = t('ftAssign_lineNone');
        btn.textContent = t('ftAssign_set');
        return;
    }

    btn.textContent = t('ftAssign_edit');

    const parts: string[] = [t('ftAssign_lineConfigured', String(config.groupCount))];

    if (state.isAdmin) {
        const unassigned = getUnassignedPoolRefs(config).length;
        if (unassigned > 0) {
            parts.push(t('ftAssign_lineUnassigned', String(unassigned)));
        }
    } else {
        const mySets = getFulltextSetsForUser(config, state.userEmail);
        const labels = Array.from(mySets).sort().map(getFulltextSetLabel);
        parts.push(labels.length > 0
            ? t('ftAssign_lineMyGroups', labels.join(', '))
            : t('ftAssign_lineMyGroupsNone'));
    }

    line.textContent = parts.join(' / ');
}

/** イベントリスナー設定（setupFulltextTabListeners から呼ぶ） */
export function setupFulltextAssignmentListeners(): void {
    dom.fulltextAssignmentEditBtn?.addEventListener('click', () => {
        void openFulltextAssignmentWizard();
    });
}

// ---------------------------------------------------------------------------
// ウィザード
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
    return (email || '').trim().toLowerCase();
}

/**
 * 担当者の選択肢に出すメンバー候補を集める:
 * プロジェクトの共有ユーザー（Drive/シート権限） + TiAb割り振りの担当者
 * + 既存フルテキスト割り振りの担当者 + 自分
 */
async function collectKnownMembers(initialConfig: FulltextAssignmentConfig): Promise<string[]> {
    const members = new Set<string>();

    try {
        const permissions = await getSpreadsheetPermissions(state.spreadsheetId);
        for (const p of permissions) {
            const email = normalizeEmail(p.emailAddress);
            if (email) members.add(email);
        }
    } catch (error) {
        // 権限一覧が読めない場合（スコープ不足等）でも手入力での追加は可能なので続行
        console.warn('[ftAssign] 共有ユーザー一覧の取得に失敗:', error);
    }

    for (const reviewers of Object.values(state.assignmentConfig.reviewerMap || {})) {
        for (const r of reviewers || []) {
            const email = normalizeEmail(r);
            if (email) members.add(email);
        }
    }
    for (const reviewers of Object.values(initialConfig.reviewerMap || {})) {
        for (const r of reviewers || []) {
            const email = normalizeEmail(r);
            if (email) members.add(email);
        }
    }
    if (state.userEmail) members.add(normalizeEmail(state.userEmail));

    return Array.from(members).sort();
}

async function openFulltextAssignmentWizard(): Promise<void> {
    if (_wizardOpen) return;
    if (!state.isAdmin || !state.spreadsheetId) return;

    // プールが確定していない状態（候補ルール未設定）での割り振りは、判定が増えるたびに
    // 対象集合が揺れて意味をなさないためブロックする
    if (!state.fulltextPoolRule) {
        showToast(t('ftAssign_needRule'), 4000);
        return;
    }

    const pool = getFulltextPoolList();
    if (pool.length === 0) {
        showToast(t('ftAssign_emptyPool'), 4000);
        return;
    }

    const isConfigured = state.fulltextAssignment.status === 'configured';
    const initialConfig = isConfigured
        ? state.fulltextAssignment
        : createDefaultFulltextAssignment();

    // 共有済みユーザーを選択肢として読み込む（新規メールは画面内で追加できる）
    showLoading(true);
    let knownMembers: string[];
    try {
        knownMembers = await collectKnownMembers(initialConfig);
    } finally {
        showLoading(false);
    }

    // グループごとの選択状態（グリッド再描画をまたいで保持）
    const checkedBySet = new Map<string, Set<string>>();
    for (const [setId, reviewers] of Object.entries(initialConfig.reviewerMap || {})) {
        checkedBySet.set(setId, new Set((reviewers || []).map(normalizeEmail).filter(Boolean)));
    }

    const container = document.createElement('div');
    container.className = 'assignment-wizard';

    const intro = document.createElement('p');
    intro.className = 'assignment-help';
    intro.textContent = t('ftAssign_wizardIntro');

    const total = document.createElement('p');
    total.className = 'assignment-summary';
    total.textContent = t('ftAssign_wizardSummary', String(pool.length));

    // 設定後にロールごとにどう見えるかのサマリ。件数はグループ数・担当者選択に依存せず
    // プール全体の件数（getFulltextPoolList().length）を使う
    const rolePreview = document.createElement('div');
    rolePreview.className = 'assignment-role-preview';
    const rolePreviewHeading = document.createElement('p');
    rolePreviewHeading.className = 'assignment-role-preview-heading';
    rolePreviewHeading.textContent = t('ftAssign_wizardRolePreviewHeading');
    const rolePreviewList = document.createElement('ul');
    for (const key of [
        'ftAssign_wizardRolePreviewAdmin',
        'ftAssign_wizardRolePreviewReviewer',
        'ftAssign_wizardRolePreviewBlind',
    ] as const) {
        const item = document.createElement('li');
        item.textContent = key === 'ftAssign_wizardRolePreviewAdmin'
            ? t(key, String(pool.length))
            : t(key);
        rolePreviewList.appendChild(item);
    }
    rolePreview.appendChild(rolePreviewHeading);
    rolePreview.appendChild(rolePreviewList);

    const form = document.createElement('div');
    form.className = 'assignment-wizard-form';

    const groupCountRow = document.createElement('div');
    groupCountRow.className = 'assignment-form-row';
    const groupCountLabel = document.createElement('label');
    groupCountLabel.htmlFor = 'ft-assignment-group-count';
    groupCountLabel.textContent = t('ftAssign_wizardGroupCountLabel');
    const groupCountInput = document.createElement('input');
    groupCountInput.type = 'number';
    groupCountInput.id = groupCountLabel.htmlFor;
    groupCountInput.min = '1';
    groupCountInput.max = String(Math.max(pool.length, 1));
    groupCountInput.value = String(Math.max(initialConfig.groupCount || 2, 1));
    groupCountRow.appendChild(groupCountLabel);
    groupCountRow.appendChild(groupCountInput);
    form.appendChild(groupCountRow);

    const preview = document.createElement('p');
    preview.className = 'assignment-preview';

    const renderPreview = () => {
        const groupCountRaw = parseInt(groupCountInput.value || '', 10);
        if (Number.isNaN(groupCountRaw) || groupCountRaw < 1) {
            preview.textContent = t('ftAssign_wizardPreviewInvalid');
            preview.classList.add('assignment-preview--invalid');
            return;
        }
        preview.classList.remove('assignment-preview--invalid');
        const perTeam = Math.ceil(pool.length / groupCountRaw);
        preview.textContent = t('ftAssign_wizardPreview', [
            String(pool.length),
            String(groupCountRaw),
            String(perTeam),
        ]);
    };

    const reviewerHelp = document.createElement('p');
    reviewerHelp.className = 'assignment-help';
    reviewerHelp.textContent = t('ftAssign_wizardReviewerHelp');

    const reviewerGrid = document.createElement('div');
    reviewerGrid.className = 'assignment-group-grid';

    /** 現在のチェック状態から reviewerMap を組み立てる */
    const buildReviewerMap = (groupCount: number): Record<string, string[]> => {
        const reviewerMap: Record<string, string[]> = {};
        for (let index = 1; index <= groupCount; index += 1) {
            const setId = `ft-group-${index}`;
            reviewerMap[setId] = Array.from(checkedBySet.get(setId) ?? new Set<string>());
        }
        return normalizeFulltextReviewerMap(reviewerMap);
    };

    const renderReviewerGrid = () => {
        const groupCount = Math.max(parseInt(groupCountInput.value || '0', 10), 1);
        reviewerGrid.innerHTML = '';

        for (let index = 1; index <= groupCount; index += 1) {
            const setId = `ft-group-${index}`;
            const checked = checkedBySet.get(setId) ?? new Set<string>();
            checkedBySet.set(setId, checked);

            const block = document.createElement('div');
            block.className = 'assignment-group-row';

            const label = document.createElement('label');
            label.textContent = t('ftAssign_wizardReviewerLabel', String(index));
            block.appendChild(label);

            if (knownMembers.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'assignment-help';
                empty.textContent = t('ftAssign_noMembers');
                block.appendChild(empty);
            }

            for (const email of knownMembers) {
                const row = document.createElement('div');
                row.className = 'source-file-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `ft-assignment-${setId}-${email}`;
                checkbox.checked = checked.has(email);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        checked.add(email);
                    } else {
                        checked.delete(email);
                    }
                });

                const memberLabel = document.createElement('label');
                memberLabel.htmlFor = checkbox.id;
                memberLabel.textContent = email;

                row.appendChild(checkbox);
                row.appendChild(memberLabel);
                block.appendChild(row);
            }

            reviewerGrid.appendChild(block);
        }
    };

    // 新しいレビュアーの追加: メールを選択肢に加える（全グループでチェック可能になる）
    const addMemberRow = document.createElement('div');
    addMemberRow.className = 'assignment-form-row';
    const addMemberInput = document.createElement('input');
    addMemberInput.type = 'text';
    addMemberInput.placeholder = t('ftAssign_addMemberPlaceholder');
    const addMemberBtn = document.createElement('button');
    addMemberBtn.className = 'btn btn-outline btn-small';
    addMemberBtn.textContent = t('ftAssign_addMemberBtn');
    const addMember = () => {
        const email = normalizeEmail(addMemberInput.value);
        if (!email || !email.includes('@')) {
            showToast(t('ftAssign_addMemberInvalid'));
            return;
        }
        addMemberInput.value = '';
        if (!knownMembers.includes(email)) {
            knownMembers.push(email);
            knownMembers.sort();
            renderReviewerGrid();
            showToast(t('ftAssign_addMemberDone', email));
        }
    };
    addMemberBtn.addEventListener('click', addMember);
    addMemberInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addMember();
        }
    });
    addMemberRow.appendChild(addMemberInput);
    addMemberRow.appendChild(addMemberBtn);

    const addMemberHelp = document.createElement('p');
    addMemberHelp.className = 'assignment-help';
    addMemberHelp.textContent = t('ftAssign_addMemberHelp');

    groupCountInput.addEventListener('input', () => {
        renderPreview();
        renderReviewerGrid();
    });
    renderPreview();
    renderReviewerGrid();

    container.appendChild(intro);
    container.appendChild(total);
    container.appendChild(rolePreview);
    container.appendChild(form);
    container.appendChild(preview);
    container.appendChild(reviewerHelp);
    container.appendChild(reviewerGrid);
    container.appendChild(addMemberRow);
    container.appendChild(addMemberHelp);

    // 未割り当て文献の追加配分（既存の割り振りを保ったまま新規流入分だけ配る）
    if (isConfigured) {
        const unassigned = getUnassignedPoolRefs(state.fulltextAssignment);
        if (unassigned.length > 0) {
            const row = document.createElement('div');
            row.className = 'assignment-form-row';
            const note = document.createElement('span');
            note.className = 'assignment-help';
            note.textContent = t('ftAssign_unassignedNote', String(unassigned.length));
            const distributeBtn = document.createElement('button');
            distributeBtn.className = 'btn btn-outline btn-small';
            distributeBtn.textContent = t('ftAssign_distributeBtn');
            distributeBtn.addEventListener('click', () => {
                void handleDistributeUnassigned(distributeBtn);
            });
            row.appendChild(note);
            row.appendChild(distributeBtn);
            container.appendChild(row);
        }
    }

    const footer = document.createElement('div');
    footer.className = 'assignment-modal-actions';

    if (isConfigured) {
        // 解除: 全員が全候補を判定する状態へ戻す（fulltext_set は残すが無視される）
        const resetButton = document.createElement('button');
        resetButton.className = 'btn btn-outline btn-small';
        resetButton.textContent = t('ftAssign_reset');
        resetButton.addEventListener('click', () => {
            if (!window.confirm(t('ftAssign_resetConfirm'))) return;
            void handleReset();
        });
        footer.appendChild(resetButton);

        // 担当者のみ保存: 再シャッフルせずにグループの担当レビュアーだけ更新する
        // （新規レビュアーの途中参加はチェックを付けてここで保存する）
        const saveMapButton = document.createElement('button');
        saveMapButton.className = 'btn btn-secondary btn-small';
        saveMapButton.textContent = t('ftAssign_saveMapOnly');
        saveMapButton.addEventListener('click', () => {
            void handleSaveMapOnly(buildReviewerMap(initialConfig.groupCount));
        });
        footer.appendChild(saveMapButton);
    }

    const createButton = document.createElement('button');
    createButton.className = 'btn btn-primary btn-small';
    createButton.textContent = isConfigured ? t('ftAssign_reshuffle') : t('ftAssign_create');
    createButton.addEventListener('click', () => {
        if (_ftSaving) return;
        if (isConfigured && !window.confirm(t('ftAssign_reshuffleConfirm'))) return;
        const groupCount = parseInt(groupCountInput.value || '0', 10);
        if (Number.isNaN(groupCount) || groupCount < 1) {
            showToast(t('ftAssign_wizardPreviewInvalid'));
            return;
        }
        void handleCreate(groupCount, buildReviewerMap(groupCount), pool, createButton);
    });
    footer.appendChild(createButton);

    _wizardOpen = true;
    showModal({
        title: t('ftAssign_wizardTitle'),
        body: container,
        footer,
        onClose: () => {
            _wizardOpen = false;
        },
    });
}

/** ローカルの state.references に fulltext_set を反映する（再取得なしで即時反映） */
function applyLocalFulltextSets(assignments: Array<{ refId: string; fulltextSet: string }>): void {
    const bySet = new Map(assignments.map((a) => [a.refId, a.fulltextSet]));
    for (const ref of state.references) {
        const setId = bySet.get(ref.ref_id);
        if (setId !== undefined) {
            ref.fulltext_set = setId;
        }
    }
}

async function handleCreate(
    groupCount: number,
    reviewerMap: Record<string, string[]>,
    pool: ReferenceWithStatus[],
    button?: HTMLButtonElement
): Promise<void> {
    if (_ftSaving) return;
    _ftSaving = true;
    const restoreButton = markButtonSaving(button);
    try {
        showLoading(true);
        const seed = String(Date.now());
        const assignments = buildFulltextSetAssignments(pool.map((r) => r.ref_id), groupCount, seed);
        const nextConfig: FulltextAssignmentConfig = {
            status: 'configured',
            groupCount,
            reviewerMap,
            seed,
            generatedAt: new Date().toISOString(),
        };

        await updateReferenceFulltextSets(state.spreadsheetId, assignments);
        await saveFulltextAssignmentConfig(state.spreadsheetId, nextConfig);
        applyLocalFulltextSets(assignments);
        syncSetFulltextAssignment(nextConfig);
        // 割り振り設定が変わったら選択状態は当てにならない（グループ数変更・再シャッフル・担当者変更）ので、
        // 新しい設定に基づく初期選択へ戻す
        state.setSelectedFulltextSets(initialSelectedFulltextSets(nextConfig, state.userEmail));
        void persistSelectedFulltextSets();
        hideModal();
        showToast(t('ftAssign_created', [String(pool.length), String(groupCount)]), 3000);
        if (_rerenderTab) _rerenderTab();
    } catch (error) {
        console.error('Fulltext assignment create error:', error);
        showToast(t('ftAssign_error', (error as Error).message), 4000);
    } finally {
        _ftSaving = false;
        restoreButton();
        showLoading(false);
    }
}

async function handleSaveMapOnly(reviewerMap: Record<string, string[]>): Promise<void> {
    if (_ftSaving) return;
    const config = state.fulltextAssignment;
    if (config.status !== 'configured') return;

    _ftSaving = true;
    try {
        showLoading(true);
        const nextConfig: FulltextAssignmentConfig = {
            ...config,
            reviewerMap,
        };
        await saveFulltextAssignmentConfig(state.spreadsheetId, nextConfig);
        syncSetFulltextAssignment(nextConfig);
        // 割り振り設定が変わったら選択状態は当てにならない（グループ数変更・再シャッフル・担当者変更）ので、
        // 新しい設定に基づく初期選択へ戻す
        state.setSelectedFulltextSets(initialSelectedFulltextSets(nextConfig, state.userEmail));
        void persistSelectedFulltextSets();
        hideModal();
        showToast(t('ftAssign_mapSaved'), 3000);
        if (_rerenderTab) _rerenderTab();
    } catch (error) {
        console.error('Fulltext assignment map save error:', error);
        showToast(t('ftAssign_error', (error as Error).message), 4000);
    } finally {
        _ftSaving = false;
        showLoading(false);
    }
}

async function handleDistributeUnassigned(button?: HTMLButtonElement): Promise<void> {
    if (_ftSaving) return;
    const config = state.fulltextAssignment;
    if (config.status !== 'configured') return;

    const unassigned = getUnassignedPoolRefs(config);
    if (unassigned.length === 0) return;

    _ftSaving = true;
    const restoreButton = markButtonSaving(button);
    try {
        showLoading(true);
        const assignments = distributeUnassigned(
            unassigned.map((r) => r.ref_id),
            config.groupCount,
            countPoolBySet(config),
            String(Date.now())
        );
        await updateReferenceFulltextSets(state.spreadsheetId, assignments);
        applyLocalFulltextSets(assignments);
        hideModal();
        showToast(t('ftAssign_distributed', String(assignments.length)), 3000);
        if (_rerenderTab) _rerenderTab();
    } catch (error) {
        console.error('Fulltext assignment distribute error:', error);
        showToast(t('ftAssign_error', (error as Error).message), 4000);
    } finally {
        _ftSaving = false;
        restoreButton();
        showLoading(false);
    }
}

async function handleReset(): Promise<void> {
    if (_ftSaving) return;
    const config = state.fulltextAssignment;

    _ftSaving = true;
    try {
        showLoading(true);
        const nextConfig: FulltextAssignmentConfig = {
            ...config,
            status: 'none',
        };
        await saveFulltextAssignmentConfig(state.spreadsheetId, nextConfig);
        syncSetFulltextAssignment(nextConfig);
        // 割り振り設定が変わったら選択状態は当てにならない（グループ数変更・再シャッフル・担当者変更）ので、
        // 新しい設定に基づく初期選択へ戻す（status='none' なら initialSelectedFulltextSets は空集合を返す）
        state.setSelectedFulltextSets(initialSelectedFulltextSets(nextConfig, state.userEmail));
        void persistSelectedFulltextSets();
        hideModal();
        showToast(t('ftAssign_resetDone'), 3000);
        if (_rerenderTab) _rerenderTab();
    } catch (error) {
        console.error('Fulltext assignment reset error:', error);
        showToast(t('ftAssign_error', (error as Error).message), 4000);
    } finally {
        _ftSaving = false;
        showLoading(false);
    }
}
