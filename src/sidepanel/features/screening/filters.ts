/**
 * スクリーニングフィルタリングモジュール
 * Storeのselectorへの計測付き窓口と、フィルターUI・用途別集計。
 */

import { t } from '../../../lib/i18n';
import { state } from '../../state';
import { dom } from '../../dom';
import type { ReferenceWithStatus, DecisionStatus } from '../../../lib/types';
import { getState } from '../../store';
import {
    getFilteredReferences as selectFilteredReferences,
    getMyManualDecisionStatus as selectMyManualDecisionStatus,
    isMyFulltextCandidate as selectMyFulltextCandidate,
    collectRefDecisions,
} from '../../store/selectors';
import { deleteReferencesBySourceFile, saveImportStats } from '../../../lib/sheets-api';
import { showToast, showLoading } from '../../ui/feedback';
import { describeRule } from '../../../lib/fulltext-pool';
import { matchesSelectedFulltextSets } from '../../../lib/fulltext-assignment';
import { isFulltextCandidateRef, isProjectFulltextCandidateRef } from '../../../lib/fulltext-candidates';
import { getReferenceAssignmentSet } from '../assignment';
import { hasEffectiveConflict } from '../../render/helpers';
import { renderDuplicateReviewSection } from '../duplicate-review';
import { perfSpanSync } from '../../../lib/perf';

// Store互換レイヤー（Phase 3）
import {
    setSearchQuery as syncSetSearchQuery,
    setCurrentFilter as syncSetCurrentFilter,
    addTermFilter as syncAddTermFilter,
    removeTermFilter as syncRemoveTermFilter,
    addSelectedSourceFile as syncAddSelectedSourceFile,
    removeSelectedSourceFile as syncRemoveSelectedSourceFile,
    deleteSourceFile as syncDeleteSourceFile,
} from '../../store/compat';

// 外部描画関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setFilterDependencies(deps: {
    renderCurrentReference: () => void;
    loadDataAndShowScreening: () => Promise<void>;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
    _loadDataAndShowScreening = deps.loadDataAndShowScreening;
}

/**
 * フルテキスト候補の判定（isFulltextCandidateRef に委譲。詳細は fulltext-candidates.ts 参照）
 */
function isFulltextCandidate(r: ReferenceWithStatus): boolean {
    return isFulltextCandidateRef({
        ref: r,
        decisions: collectRefDecisions(r),
        poolRule: state.fulltextPoolRule,
        assignment: state.fulltextAssignment,
        userEmail: state.userEmail,
        isAdmin: state.isAdmin,
    });
}

/**
 * フルテキスト候補のうち自分の担当分か
 * （担当割り振り未設定なら全候補、管理者は常に全候補、未割り当て文献は全員に表示）
 */
function isMyFulltextCandidate(r: ReferenceWithStatus): boolean {
    return selectMyFulltextCandidate(r, getState().data);
}

/**
 * フルテキスト候補の一覧を取得（フルテキストタブで使用・自分の担当分のみ）
 */
export function getFulltextCandidateList(): ReferenceWithStatus[] {
    return state.references.filter(isMyFulltextCandidate);
}

/**
 * 候補プール全体（担当割り振りを適用しない）。割り振りウィザードの分配対象に使う。
 */
export function getFulltextPoolList(): ReferenceWithStatus[] {
    return state.references.filter(isFulltextCandidate);
}

/**
 * フルテキスト候補一覧に、担当セットのチェックボックス絞り込み（state.selectedFulltextSets）を
 * 適用したもの。候補一覧・入手状況・一括OA検索・AI一括判定など「表示中の作業対象」に使う。
 * Drive取り込み対応付けは getFulltextCandidateList() をそのまま使い続け、この絞り込みの影響を受けない。
 * PRISMA の分母に関わる結果タブ・論文用テキストは getProjectFulltextCandidateList() を使う
 * （ログインユーザーや担当割り振りに依存させないため）。
 */
export function getVisibleFulltextCandidateList(): ReferenceWithStatus[] {
    return getFulltextCandidateList().filter((r) =>
        matchesSelectedFulltextSets(r, state.fulltextAssignment, state.selectedFulltextSets)
    );
}

