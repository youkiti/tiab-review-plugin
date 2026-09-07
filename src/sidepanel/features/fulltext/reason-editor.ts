/**
 * フルテキスト除外理由エディタ（フルテキストタブ内のインライン編集UI）
 *
 * SR のフレームワークは PICO だけではない（scoping review の PCC など）ため、
 * 除外理由の選択肢をプロジェクトごとに編集できるようにする。
 * 保存先は Config タブの fulltext_exclude_reasons（src/lib/exclude-reason-config.ts）。
 *
 * 設計上の約束:
 *  - **並び順が優先順位**。判定画面の数字キーの割り当てもこの並びで決まる。
 *  - 内部キー（Decisions シートの reason 列に入る保存値）は自動発番し、ユーザーには
 *    ラベルだけ編集させる。既存項目のキーは編集中も保持する（過去の判定と結び付くため）。
 *  - 項目を削除しても過去の判定は消えない。削除された理由は集計時に生キーのまま残るので、
 *    既に使われている理由の削除には使用件数を添えて確認する。
 *  - 編集は管理者のみ（理由がレビュー中に勝手に変わると判定の一貫性が壊れるため）。
 */

import { state } from '../../state';
import { t } from '../../../lib/i18n';
import { showToast } from '../../ui/feedback';
import { saveExcludeReasonConfig } from '../../../lib/sheets-api';
import {
    EXCLUDE_REASON_PRESETS,
    MAX_EXCLUDE_REASON_ITEMS,
    findExcludeReasonPreset,
    nextExcludeReasonKey,
    validateExcludeReasonItems,
    type ExcludeReasonConfig,
} from '../../../lib/exclude-reason-config';
import { MAX_REASON_HOTKEYS, type ExcludeReasonItem } from '../../../lib/exclude-reasons';

export interface ReasonEditorOptions {
    container: HTMLElement;
    /** 現在の理由リスト（state.excludeReasonItems） */
    currentItems: readonly ExcludeReasonItem[];
    /** 理由キーごとの使用件数（フルテキストの除外判定の集計）。削除時の警告に使う。 */
    usageCounts: Map<string, number>;
    isAdmin: boolean;
    /** 保存成功後に呼ぶ（タブ再描画用） */
    onSaved: () => void;
    /** 閉じる */
    onClose: () => void;
}

/** 編集中の作業コピー（保存するまで state には反映しない） */
let draft: ExcludeReasonItem[] = [];

export function mountReasonEditor(options: ReasonEditorOptions): void {
    draft = options.currentItems.map(i => ({ ...i }));
    render(options);
}

function render(options: ReasonEditorOptions): void {
    const { container, isAdmin } = options;
    // className は触らない（sidepanel.html の class="fulltext-reason-editor hidden" を
    // 上書きすると fulltext-tab-regrant.css の .fulltext-reason-editor ブロックが死ぬ。
    // hidden の付け外しは呼び出し側 fulltext/tab.ts の classList に任せる。
    // 兄弟コンポーネント fulltext-rule-editor.ts の mountRuleEditor に倣う）。
    container.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'ft-reason-editor-title';
    title.textContent = t('ftReason_editorTitle');
    container.appendChild(title);

    const note = document.createElement('div');
    note.className = 'ft-reason-editor-note';
    note.textContent = t('ftReason_priorityNote', String(Math.min(draft.length, MAX_REASON_HOTKEYS)));
    container.appendChild(note);

    if (!isAdmin) {
        const readonly = document.createElement('div');
        readonly.className = 'ft-reason-editor-readonly';
        readonly.textContent = t('ftReason_readonly');
        container.appendChild(readonly);
    }

    container.appendChild(buildList(options));

    if (isAdmin) {
        container.appendChild(buildAddRow(options));
        container.appendChild(buildPresetRow(options));

        const keyNote = document.createElement('div');
        keyNote.className = 'ft-reason-editor-note';
        keyNote.textContent = t('ftReason_keyNote');
        container.appendChild(keyNote);
    }

    container.appendChild(buildFooter(options));
}

function buildList(options: ReasonEditorOptions): HTMLElement {
    const list = document.createElement('div');
    list.className = 'ft-reason-editor-list';

    draft.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'ft-reason-editor-row';

        const num = document.createElement('span');
        num.className = 'ft-reason-editor-num';
        // 数字キーで選べる範囲だけ「1.」「2.」…と番号を出す（それ以外はクリック選択）
        num.textContent = idx < MAX_REASON_HOTKEYS ? `${idx + 1}.` : '–';
        row.appendChild(num);

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'ft-reason-editor-label';
        labelInput.value = item.label;
        labelInput.placeholder = t('ftReason_labelPlaceholder');
        labelInput.disabled = !options.isAdmin;
        labelInput.addEventListener('input', () => { draft[idx].label = labelInput.value; });
        row.appendChild(labelInput);

        const labelEnInput = document.createElement('input');
        labelEnInput.type = 'text';
        labelEnInput.className = 'ft-reason-editor-label-en';
        labelEnInput.value = item.labelEn;
        labelEnInput.placeholder = t('ftReason_labelEnPlaceholder');
        labelEnInput.disabled = !options.isAdmin;
        labelEnInput.addEventListener('input', () => { draft[idx].labelEn = labelEnInput.value; });
        row.appendChild(labelEnInput);

        const used = options.usageCounts.get(item.key) ?? 0;
        if (used > 0) {
            const usedBadge = document.createElement('span');
            usedBadge.className = 'ft-reason-editor-used';
            usedBadge.textContent = t('ftReason_usedCount', String(used));
            row.appendChild(usedBadge);
        }

        if (options.isAdmin) {
            row.appendChild(buildIconBtn('↑', t('ftReason_moveUp'), idx === 0, () => {
                [draft[idx - 1], draft[idx]] = [draft[idx], draft[idx - 1]];
                render(options);
            }));
            row.appendChild(buildIconBtn('↓', t('ftReason_moveDown'), idx === draft.length - 1, () => {
                [draft[idx + 1], draft[idx]] = [draft[idx], draft[idx + 1]];
                render(options);
            }));
            row.appendChild(buildIconBtn('✕', t('ftReason_remove'), false, () => {
                if (used > 0 && !confirm(t('ftReason_removeUsedConfirm', [item.label, String(used)]))) return;
                draft.splice(idx, 1);
                render(options);
            }));
        }

        list.appendChild(row);
    });

    return list;
}

