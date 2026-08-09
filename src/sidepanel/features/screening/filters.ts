/**
 * スクリーニングフィルタリングモジュール
 * 文献のフィルタリングロジック
 */

import { t } from '../../../lib/i18n';
import { state } from '../../state';
import { dom } from '../../dom';
import type { ReferenceWithStatus, DecisionStatus, Decision } from '../../../lib/types';
import { createSmartRegex } from '../../utils/text';
import { parseSearchQuery } from '../../utils/search';
import { deleteReferencesBySourceFile, saveImportStats } from '../../../lib/sheets-api';
import { showToast, showLoading } from '../../ui/feedback';
import { isHumanDecision, isConfirmedMlDecision } from '../../../lib/client-version';
import { isInFulltextPool, isTiabDecision, describeRule, isProjectFulltextCandidate } from '../../../lib/fulltext-pool';
import { canSeeFulltextRef, matchesSelectedFulltextSets } from '../../../lib/fulltext-assignment';
import { getReferenceAssignmentSet } from '../assignment';
import { hasEffectiveConflict } from '../../render/helpers';

// Store互換レイヤー（Phase 3）
import {
    setCurrentIndex as syncSetCurrentIndex,
    setCurrentFilter as syncSetCurrentFilter,
    addTermFilter as syncAddTermFilter,
    removeTermFilter as syncRemoveTermFilter,
    addSelectedSourceFile as syncAddSelectedSourceFile,
    removeSelectedSourceFile as syncRemoveSelectedSourceFile,
    deleteSourceFile as syncDeleteSourceFile,
    setReferences as syncSetReferences,
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
 * 文献の全判定を集める（allDecisions + myDecision、重複排除）
 */
function collectRefDecisions(r: ReferenceWithStatus): Decision[] {
    const list = [...(r.allDecisions ?? [])];
    if (r.myDecision && !list.some(d => d.decision_id === r.myDecision!.decision_id)) {
        list.push(r.myDecision);
    }
    return list;
}

/**
 * フルテキスト候補の判定
 * - ルール設定済み: FulltextPoolRule（採用voter + 必要票数）で判定
 * - 未設定:
 *   - 管理者: 読み込まれている全レビュアーの TiAb Include が1件でもある文献
 *   - 非管理者: 自分が TiAb で Include した文献
 */
function isFulltextCandidate(r: ReferenceWithStatus): boolean {
    const rule = state.fulltextPoolRule;
    const decisions = collectRefDecisions(r);
    if (rule) {
        return isInFulltextPool(decisions, rule);
    }

    const userEmail = state.userEmail;
    return decisions.some(d =>
        d.decision === 'include' &&
        isTiabDecision(d) &&
        (state.isAdmin || d.reviewer_id === userEmail)
    );
}

/**
 * フルテキスト候補のうち自分の担当分か
 * （担当割り振り未設定なら全候補、管理者は常に全候補、未割り当て文献は全員に表示）
 */
function isMyFulltextCandidate(r: ReferenceWithStatus): boolean {
    return isFulltextCandidate(r)
        && canSeeFulltextRef(r, state.fulltextAssignment, state.userEmail, state.isAdmin);
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
        isProjectFulltextCandidate(collectRefDecisions(r), state.fulltextPoolRule)
    );
}

/**
 * 自分の手動判定ステータスを取得
 * client_version === '0.1.0' の判定のみを手動判定として扱う
 */
/**
 * 自分の手動判定ステータスを取得
 * client_version === '0.1.0' の判定のみを手動判定として扱う
 * ただし treatMlAsManual が true の場合は ML判定(0.7.0-ml)も手動判定として扱う
 */
export function getMyManualDecisionStatus(r: ReferenceWithStatus): DecisionStatus {
    const userEmail = state.userEmail;

    // 判定が自分の手動（またはML許可時のML）かどうか
    const isMyManual = (d: Decision) => {
        if (d.reviewer_id !== userEmail) return false;

        if (isHumanDecision(d.client_version)) return true;

        if (state.treatMlAsManual && isConfirmedMlDecision(d.client_version)) {
            return true;
        }

        return false;
    };

    // allDecisionsから自分の手動判定を探す
    // 複数の判定がある場合（0.1.0と0.7.0-mlが混在など）、最新を優先すべきだが
    // 配列順序は保証されていない。decided_atでソートするか、
    // あるいは単純に見つかったものを返すか。
    // 通常、一人のユーザーが複数判定を持つことはシステム上稀（上書きされるため）。
    // コンフリクト時のみ複数持つ可能性がある。

    // ここでは find で最初に見つかったものを返す（既存ロジック準拠）
    const myManualDecision = r.allDecisions?.find(isMyManual);

    if (myManualDecision) {
        return myManualDecision.decision as DecisionStatus;
    }

    // myDecisionも確認
    if (r.myDecision && isMyManual(r.myDecision)) {
        return r.myDecision.decision as DecisionStatus;
    }

    return 'pending';
}

/**
 * フィルタリング済み文献リストを取得
 */