/**
 * プロジェクト全体のフルテキスト候補一覧（ログインユーザー・担当割り振りに依存しない）。
 * state.allReferences（担当割り振りで絞り込まれる前の全文献）を走査し、
 * canSeeFulltextRef / matchesSelectedFulltextSets のいずれも適用しない。
 * PRISMA の数値・論文用テキスト・CSV/RIS エクスポートなど、誰がログインしていても
 * 同じ結果でなければならない集計に使う。
 */
export function getProjectFulltextCandidateList(): ReferenceWithStatus[] {
    return state.allReferences.filter((r) =>
        isProjectFulltextCandidateRef({
            ref: r,
            decisions: collectRefDecisions(r),
            poolRule: state.fulltextPoolRule,
            assignment: state.fulltextAssignment,
        })
    );
}

/** 自分の手動判定ステータスはStoreのselectorへ委譲する。 */
export function getMyManualDecisionStatus(r: ReferenceWithStatus): DecisionStatus {
    return selectMyManualDecisionStatus(r, state.userEmail, state.treatMlAsManual);
}

/** フィルタリング済み文献リストを取得する計測付き窓口。 */
export function getFilteredReferences(): ReferenceWithStatus[] {
    // Issue #151: selector統合後も同じ計測名と入力件数を維持する。
    return perfSpanSync('tiab:screening.filter', () => selectFilteredReferences(getState()), { inputCount: state.references.length });
}

/**
 * スクリーニング件数（pending/all/include/exclude/maybe/conflict）を計算する
 * - 対象配列は呼び出し側が渡す（統計フィルタは絞り込み後の配列、TiAb完了バナーは state.references 全体）
 * - enabledReviewers / isKeyOpened / treatMlAsManual は既存の updateFilterCounts と同じく state から直接参照する
 */
export function getScreeningCounts(refs: ReferenceWithStatus[]) {
    // 5回 filter() を回す代わりに1回の for ループで判定し、各文献につき
    // getMyManualDecisionStatus() / hasEffectiveConflict() をそれぞれ1回だけ呼ぶ
    // （Issue #152（#150 工程1））。
    let pending = 0;
    let include = 0;
    let exclude = 0;
    let maybe = 0;
    let conflict = 0;

    for (const r of refs) {
        switch (getMyManualDecisionStatus(r)) {
            case 'pending': pending++; break;
            case 'include': include++; break;
            case 'exclude': exclude++; break;
            case 'maybe': maybe++; break;
        }
        if (hasEffectiveConflict(r, state.enabledReviewers, state.isKeyOpened, state.treatMlAsManual)) {
            conflict++;
        }
    }

    return { pending, all: refs.length, include, exclude, maybe, conflict };
}

/**
 * フィルターの件数を更新
 */
export function updateFilterCounts() {
    // Issue #151（#150 工程0）: tiab:screening.counts として計測。
    return perfSpanSync('tiab:screening.counts', () => updateFilterCountsImpl());
}

function updateFilterCountsImpl() {
    // ソースファイルフィルターを適用したものでカウント
    let filtered = state.references;
    if (state.selectedSourceFiles.size > 0 && state.selectedSourceFiles.size < state.sourceFiles.size) {
        filtered = state.references.filter(r => r.source_file && state.selectedSourceFiles.has(r.source_file));
    }

    if (state.assignmentSets.size > 0 && state.selectedAssignmentSets.size < state.assignmentSets.size) {
        filtered = filtered.filter((r) => state.selectedAssignmentSets.has(getReferenceAssignmentSet(r)));
    }

    const counts = getScreeningCounts(filtered);

    // フルテキスト候補（独立アルゴリズム・自分の担当分のみ）
    const fulltextCount = filtered.filter(isMyFulltextCandidate).length;

    // option の value をキーにラベルを割り当てる。
    // （optgroup で並び順を変えても壊れないよう index ではなく value で対応付ける）
    const labels: Record<string, string> = {
        pending: t('filter_pendingCount', String(counts.pending)),
        all: t('filter_allCount', String(counts.all)),
        include: t('filter_includeCount', String(counts.include)),
        exclude: t('filter_excludeCount', String(counts.exclude)),
        maybe: t('filter_maybeCount', String(counts.maybe)),
        conflict: t('filter_conflictCount', String(counts.conflict)),
        fulltext_candidates: fulltextCandidateOptionLabel(fulltextCount),
    };
    for (const opt of Array.from(dom.statusFilter.options)) {
        const label = labels[opt.value];
        if (label !== undefined) opt.textContent = label;
    }

    updateFulltextTabBadge(fulltextCount);
}

