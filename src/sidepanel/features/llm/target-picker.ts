/**
 * AI一括判定の対象選択モーダル
 *
 * 担当セット単位＋個別チェックボックスで、AIに判定させる ref_id を人間が限定できるようにする。
 * モーダルを開いた時点の state.llmTargetRefIds を複製した下書き集合（draft）だけを操作し、
 * 「確定する」を押すまで state・Config シートには反映しない。✕で閉じた場合は draft を
 * 単に捨てるだけでよい（ローカル変数なのでガベージコレクションされる）。
 *
 * 3,000件規模でも重くならないよう、リストは初期200件のみ描画し「もっと見る」で段階的に増やす。
 */

import type { DecisionStatus, ReferenceWithStatus } from '../../../lib/types';
import { state } from '../../state';
import { t } from '../../../lib/i18n';
import { showModal, hideModal } from '../../ui/modal';
import { showToast } from '../../ui/feedback';
import { updateLlmConfig } from '../../../lib/sheets-api';
import { setLlmConfig as syncSetLlmConfig } from '../../store/compat';
import { createSmartRegex } from '../../utils/text';
import { getAssignmentSetLabel, getReferenceAssignmentSet } from '../assignment';
import { getMyManualDecisionStatus } from '../screening/filters';
import {
    collectRefIdsBySet,
    serializeTargetRefIds,
    exceedsTargetRefIdLimit,
    selectVisibleRefIds,
    buildTargetConfigUpdates,
    buildTargetGroupValue,
    parseTargetGroupValue,
    LLM_TARGET_REF_ID_LIMIT,
    type LlmTargetGroup,
} from '../../../lib/llm-target-selection';
import { updateBatchTargetCount } from './batch';

/** リストの初期表示件数・「もっと見る」での増分 */
const PAGE_SIZE = 200;

type ViewFilter = 'all' | 'selected' | 'unselected';

/** 判定状態のラベル。既存の filter_*Label キー（判定確定ラベル）を流用する */
function decisionStatusLabel(status: DecisionStatus): string {
    switch (status) {
        case 'include':
            return t('filter_includeLabel');
        case 'exclude':
            return t('filter_excludeLabel');
        case 'maybe':
            return t('filter_maybeLabel');
        default:
            return t('llm_targetPickerPending');
    }
}