export function getFilteredReferences(): ReferenceWithStatus[] {
    let filtered = state.references;

    // ステータスフィルター
    if (state.currentFilter === 'fulltext_candidates') {
        filtered = filtered.filter(isMyFulltextCandidate);
    } else if (state.currentFilter === 'conflict') {
        // 不一致は enabledReviewers を反映して動的に計算
        filtered = filtered.filter((r) =>
            hasEffectiveConflict(r, state.enabledReviewers, state.isKeyOpened, state.treatMlAsManual)
        );
    } else if (state.currentFilter !== 'all') {
        // pending, include, exclude, maybe は自分の手動判定(0.1.0)でフィルタリング
        filtered = filtered.filter((r) => getMyManualDecisionStatus(r) === state.currentFilter);
    }

    // ソースファイルフィルター
    if (state.selectedSourceFiles.size > 0 && state.selectedSourceFiles.size < state.sourceFiles.size) {
        filtered = filtered.filter(r => r.source_file && state.selectedSourceFiles.has(r.source_file));
    }

    // 担当セットフィルター
    if (state.assignmentSets.size > 0 && state.selectedAssignmentSets.size < state.assignmentSets.size) {
        filtered = filtered.filter((r) => state.selectedAssignmentSets.has(getReferenceAssignmentSet(r)));
    }

    // 検索フィルター
    const rawSearch = dom.searchInput.value;
    if (rawSearch.trim()) {
        const { terms, mode } = parseSearchQuery(rawSearch, state.termFilterUseAnd);

        filtered = filtered.filter(r => {
            const text = `${r.title} ${r.abstract || ''}`;
            const regexes = terms.map(t => createSmartRegex(t));

            if (mode === 'and') {
                return regexes.every(regex => {
                    regex.lastIndex = 0;
                    return regex.test(text);
                });
            } else {
                return regexes.some(regex => {
                    regex.lastIndex = 0;
                    return regex.test(text);
                });
            }
        });
    }

    // タームフィルター（AND/OR条件）
    const termFilters = state.activeTermFilters;
    if (termFilters.length > 0) {
        if (state.termFilterUseAnd) {
            // AND条件: すべてのtermにマッチ
            for (const termFilter of termFilters) {
                const regex = createSmartRegex(termFilter.term);
                filtered = filtered.filter(r => {
                    const text = `${r.title} ${r.abstract || ''}`;
                    return regex.test(text);
                });
            }
        } else {
            // OR条件: いずれかのtermにマッチ
            filtered = filtered.filter(r => {
                const text = `${r.title} ${r.abstract || ''}`;
                return termFilters.some(termFilter => {
                    const regex = createSmartRegex(termFilter.term);
                    return regex.test(text);
                });
            });
        }
    }

    // 判定フィルター (Blind off時のみ、レビュアーごとに独立して適用)
    if (state.isKeyOpened) {
        for (const [reviewerId, filter] of Object.entries(state.aiDecisionFilter)) {
            // 無効化されたレビュアーはフィルター対象外
            if (!state.enabledReviewers.has(reviewerId)) continue;

            const allowed = new Set<string>();
            if (filter.include) allowed.add('include');
            if (filter.exclude) allowed.add('exclude');
            if (filter.maybe ?? true) allowed.add('maybe');
            // 全ON or 全OFF はこのレビュアーのフィルターを適用しない
            if (allowed.size === 3 || allowed.size === 0) continue;

            filtered = filtered.filter(r => {
                const decision = r.allDecisions?.find(d => d.reviewer_id === reviewerId);
                if (!decision) return false; // 該当レビュアーの判定が無いレコードは非表示
                return allowed.has(decision.decision);
            });
        }
    }

    return filtered;
}

/**
 * スクリーニング件数（pending/all/include/exclude/maybe/conflict）を計算する
 * - 対象配列は呼び出し側が渡す（統計フィルタは絞り込み後の配列、TiAb完了バナーは state.references 全体）
 * - enabledReviewers / isKeyOpened / treatMlAsManual は既存の updateFilterCounts と同じく state から直接参照する
 */
export function getScreeningCounts(refs: ReferenceWithStatus[]) {
    return {
        pending: refs.filter(r => getMyManualDecisionStatus(r) === 'pending').length,
        all: refs.length,
        include: refs.filter(r => getMyManualDecisionStatus(r) === 'include').length,
        exclude: refs.filter(r => getMyManualDecisionStatus(r) === 'exclude').length,
        maybe: refs.filter(r => getMyManualDecisionStatus(r) === 'maybe').length,
        conflict: refs.filter(r =>
            hasEffectiveConflict(r, state.enabledReviewers, state.isKeyOpened, state.treatMlAsManual)
        ).length,
    };
}

/**
 * フィルターの件数を更新
 */
export function updateFilterCounts() {
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
            // Store経由で両方に同期
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
    // Store経由で両方に同期（currentFilterとcurrentIndex）
    syncSetCurrentFilter(dom.statusFilter.value as DecisionStatus | 'all' | 'fulltext_candidates');
    // 注意: syncSetCurrentFilterはcurrentIndexを0にリセットするので、別途呼び出し不要
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * 検索入力の変更を処理
 */
export function handleSearchInput() {
    state.resetReviewHistoryNavigation();
    // Store経由でインデックスをリセット
    syncSetCurrentIndex(0);
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
    // Store経由で両方に同期（addTermFilterはcurrentIndexを0にリセット）
    syncAddTermFilter(term, type);
    renderActiveTermFilters();
    if (_renderCurrentReference) _renderCurrentReference();
}

/**
 * タームフィルターを削除
 */
export function removeTermFilter(term: string, type: string) {
    state.resetReviewHistoryNavigation();
    // Store経由で両方に同期（removeTermFilterはcurrentIndexを0にリセット）
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