function buildIconBtn(label: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small btn-outline ft-reason-editor-icon-btn';
    btn.textContent = label;
    btn.title = title;
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
}

function buildAddRow(options: ReasonEditorOptions): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ft-reason-editor-actions';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-small btn-secondary';
    addBtn.textContent = t('ftReason_add');
    addBtn.disabled = draft.length >= MAX_EXCLUDE_REASON_ITEMS;
    addBtn.addEventListener('click', () => {
        // 既存キーに加え、現在の設定にあるキー・過去に退役したキーとも衝突させない
        // （削除した項目のキーを再利用すると、過去の判定が別の意味の理由として読まれる）。
        // usageCounts はブラインド中は他レビュアーの票を読めず0件に見えるため、
        // 再利用回避の実体は retiredKeys（state.excludeReasonConfig）で担保する。
        const usedKeys = [
            ...draft.map(i => i.key),
            ...options.currentItems.map(i => i.key),
            ...options.usageCounts.keys(),
            ...(state.excludeReasonConfig?.retiredKeys ?? []),
        ];
        draft.push({ key: nextExcludeReasonKey(usedKeys), label: '', labelEn: '' });
        render(options);
    });
    row.appendChild(addBtn);

    return row;
}

function buildPresetRow(options: ReasonEditorOptions): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ft-reason-editor-actions';

    const label = document.createElement('span');
    label.className = 'ft-reason-editor-preset-label';
    label.textContent = t('ftReason_presetLabel');
    row.appendChild(label);

    const select = document.createElement('select');
    select.className = 'ft-reason-editor-preset-select';
    for (const preset of EXCLUDE_REASON_PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name;
        select.appendChild(opt);
    }
    row.appendChild(select);

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-small btn-secondary';
    applyBtn.textContent = t('ftReason_presetApply');
    applyBtn.addEventListener('click', () => {
        const preset = findExcludeReasonPreset(select.value);
        if (!preset) return;
        if (!confirm(t('ftReason_presetConfirm', preset.name))) return;
        draft = preset.items.map(i => ({ ...i }));
        render(options);
    });
    row.appendChild(applyBtn);

    return row;
}

function buildFooter(options: ReasonEditorOptions): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'ft-reason-editor-footer';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-small btn-outline';
    closeBtn.textContent = options.isAdmin ? t('common_cancel') : t('common_close');
    closeBtn.addEventListener('click', () => options.onClose());
    footer.appendChild(closeBtn);

    if (options.isAdmin) {
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-small btn-primary';
        saveBtn.textContent = t('common_save');
        saveBtn.addEventListener('click', () => void handleSave(options, saveBtn, closeBtn));
        footer.appendChild(saveBtn);
    }

    return footer;
}

async function handleSave(
    options: ReasonEditorOptions,
    saveBtn: HTMLButtonElement,
    closeBtn: HTMLButtonElement
): Promise<void> {
    const items: ExcludeReasonItem[] = draft.map(i => ({
        key: i.key,
        label: i.label.trim(),
        labelEn: i.labelEn.trim(),
    }));

    const validation = validateExcludeReasonItems(items);
    if (!validation.ok) {
        showToast(t(validation.messageKey, validation.messageParam), 3000);
        return;
    }

    const originalLabel = saveBtn.textContent ?? '';
    saveBtn.disabled = true;
    closeBtn.disabled = true;
    saveBtn.textContent = t('common_saving');

    try {
        // 今回の編集で items から消えたキーを退役させる。options.currentItems は
        // 編集セッション開始時点（mount時）のスナップショットで、プリセット読込等の
        // 中間操作に関わらず「開始時にあって今は無いキー」を正しく拾える。
        // 既存の retiredKeys（他セッションで既に退役したキーを含む）と合わせ、
        // 今回また items に戻ったキーは退役解除する。
        const currentKeySet = new Set(items.map(i => i.key));
        const newlyRetired = options.currentItems
            .map(i => i.key)
            .filter(key => !currentKeySet.has(key));
        const retiredKeys = [...new Set([
            ...(state.excludeReasonConfig?.retiredKeys ?? []),
            ...newlyRetired,
        ])].filter(key => !currentKeySet.has(key));

        const config: ExcludeReasonConfig = {
            items,
            retiredKeys,
            updated_at: new Date().toISOString(),
            updated_by: state.userEmail,
        };
        await saveExcludeReasonConfig(state.spreadsheetId, config);
        state.setExcludeReasonConfig(config);
        showToast(t('ftReason_saved'));
        options.onSaved();
    } catch (error) {
        console.error('[fulltext-reason-editor] handleSave error:', error);
        showToast(t('ftReason_saveError', (error as Error).message), 4000);
        // 失敗時は編集内容を保持したままボタンだけ復帰させる
        saveBtn.disabled = false;
        closeBtn.disabled = false;
        saveBtn.textContent = originalLabel;
    }
}