export function openTargetPicker(): void {
    // モーダルを開いた時点の選択を複製した下書き。確定するまでこれだけを操作する
    const draft = new Set(state.llmTargetRefIds);
    let searchQuery = '';
    let viewFilter: ViewFilter = 'all';
    let visibleLimit = PAGE_SIZE;

    const container = document.createElement('div');
    container.className = 'target-picker-modal';

    // ----- グループ選択（担当セット + 取り込みファイル）+ 一括選択ボタン -----
    // どちらの候補も無ければ（担当割り振り未設定かつ取り込みファイル情報なし）行ごと非表示
    let groupSelect: HTMLSelectElement | null = null;
    let selectGroupBtn: HTMLButtonElement | null = null;
    if (state.assignmentSets.size > 0 || state.sourceFiles.size > 0) {
        const setRow = document.createElement('div');
        setRow.className = 'target-picker-set-row';

        const setLabel = document.createElement('label');
        setLabel.textContent = t('llm_targetPickerGroupLabel');
        setRow.appendChild(setLabel);

        groupSelect = document.createElement('select');
        groupSelect.className = 'target-picker-set-select';

        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = t('llm_targetPickerGroupPlaceholder');
        groupSelect.appendChild(placeholderOption);

        if (state.assignmentSets.size > 0) {
            const setsGroup = document.createElement('optgroup');
            setsGroup.label = t('llm_targetPickerGroupSets');
            for (const setId of state.assignmentSets) {
                const option = document.createElement('option');
                option.value = buildTargetGroupValue({ kind: 'set', id: setId });
                option.textContent = getAssignmentSetLabel(setId);
                setsGroup.appendChild(option);
            }
            groupSelect.appendChild(setsGroup);
        }

        if (state.sourceFiles.size > 0) {
            const filesGroup = document.createElement('optgroup');
            filesGroup.label = t('llm_targetPickerGroupFiles');
            for (const file of state.sourceFiles) {
                const option = document.createElement('option');
                option.value = buildTargetGroupValue({ kind: 'file', id: file });
                option.textContent = file;
                filesGroup.appendChild(option);
            }
            groupSelect.appendChild(filesGroup);
        }

        setRow.appendChild(groupSelect);

        selectGroupBtn = document.createElement('button');
        selectGroupBtn.type = 'button';
        selectGroupBtn.className = 'btn btn-outline btn-small';
        setRow.appendChild(selectGroupBtn);

        container.appendChild(setRow);
    }

    // ----- 検索（タイトル + 抄録） -----
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'target-picker-search';
    searchInput.placeholder = t('llm_targetPickerSearchPlaceholder');
    container.appendChild(searchInput);

    // ----- 表示フィルタ -----
    const viewFilterSelect = document.createElement('select');
    viewFilterSelect.className = 'target-picker-view-filter';
    const viewFilterOptions: Array<[ViewFilter, string]> = [
        ['all', t('llm_targetPickerViewAll')],
        ['selected', t('llm_targetPickerViewSelected')],
        ['unselected', t('llm_targetPickerViewUnselected')],
    ];
    for (const [value, label] of viewFilterOptions) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        viewFilterSelect.appendChild(option);
    }
    container.appendChild(viewFilterSelect);

    // ----- リスト -----
    const listDiv = document.createElement('div');
    listDiv.className = 'target-picker-list';
    container.appendChild(listDiv);

    const showingText = document.createElement('div');
    showingText.className = 'target-picker-showing';
    container.appendChild(showingText);

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'btn btn-outline btn-small target-picker-more-btn hidden';
    moreBtn.textContent = t('llm_targetPickerMore');
    container.appendChild(moreBtn);

    // ----- Blind中の注記（他レビュアーの判定状況は表示できない） -----
    if (!state.isKeyOpened) {
        const blindNote = document.createElement('p');
        blindNote.className = 'target-picker-blind-note';
        blindNote.textContent = t('llm_targetPickerBlindNote');
        container.appendChild(blindNote);
    }

    // ----- フッター -----
    const footer = document.createElement('div');
    footer.className = 'target-picker-footer';

    // 上限超過エラー（フッター内。通常は非表示）。
    // トーストは .modal-backdrop（z-index:2000）の下に隠れて見えないため、
    // モーダル内に常設の要素を用意しておき、超過している間だけ表示する
    const limitError = document.createElement('div');
    limitError.className = 'target-picker-limit-error hidden';

    const selectVisibleBtn = document.createElement('button');
    selectVisibleBtn.type = 'button';
    selectVisibleBtn.className = 'btn btn-outline btn-small';
    selectVisibleBtn.textContent = t('llm_targetPickerSelectVisible');

    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn btn-outline btn-small';
    clearAllBtn.textContent = t('llm_targetPickerClearAll');

    const countLabel = document.createElement('span');
    countLabel.className = 'target-picker-count';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary btn-small';
    confirmBtn.textContent = t('llm_targetPickerConfirm');

    footer.appendChild(limitError);
    footer.appendChild(selectVisibleBtn);
    footer.appendChild(clearAllBtn);
    footer.appendChild(countLabel);
    footer.appendChild(confirmBtn);

    // ----- 内部ロジック -----

    /** 検索語・表示フィルタを反映した対象一覧（「もっと見る」のページングとは独立） */
    function getFilteredRefs(): ReferenceWithStatus[] {
        const query = searchQuery.trim();
        const regex = query ? createSmartRegex(query) : null;

        return state.references.filter(ref => {
            if (regex) {
                regex.lastIndex = 0;
                if (!regex.test(`${ref.title} ${ref.abstract || ''}`)) return false;
            }
            if (viewFilter === 'selected' && !draft.has(ref.ref_id)) return false;
            if (viewFilter === 'unselected' && draft.has(ref.ref_id)) return false;
            return true;
        });
    }

    function buildListItem(ref: ReferenceWithStatus): HTMLElement {
        const item = document.createElement('div');
        item.className = 'target-picker-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `target-picker-item-${ref.ref_id}`;
        checkbox.checked = draft.has(ref.ref_id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                draft.add(ref.ref_id);
            } else {
                draft.delete(ref.ref_id);
            }
            updateFooterCount();
            // 「選択済みのみ」「未選択のみ」表示中はチェック変更で表示から外れうるので再描画する
            if (viewFilter !== 'all') {
                renderList();
            }
        });

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.className = 'target-picker-item-title';
        label.textContent = ref.title || t('llm_targetPickerNoTitle');

        const meta = document.createElement('div');
        meta.className = 'target-picker-item-meta';
        const setId = getReferenceAssignmentSet(ref);
        meta.textContent = [
            ref.year ? String(ref.year) : '—',
            setId ? getAssignmentSetLabel(setId) : '—',
            decisionStatusLabel(getMyManualDecisionStatus(ref)),
        ].join(' · ');

        item.appendChild(checkbox);
        item.appendChild(label);
        item.appendChild(meta);
        return item;
    }

    function renderList(): void {
        const filtered = getFilteredRefs();
        listDiv.innerHTML = '';

        if (filtered.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'placeholder-text';
            empty.textContent = t('llm_targetPickerEmpty');
            listDiv.appendChild(empty);
        } else {
            for (const ref of filtered.slice(0, visibleLimit)) {
                listDiv.appendChild(buildListItem(ref));
            }
        }

        showingText.textContent = t('llm_targetPickerShowing', [
            String(Math.min(visibleLimit, filtered.length)),
            String(filtered.length),
        ]);
        moreBtn.classList.toggle('hidden', filtered.length <= visibleLimit);
    }

    function updateFooterCount(): void {
        countLabel.textContent = t('llm_targetPickerSelectedCount', String(draft.size));
        updateLimitError();
    }

    /** 選択件数が上限を超えている間だけフッター内にエラーを表示し、戻れば自動で消す */
    function updateLimitError(): void {
        if (exceedsTargetRefIdLimit(draft.size)) {
            limitError.textContent = t('llm_targetLimitExceeded', String(LLM_TARGET_REF_ID_LIMIT));
            limitError.classList.remove('hidden');
        } else {
            limitError.classList.add('hidden');
            limitError.textContent = '';
        }
    }

    /** グループ種別に応じた getter（'set' → 担当セット、'file' → 取り込みファイル） */
    function getterForGroup(kind: LlmTargetGroup['kind']): (ref: ReferenceWithStatus) => string {
        return kind === 'set' ? getReferenceAssignmentSet : (ref) => ref.source_file || '';
    }

    function updateSelectGroupBtn(): void {
        if (!groupSelect || !selectGroupBtn) return;
        const group = parseTargetGroupValue(groupSelect.value);
        const count = group
            ? collectRefIdsBySet(state.references, new Set([group.id]), getterForGroup(group.kind)).length
            : 0;
        selectGroupBtn.textContent = t('llm_targetPickerSelectGroup', String(count));
        selectGroupBtn.disabled = !group;
    }

    async function handleConfirm(): Promise<void> {
        if (exceedsTargetRefIdLimit(draft.size)) {
            // トーストは modal-backdrop の下に隠れて見えないため、モーダル内のエラー表示で知らせる
            // （updateFooterCount 経由で既に表示されているはずだが、念のためここでも同期する）
            updateLimitError();
            return;
        }

        const mode = draft.size > 0 ? 'selection' : 'all';
        const serializedRefIds = serializeTargetRefIds(draft);

        // 保存に失敗した場合に巻き戻せるよう、書き込み前の値を退避しておく
        const previousRefIds = state.llmTargetRefIds;
        const previousMode = state.llmTargetMode;
        const previousConfig = state.llmConfig;

        state.setLlmTargetRefIds(new Set(draft));
        state.setLlmTargetMode(mode);
        // 保存が成功する前提で、先に state.llmConfig もシートと同じ内容へ同期する。
        // 保存に失敗した場合は catch 側で旧値へ巻き戻すため、ここでの同期が最終形になるとは限らない
        syncSetLlmConfig({ ...state.llmConfig, llm_target_mode: mode, llm_target_ref_ids: serializedRefIds });

        try {
            // tryUpdateLlmConfig はキーごとに1回ずつ逐次書き込むため、途中で落ちても安全側に
            // 倒れるよう書き込み順を明示的に分ける（buildTargetConfigUpdates 参照）
            for (const update of buildTargetConfigUpdates(mode, serializedRefIds)) {
                await updateLlmConfig(state.spreadsheetId, update);
            }
        } catch (error) {
            // 保存に失敗したので、表示とシートが食い違わないよう state・llmConfig を保存前の値へ巻き戻す
            console.error('[target-picker] Failed to save target selection:', error);
            state.setLlmTargetRefIds(previousRefIds);
            state.setLlmTargetMode(previousMode);
            syncSetLlmConfig(previousConfig);
            showToast(t('llm_targetSaveFailed', (error as Error).message));
        }

        hideModal();
        await updateBatchTargetCount();
    }

    // ----- イベント配線 -----

    groupSelect?.addEventListener('change', updateSelectGroupBtn);
    selectGroupBtn?.addEventListener('click', () => {
        if (!groupSelect) return;
        const group = parseTargetGroupValue(groupSelect.value);
        if (!group) return;
        // 既存の選択は消さず、グループ内の ref_id を追加する
        for (const refId of collectRefIdsBySet(state.references, new Set([group.id]), getterForGroup(group.kind))) {
            draft.add(refId);
        }
        renderList();
        updateFooterCount();
    });

    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        visibleLimit = PAGE_SIZE;
        renderList();
    });

    viewFilterSelect.addEventListener('change', () => {
        viewFilter = viewFilterSelect.value as ViewFilter;
        visibleLimit = PAGE_SIZE;
        renderList();
    });

    moreBtn.addEventListener('click', () => {
        visibleLimit += PAGE_SIZE;
        renderList();
    });

    selectVisibleBtn.addEventListener('click', () => {
        // 絞り込み結果全件ではなく、実際に画面へ描画済みの visibleLimit 件だけを選択する
        for (const refId of selectVisibleRefIds(getFilteredRefs(), visibleLimit)) {
            draft.add(refId);
        }
        renderList();
        updateFooterCount();
    });

    clearAllBtn.addEventListener('click', () => {
        draft.clear();
        renderList();
        updateFooterCount();
    });

    confirmBtn.addEventListener('click', () => { void handleConfirm(); });

    // ----- 初期描画 -----
    updateSelectGroupBtn();
    renderList();
    updateFooterCount();

    showModal({
        title: t('llm_targetPickerTitle'),
        body: container,
        footer,
    });
}