/**
 * 「📄 全文」タブの候補件数バッジを更新する
 * - 件数は上記の fulltextCount（isMyFulltextCandidate、ソースファイル／担当セット絞り込み込み）をそのまま流用
 * - 0件なら非表示
 * - TiAb完了時（自分の未判定0件かつ文献1件以上。絞り込みの影響を受けない全体基準）はパルスさせて次工程への気づきを促す
 */
function updateFulltextTabBadge(count: number): void {
    const badge = dom.tabFulltextBadge;
    if (count === 0) {
        badge.classList.add('hidden');
        badge.textContent = '';
        badge.classList.remove('pulse');
        return;
    }

    badge.textContent = String(count);
    badge.title = t('nav_tabFulltextBadgeTitle', String(count));
    badge.classList.remove('hidden');

    // pulse要否は「未判定が0件か」だけ分かればよいため、getScreeningCounts()（全件に対し
    // フィルタ5回＋不一致判定1回）は使わず some() の短絡評価で済ませる。
    // 矢印キーでの文献移動のたびに走る処理のため、数千件規模でも軽量に保つ。
    const isTiabDone = state.references.length > 0
        && !state.references.some(r => getMyManualDecisionStatus(r) === 'pending');
    badge.classList.toggle('pulse', isTiabDone);
}

/**
 * フルテキスト候補オプションのラベル（件数に加えて候補判定の根拠を併記し、
 * 「自分のInclude」との違いを画面上で判別できるようにする）
 * - ルール設定済み: 「N票中M票」
 * - 未設定（管理者）: 「誰か1人Include」（＝全レビュアーのIncludeの和集合）
 * - 未設定（非管理者）: 「自分のInclude」
 */
function fulltextCandidateOptionLabel(count: number): string {
    const rule = state.fulltextPoolRule;
    const basis = rule
        ? describeRule(rule)
        : state.isAdmin
            ? t('filter_fulltextBasisAny')
            : t('filter_fulltextBasisSelf');
    return t('filter_fulltextCountAnnotated', [basis, String(count)]);
}

/**
 * ソースファイルフィルターを描画
 */
export function renderSourceFilters() {
    // 独立セクション（重複の確認）。sourceFiles が0件でも出す必要があるため、
    // 下の早期returnより前で呼ぶこと（Issue #147）。
    renderDuplicateReviewSection();

    dom.sourceFileListDiv.innerHTML = '';

    if (state.sourceFiles.size === 0) {
        dom.sourceFiltersSection.classList.add('hidden');
        return;
    }
    dom.sourceFiltersSection.classList.remove('hidden');

    state.sourceFiles.forEach(file => {
        // このファイルのレコード数をカウント
        const count = state.references.filter(r => r.source_file === file).length;

        const div = document.createElement('div');
        div.className = 'source-file-item';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.justifyContent = 'space-between';

        const leftGroup = document.createElement('div');
        leftGroup.style.display = 'flex';
        leftGroup.style.alignItems = 'center';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `source-${file}`;
        checkbox.checked = state.selectedSourceFiles.has(file);
        checkbox.addEventListener('change', () => {
            state.resetReviewHistoryNavigation();
            // Storeを更新
            if (checkbox.checked) {
                syncAddSelectedSourceFile(file);
            } else {
                syncRemoveSelectedSourceFile(file);
            }
            // 注意: syncAdd/Remove はcurrentIndexを0にリセットする
            if (_renderCurrentReference) _renderCurrentReference();
        });

        const label = document.createElement('label');
        label.htmlFor = `source-${file}`;
        label.textContent = `${file} (${count})`;
        label.style.marginLeft = '8px';

        leftGroup.appendChild(checkbox);
        leftGroup.appendChild(label);

        // Delete Button
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = t('filter_deleteFile');
        deleteBtn.className = 'btn-icon';
        deleteBtn.style.marginLeft = '8px';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (confirm(t('filter_deleteConfirm', [file, String(count)]))) {
                try {
                    showLoading(true);
                    showToast(t('filter_deleting', file), 5000);

                    const deletedCount = await deleteReferencesBySourceFile(state.spreadsheetId, file);

                    // 対応するインポート統計も削除（PRISMA自動記入の整合性維持）
                    if (state.importStats[file]) {
                        try {
                            const stats = { ...state.importStats };
                            delete stats[file];
                            await saveImportStats(state.spreadsheetId, stats);
                            state.setImportStats(stats);
                        } catch (statsError) {
                            console.log('[deleteSourceFile] Failed to update import stats:', statsError);
                        }
                    }

                    if (_loadDataAndShowScreening) {
                        await _loadDataAndShowScreening();
                    } else {
                        syncDeleteSourceFile(file);
                        if (_renderCurrentReference) _renderCurrentReference();
                    }

                    showToast(t('filter_deleted', String(deletedCount)));

                } catch (err) {
                    console.error('Delete error:', err);
                    showToast(t('filter_deleteError', (err as Error).message));
                } finally {
                    showLoading(false);
                }
            }
        };

        div.appendChild(leftGroup);
        div.appendChild(deleteBtn);
        dom.sourceFileListDiv.appendChild(div);
    });
}

