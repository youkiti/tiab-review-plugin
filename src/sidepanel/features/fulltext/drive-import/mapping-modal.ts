/**
 * fulltext/drive-import/mapping-modal.ts - Drive直接取り込み: ファイル⇔文献の対応付けモーダル
 *
 * drive-import/ 全体の設計意図は同ディレクトリの index.ts 冒頭コメントを参照。
 * 本ファイルは検証済みファイル（validate.ts の ValidatedFile）を Reference と対応付けるモーダル
 * UIを担う。対応付け確定後の実行本体（files.copy・シート更新）は exec.ts の
 * runImportAndShowResults に委ねる。
 *
 * onClosed（モーダルの onClose で呼ぶコールバック）を引数で受け取る形にしているのは、
 * 呼び出し元（drive-import/index.ts）が持つ多重実行ガードの解除関数（releaseImportGuard）を
 * ここから直接importすると index.ts → mapping-modal.ts → index.ts の循環importになるため
 * （Issue #191 分割時の対応。呼び出し側から関数を引数で渡す形で回避）。
 */

import { t } from '../../../../lib/i18n';
import { showModal, hideModal } from '../../../ui/modal';
import { getFulltextCandidateList } from '../../screening/filters';
import { resolveMappingSuggestion } from '../../../../lib/drive-import-suggestion';
import type { MappingSuggestionTarget } from '../../../../lib/drive-import-suggestion';
import { state } from '../../../state';
import type { ReferenceWithStatus } from '../../../../lib/types';
import { formatBytes } from './validate';
import type { ValidatedFile } from './validate';
import type { MappingEntry } from './types';
import { runImportAndShowResults } from './exec';

// ---------------------------------------------------------------------------
// ③ 対応付けUI（モーダル）
// ---------------------------------------------------------------------------