/**
 * 対象選択を解除して全件モードへ戻す
 */
export async function handleClearTargetSelection(): Promise<void> {
    // 保存に失敗した場合に巻き戻せるよう、書き込み前の値を退避しておく
    const previousRefIds = state.llmTargetRefIds;
    const previousMode = state.llmTargetMode;
    const previousConfig = state.llmConfig;

    state.setLlmTargetRefIds(new Set());
    state.setLlmTargetMode('all');
    // 保存が成功する前提で、先に state.llmConfig もシートと同じ内容へ同期する。
    // 保存に失敗した場合は catch 側で旧値へ巻き戻すため、ここでの同期が最終形になるとは限らない
    syncSetLlmConfig({ ...state.llmConfig, llm_target_mode: 'all', llm_target_ref_ids: '' });

    try {
        // 全件へ戻す方向なので mode を先に書き、ref_ids を後に書く（buildTargetConfigUpdates 参照）。
        // 現状 mode='all' のときは常に ref_ids='' なので実質1パターンだが、書き込み順の方針を
        // handleConfirm と揃えて明示しておく
        for (const update of buildTargetConfigUpdates('all', '')) {
            await updateLlmConfig(state.spreadsheetId, update);
        }
    } catch (error) {
        // 保存に失敗したので、表示とシートが食い違わないよう state・llmConfig を保存前の値へ巻き戻す
        console.error('[target-picker] Failed to clear target selection:', error);
        state.setLlmTargetRefIds(previousRefIds);
        state.setLlmTargetMode(previousMode);
        syncSetLlmConfig(previousConfig);
        showToast(t('llm_targetSaveFailed', (error as Error).message));
    }

    await updateBatchTargetCount();
}
