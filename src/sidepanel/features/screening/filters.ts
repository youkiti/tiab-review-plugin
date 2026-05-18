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
import { deleteReferencesBySourceFile } from '../../../lib/sheets-api';
import { showToast, showLoading } from '../../ui/feedback';
import { isHumanDecision, isConfirmedMlDecision, isMlDecision } from '../../../lib/client-version';
import { getReferenceAssignmentSet } from '../assignment';

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
 * フルテキスト候補の判定
 * 手動（複数人含む）、ML、LLMの3カテゴリのうち、2つ以上が「Include」であるかを判定
 */
function isFulltextCandidate(r: ReferenceWithStatus): boolean {
    let includeCategories = 0;  // Includeと判定したカテゴリ数

    const userEmail = state.userEmail;

    // ヘルパー: 特定の条件でInclude判定があるか
    const hasInclude = (check: (d: Decision) => boolean) => {
        return (r.allDecisions?.some(d => check(d) && d.decision === 'include')) ||
            (r.myDecision && check(r.myDecision) && r.myDecision.decision === 'include');
    };

    // 1. 手動判定（複数人対応）
    // treatMlAsManualがONの場合、0.7.0-mlも手動判定（ただし自分のものに限る）として扱う
    // ※ 他人の判定の場合は、その人がMLを使っていても手動扱いとするかどうかは議論の余地があるが、
    //    ここではシンプルに「バージョン」で判断する。
    //    ただしisFulltextCandidateは「カテゴリ」のカウントなので、
    //    「手動」カテゴリにMLを含めるかどうかが重要。

    // 手動カテゴリ判定条件:
    // - client_version === '0.1.0' (純粋手動)
    // - OR (treatMlAsManual && client_version startsWith '0.7.0-ml' && reviewer_id === me) (自分のML判定)
    const isManual = (d: Decision) => {
        if (isHumanDecision(d.client_version)) return true;
        if (state.treatMlAsManual && d.reviewer_id === userEmail && isConfirmedMlDecision(d.client_version)) {
            return true;
        }
        return false;
    };

    if (hasInclude(isManual)) includeCategories++;

    // 2. ML判定
    // treatMlAsManualがONの場合、ここでのカウントはどうするか？
    // 「手動」でカウント済みなら「ML」ではカウントしないべきか？（二重計上防止）
    // -> はい。ただし、「自分の手動(ML含む)」とは別に「純粋なシステムML推論」があるならそれをカウントすべき。
    //    現状のシステム構成では '0.7.0-ml' はユーザーの確認済みアクション。
    //    -ml を含む他の判定（自動判定など）があればここでカウント。
    //    '0.7.0-ml' (確認済み) は isManual で拾われるので、ここでは
    //    '0.7.0-ml' 以外で -ml を含むもの（例: -ml-auto）を対象にするのが適切かもしれないが、
    //    現状の定義では -ml を含む判定はすべてMLカテゴリだった。

    // 修正方針:
    // treatMlAsManual = true の場合:
    //   - 手動カテゴリ: 0.1.0 OR 0.7.0-ml
    //   - MLカテゴリ: -mlを含むもの (ただし0.7.0-mlですでに手動カウントされた判定と重複してカテゴリ2を満たすのは避けたい)
    //   
    //   例: 0.7.0-ml で include した場合
    //   -> 手動カテゴリ: OK
    //   -> MLカテゴリ: OK (既存ロジックだと)
    //   -> 合計2カテゴリ -> フルテキスト候補になってしまう。これは意図通りか？
    //      「MDとML両方でInclude」=有力候補。
    //      しかし、同一判定が両方に寄与するのはおかしい。
    //      
    //      したがって、MLカテゴリの判定では「手動カテゴリでカウントされた判定」を除外する必要がある。

    const isMl = (d: Decision) => {
        // ML系である
        if (!isMlDecision(d.client_version)) return false;

        // 手動とみなされたものは除外
        if (isManual(d)) return false;

        return true;
    };

    if (hasInclude(isMl)) includeCategories++;

    // 3. LLM判定 - reviewer_idがllm:で始まる判定
    const llmInclude = r.allDecisions?.some(d =>
        d.reviewer_id.startsWith('llm:') &&
        d.decision === 'include'
    );

    if (llmInclude) includeCategories++;

    return includeCategories >= 2;
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
        filtered = filtered.filter(isFulltextCandidate);
    } else if (state.currentFilter === 'conflict') {
        // 不一致は合成ステータスをそのまま使用
        filtered = filtered.filter((r) => r.status === 'conflict');
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

    // AI判定フィルター (Blind off時のみ、かつ少なくとも1つチェックが外れている場合)
    if (state.isKeyOpened && (!state.aiDecisionFilter.include || !state.aiDecisionFilter.exclude)) {
        filtered = filtered.filter(r => {
            // AI判定を取得
            const aiDecisions = r.allDecisions?.filter(d => d.reviewer_id.startsWith('llm:')) || [];

            // AI判定がない場合は常に表示（フィルター対象外）
            if (aiDecisions.length === 0) return true;

            // AI判定がある場合、表示許可されている判定が1つでもあればOK
            // Include許可 かつ Include判定がある -> OK
            // Exclude許可 かつ Exclude判定がある -> OK
            const hasAllowedDecision = aiDecisions.some(d => {
                if (d.decision === 'include' && state.aiDecisionFilter.include) return true;
                if (d.decision === 'exclude' && state.aiDecisionFilter.exclude) return true;
                // maybe, pending, conflict等はフィルター対象外として表示
                if (d.decision !== 'include' && d.decision !== 'exclude') return true;
                return false;
            });

            return hasAllowedDecision;
        });
    }

    return filtered;
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

    const counts = {
        pending: filtered.filter(r => getMyManualDecisionStatus(r) === 'pending').length,
        all: filtered.length,
        include: filtered.filter(r => getMyManualDecisionStatus(r) === 'include').length,
        exclude: filtered.filter(r => getMyManualDecisionStatus(r) === 'exclude').length,
        maybe: filtered.filter(r => getMyManualDecisionStatus(r) === 'maybe').length,
        conflict: filtered.filter(r => r.status === 'conflict').length,  // 不一致は合成ステータス
    };

    const options = dom.statusFilter.options;
    options[0].textContent = t('filter_pendingCount', String(counts.pending));
    options[1].textContent = t('filter_allCount', String(counts.all));
    options[2].textContent = t('filter_includeCount', String(counts.include));
    options[3].textContent = t('filter_excludeCount', String(counts.exclude));
    options[4].textContent = t('filter_maybeCount', String(counts.maybe));
    options[5].textContent = t('filter_conflictCount', String(counts.conflict));

    // フルテキスト候補（独立アルゴリズム）
    const fulltextCount = filtered.filter(isFulltextCandidate).length;
    if (options[6]) {
        options[6].textContent = t('filter_fulltextCount', String(fulltextCount));
    }
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