/**
 * ステータスフィルターの変更を処理
 */
export function handleStatusFilterChange() {
    state.resetReviewHistoryNavigation();
    // Storeを更新（currentFilterとcurrentIndex）
    syncSetCurrentFilter(dom.statusFilter.value as DecisionStatus | 'all' | 'fulltext_candidates');
    // 注意: syncSetCurrentFilterはcurrentIndexを0にリセットするので、別途呼び出し不要
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * 検索入力の変更を処理
 */
export function handleSearchInput() {
    state.resetReviewHistoryNavigation();
    // 検索文字列の更新と表示位置のリセットを1回のdispatchで行う。
    syncSetSearchQuery(dom.searchInput.value);
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームフィルターを追加
 */
export function addTermFilter(term: string, type: 'include' | 'exclude') {
    // 既存チェック
    const exists = state.activeTermFilters.some(
        f => f.term.toLowerCase() === term.toLowerCase() && f.type === type
    );
    if (exists) return;

    state.resetReviewHistoryNavigation();
    // Storeを更新（addTermFilterはcurrentIndexを0にリセット）
    syncAddTermFilter(term, type);
    renderActiveTermFilters();
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームフィルターを削除
 */
export function removeTermFilter(term: string, type: string) {
    state.resetReviewHistoryNavigation();
    // Storeを更新（removeTermFilterはcurrentIndexを0にリセット）
    syncRemoveTermFilter(term, type);
    renderActiveTermFilters();
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームクリック処理（イベント委譲用）
 */
export function handleTermClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('highlight-include')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'include');
    } else if (target.classList.contains('highlight-exclude')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'exclude');
    } else if (target.classList.contains('highlight-search')) {
        const term = target.textContent;
        if (term) addTermFilter(term, 'include');
    } else if (target.classList.contains('highlight-evidence')) {
        // AI Evidenceハイライトをクリックした場合もフィルターに追加
        const term = target.textContent;
        if (term) addTermFilter(term, 'include');
    }
}

/**
 * アクティブなタームフィルターを描画
 */
export function renderActiveTermFilters() {
    if (!dom.activeTermFiltersDiv) return;

    if (state.activeTermFilters.length === 0) {
        dom.activeTermFiltersDiv.classList.add('hidden');
        return;
    }

    dom.activeTermFiltersDiv.classList.remove('hidden');
    dom.activeTermFiltersDiv.innerHTML = '';

    for (const filter of state.activeTermFilters) {
        const tag = document.createElement('span');
        tag.className = `term-filter-tag ${filter.type}`;
        tag.innerHTML = `
            ${filter.term}
            <span class="remove-btn" data-term="${filter.term}" data-type="${filter.type}">×</span>
        `;
        dom.activeTermFiltersDiv.appendChild(tag);
    }
}