export function openMappingModal(files: ValidatedFile[], onClosed: () => void): void {
    const mappableRefs = getFulltextCandidateList().filter(r => r.fulltext_status !== 'cached');
    // マッチ判定の対象は担当外文献も含む全文献（cachedも含む）。ドロップダウンに出す候補
    // （mappableRefs）とは別に、cachedを土俵に戻して競わせることで「本来cached済み文献に
    // マッチすべきところ、cachedが候補から外れているせいで劣った未取り込み文献が既定値として
    // 選ばれてしまう」誤対応付けを防ぐ（詳細は drive-import-suggestion.ts）。
    const mappableRefIds = new Set(mappableRefs.map(r => r.ref_id));
    const matchTargets: MappingSuggestionTarget[] = state.allReferences.map(r => ({
        ref_id: r.ref_id,
        title: r.title,
        doi: r.doi,
        isCached: r.fulltext_status === 'cached',
        isMappable: mappableRefIds.has(r.ref_id),
    }));

    const titleByRefId = new Map(state.allReferences.map(r => [r.ref_id, r.title]));

    const entries: MappingEntry[] = files.map(file => {
        if (file.blockedReason) return { file, refId: null };
        if (file.importState === 'done') {
            const title = file.existingCopyRefId ? titleByRefId.get(file.existingCopyRefId) : undefined;
            return { file, refId: null, importedIntoTitle: title || undefined };
        }
        // 「未完了の取り込み」は以前の対応付け(existingCopyRefId)を最優先の既定値にする。
        // その文献が既に別経路のコピーでcached済み等で候補から外れている場合はファイル名マッチへフォールバック。
        if (file.importState === 'incomplete' && file.existingCopyRefId
            && mappableRefs.some(r => r.ref_id === file.existingCopyRefId)) {
            return { file, refId: file.existingCopyRefId };
        }
        const suggestion = resolveMappingSuggestion(file.name, matchTargets);
        if (suggestion.kind === 'suggest') return { file, refId: suggestion.refId };
        if (suggestion.kind === 'likely-imported') {
            // 'incomplete'（このユーザーからコピーが見えている）行では「他のメンバーのコピーは
            // 見えない」という注記の前提が偽になり、fulltext_importIncompleteNoticeとも矛盾する
            // ため出さない。refIdは常にnullのまま（誤った既定値は出さない）。
            const likelyImportedTitle = file.importState === 'incomplete' ? undefined : suggestion.title;
            return { file, refId: null, likelyImportedTitle };
        }
        return { file, refId: null };
    });

    const body = document.createElement('div');
    body.className = 'ft-import-modal';

    const intro = document.createElement('p');
    intro.className = 'ft-import-intro';
    intro.textContent = t('fulltext_driveImportModalIntro');
    body.appendChild(intro);

    const warningBanner = document.createElement('div');
    warningBanner.className = 'ft-import-duplicate-warning hidden';
    warningBanner.textContent = t('fulltext_importDuplicateWarning');
    body.appendChild(warningBanner);

    const list = document.createElement('div');
    list.className = 'ft-import-row-list';
    body.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'assignment-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline btn-small';
    cancelBtn.textContent = t('fulltext_importCancelBtn');
    cancelBtn.addEventListener('click', () => hideModal());

    const executeBtn = document.createElement('button');
    executeBtn.className = 'btn btn-primary btn-small';

    footer.appendChild(cancelBtn);
    footer.appendChild(executeBtn);

    const refreshExecuteState = () => {
        const mappable = entries.filter(e => !e.file.blockedReason && e.file.importState !== 'done');
        const selected = mappable.filter(e => e.refId !== null);

        const counts = new Map<string, number>();
        for (const e of selected) {
            const refId = e.refId as string;
            counts.set(refId, (counts.get(refId) ?? 0) + 1);
        }
        const hasDuplicate = Array.from(counts.values()).some(c => c > 1);

        for (const row of Array.from(list.querySelectorAll<HTMLElement>('.ft-import-row'))) {
            const fid = row.dataset.fileId;
            const entry = entries.find(e => e.file.id === fid);
            const dup = !!entry && entry.refId !== null && (counts.get(entry.refId) ?? 0) > 1;
            row.classList.toggle('ft-import-row--duplicate', dup);
        }

        warningBanner.classList.toggle('hidden', !hasDuplicate);
        executeBtn.disabled = hasDuplicate || selected.length === 0;
        executeBtn.textContent = t('fulltext_importExecuteBtn', String(selected.length));
    };

    for (const entry of entries) {
        list.appendChild(buildMappingRow(entry, mappableRefs, refreshExecuteState));
    }
    refreshExecuteState();

    executeBtn.addEventListener('click', () => {
        executeBtn.disabled = true; // 実行開始時は即disabled（多重実行防止。以降footerごと消える）
        const targets = entries.filter(e => !e.file.blockedReason && e.file.importState !== 'done' && e.refId !== null);
        void runImportAndShowResults(body, footer, targets);
    });

    showModal({
        title: t('fulltext_driveImportModalTitle'),
        body,
        footer,
        // Cancel/X/結果画面のCloseのいずれも hideModal() を呼ぶため、ここに解除ロジックを一本化できる
        onClose: () => onClosed(),
    });
}

function buildMappingRow(
    entry: MappingEntry,
    candidates: ReferenceWithStatus[],
    onChange: () => void
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ft-import-row';
    row.dataset.fileId = entry.file.id;

    const head = document.createElement('div');
    head.className = 'ft-import-row-head';
    const name = document.createElement('span');
    name.className = 'ft-import-row-name';
    name.textContent = entry.file.name;
    head.appendChild(name);
    if (entry.file.sizeBytes !== null) {
        const size = document.createElement('span');
        size.className = 'ft-import-row-size';
        size.textContent = formatBytes(entry.file.sizeBytes);
        head.appendChild(size);
    }
    row.appendChild(head);

    if (entry.file.importState === 'done') {
        const badge = document.createElement('span');
        badge.className = 'ft-import-badge ft-import-badge--done';
        badge.textContent = t('fulltext_importBadgeImported');
        row.appendChild(badge);
        if (entry.importedIntoTitle) {
            // 取り込み先と、別文献へ対応付け直したい場合の逃げ道（先に取り込み先のPDFを削除する）を示す。
            // done は対応付け候補から外れる仕様のため、これが無いと画面上は行き止まりに見える。
            const notice = document.createElement('div');
            notice.className = 'ft-import-row-notice';
            notice.textContent = t('fulltext_importAlreadyMappedNotice', entry.importedIntoTitle);
            row.appendChild(notice);
        }
        if (entry.file.existingCopyLink) {
            const link = document.createElement('a');
            link.href = entry.file.existingCopyLink;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'ft-import-row-link';
            link.textContent = t('fulltext_actionOpenPdf');
            row.appendChild(link);
        }
        return row;
    }

    if (entry.file.blockedReason) {
        const badge = document.createElement('span');
        badge.className = 'ft-import-badge ft-import-badge--blocked';
        badge.textContent = entry.file.blockedReason;
        row.appendChild(badge);
        return row;
    }

    if (entry.file.warning) {
        const warn = document.createElement('div');
        warn.className = 'ft-import-row-warning';
        warn.textContent = entry.file.warning;
        row.appendChild(warn);
    }

    if (entry.file.importState === 'incomplete') {
        const notice = document.createElement('div');
        notice.className = 'ft-import-row-notice';
        notice.textContent = t('fulltext_importIncompleteNotice');
        row.appendChild(notice);
    }

    if (entry.likelyImportedTitle) {
        const notice = document.createElement('div');
        notice.className = 'ft-import-row-notice';
        notice.textContent = t('fulltext_importLikelyImportedNotice', entry.likelyImportedTitle);
        row.appendChild(notice);
    }

    const combo = buildReferenceCombo(candidates, entry.refId, (refId) => {
        entry.refId = refId;
        onChange();
    });
    row.appendChild(combo.wrapper);

    return row;
}

/** インクリメンタル検索付きのReference選択コンボボックス（自作。既存のdatalist前例は無い） */
function buildReferenceCombo(
    candidates: ReferenceWithStatus[],
    initialRefId: string | null,
    onChange: (refId: string | null) => void
): { wrapper: HTMLElement } {
    const wrapper = document.createElement('div');
    wrapper.className = 'ft-import-combo';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ft-import-combo-input';
    input.autocomplete = 'off';
    input.placeholder = t('fulltext_importSkipOption');

    const dropdown = document.createElement('div');
    dropdown.className = 'ft-import-combo-dropdown hidden';

    const labelFor = (ref: ReferenceWithStatus) => ref.title || ref.ref_id;
    let currentRefId: string | null = initialRefId;

    const applyDisplay = () => {
        const ref = currentRefId ? candidates.find(c => c.ref_id === currentRefId) : undefined;
        input.value = ref ? labelFor(ref) : '';
    };

    const closeDropdown = () => dropdown.classList.add('hidden');

    const select = (refId: string | null) => {
        currentRefId = refId;
        applyDisplay();
        closeDropdown();
        onChange(refId);
    };

    const renderOptions = (query: string) => {
        dropdown.innerHTML = '';

        const skipOpt = document.createElement('div');
        skipOpt.className = 'ft-import-combo-option ft-import-combo-option--skip';
        skipOpt.textContent = t('fulltext_importSkipOption');
        skipOpt.addEventListener('mousedown', (e) => { e.preventDefault(); select(null); });
        dropdown.appendChild(skipOpt);

        const q = query.trim().toLowerCase();
        const filtered = q ? candidates.filter(c => labelFor(c).toLowerCase().includes(q)) : candidates;

        for (const c of filtered.slice(0, 50)) {
            const opt = document.createElement('div');
            opt.className = 'ft-import-combo-option';
            opt.textContent = labelFor(c);
            opt.addEventListener('mousedown', (e) => { e.preventDefault(); select(c.ref_id); });
            dropdown.appendChild(opt);
        }
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ft-import-combo-empty';
            empty.textContent = t('fulltext_importComboNoMatch');
            dropdown.appendChild(empty);
        }
    };

    input.addEventListener('focus', () => {
        renderOptions('');
        dropdown.classList.remove('hidden');
    });
    input.addEventListener('input', () => {
        renderOptions(input.value);
        dropdown.classList.remove('hidden');
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDropdown();
            applyDisplay();
            input.blur();
        }
    });
    input.addEventListener('blur', () => {
        // オプションのmousedownをclick扱いさせるため、blurの反映は少し遅らせる
        window.setTimeout(() => {
            closeDropdown();
            applyDisplay();
        }, 150);
    });

    applyDisplay();
    wrapper.appendChild(input);
    wrapper.appendChild(dropdown);
    return { wrapper };
}
