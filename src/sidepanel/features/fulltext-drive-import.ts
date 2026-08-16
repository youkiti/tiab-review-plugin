/**
 * Driveへ直接置かれたPDFの取り込み（V1）
 *
 * アプリを経由せずDriveフォルダへ直接保存されたPDFは drive.file スコープでは見えず、
 * Referencesシートにも登録されない。本モジュールは、Picker（mode=pdf）で対象PDFを
 * ユーザーに明示選択させ、選択ファイルIDを launchWebAuthFlow のリダイレクト捕捉で
 * 拡張機能へ直接受け取り、files.copy でfulltextフォルダへ「アプリ作成ファイル」として
 * 取り込む一連のフローを提供する（対応付けUI・冪等性チェック・クリーンアップを含む）。
 *
 * 設計の要点（詳細は pdf-import-plan.md の「V1フロー」と、それに対する
 * コーディネーターレビュー（部分失敗・競合まわりの修正）を参照）:
 *  - 選択ID受け渡しは launchWebAuthFlow のリダイレクトURLフラグメント経由（ポーリングなし）
 *  - 受信JSON・各ファイルのmetadataは信用せず、コピー前に必ず再検証する
 *  - 取り込み状態は3値（未取り込み/未完了/取り込み済み）で扱う。「Driveにコピーはあるが
 *    シート未反映」は取り込み済みと誤表示せず、対応付け可能な「未完了」として扱い、
 *    実行時は既存コピーを再利用してシート更新のみ行う（詳細は drive-import-action.ts）
 *  - 既存コピーの再利用は appProperties.refId が対象文献と一致する場合のみ。
 *    別文献へ対応付けられた既存コピーは流用しない（sourceFileIdの重複は許容）
 *  - 削除してよいのは「今回このattemptで新規作成したコピー」だけ。再利用した既存コピーは
 *    競合が判明しても絶対に削除しない
 *  - 実行直前の冪等性チェック（findImportedCopy）は fail-closed。失敗したらコピーへ進まず
 *    エラーにする（検証フェーズの表示用チェックは fail-open のままでよい）
 *  - 元ファイルの削除は自動で行わない。シート反映まで確認できたファイルのみ
 *    完了画面で明示チェックさせ、ゴミ箱送り（30日間復元可）にする
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/feedback';
import { showModal, hideModal } from '../ui/modal';
import { getFulltextCandidateList } from './screening/filters';
import { buildPdfPickerUrl } from '../../lib/picker-url';
import { parsePdfPickerRedirect, validatePickedFiles, MAX_PICKED_FILES } from '../../lib/drive-picker-result';
import { isUserCancelledAuthError } from '../../lib/drive-regrant-picker';
import type { PickedDriveFile } from '../../lib/drive-picker-result';
import { resolveMappingSuggestion } from '../../lib/drive-import-suggestion';
import type { MappingSuggestionTarget } from '../../lib/drive-import-suggestion';
import { resolveImportAction, shouldBackfillDriveColumns } from '../../lib/drive-import-action';
import type { ImportedCopyMatch, SheetFulltextState, ImportAction } from '../../lib/drive-import-action';
import { classifyDriveImportState } from '../../lib/drive-import-classify';
import {
    ensureFulltextFolder,
    getDriveFileMetadata,
    copyPdfToFulltextFolder,
    findImportedCopy,
    deleteDriveFile,
    buildPdfFileName,
    describeDriveAccessError,
} from '../../lib/drive-api';
import type { DriveFileMetadata, DriveFileInfo } from '../../lib/drive-api';
import {
    getProjectDriveFolderId,
    getReferenceFulltextState,
    getFulltextClaimsSnapshot,
    updateReferenceFulltextUrl,
} from '../../lib/sheets-api';
import type { FulltextClaimsSnapshot } from '../../lib/sheets-api';
import type { ReferenceWithStatus } from '../../lib/types';

const MAX_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50MB

// フルテキストタブ全体を再描画するためのコールバック（fulltext-tab.ts から注入）
let _rerenderTab: (() => void) | null = null;
export function setFulltextDriveImportDeps(deps: { rerenderTab: () => void }): void {
    _rerenderTab = deps.rerenderTab;
}

// モーダルが開いている間（対応付け〜結果表示が終わるまで）は解除しない多重実行ガード。
// Pickerが完了して対応付けモーダルを開いた後は、モーダルのonClose（Cancel/X/結果画面のClose、
// どの経路でも hideModal() 経由で発火する）に解除を委ねる。
let importInProgress = false;

function releaseImportGuard(): void {
    importInProgress = false;
    dom.fulltextImportDriveBtn.disabled = false;
}

/** 実行ループ中はモーダルの閉じるボタン(X)を無効化し、誤操作での中断を防ぐ */
function setModalCloseEnabled(enabled: boolean): void {
    dom.modalCloseBtn.disabled = !enabled;
}

function setDriveImportStatus(msg: string | null): void {
    dom.fulltextImportDriveStatus.classList.toggle('hidden', !msg);
    dom.fulltextImportDriveStatus.textContent = msg ?? '';
}

function formatBytes(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// ① Picker起動〜選択結果の受信
// ---------------------------------------------------------------------------

/** Pickerを開き、選択されたファイル一覧を返す。キャンセル/形状不正は null（呼び出し側で終了） */
async function runPickerFlow(): Promise<PickedDriveFile[] | null> {
    const redirectUri = chrome.identity.getRedirectURL('picker');

    let folderId: string | undefined;
    try {
        folderId = (await getProjectDriveFolderId(state.spreadsheetId)) ?? undefined;
    } catch (err) {
        // 初期表示フォルダを絞れないだけなので、取れなくても全Drive表示で続行する
        console.warn('[fulltext-drive-import] プロジェクトフォルダIDの取得に失敗（全Drive表示で続行）:', err);
    }

    const url = buildPdfPickerUrl({ email: state.userEmail, redirectUri, folderId });

    let redirectUrl: string | undefined;
    try {
        redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (err) {
        if (isUserCancelledAuthError((err as Error).message)) return null;
        throw err;
    }
    if (!redirectUrl) return null;

    // Pickerページの実装不備・想定外の遷移を疑い、拡張機能自身が発行したリダイレクトURIで
    // 始まっていることを確認してから解析する（parsePdfPickerRedirect自体は発行元を検証しないため）。
    if (!redirectUrl.startsWith(redirectUri)) {
        console.warn('[fulltext-drive-import] 想定外のリダイレクトURLを受信しました:', redirectUrl);
        showToast(t('fulltext_driveImportParseError'), 5000);
        return null;
    }

    const parsed = parsePdfPickerRedirect(redirectUrl);
    if (parsed === null) {
        showToast(t('fulltext_driveImportParseError'), 5000);
        return null;
    }
    if (parsed === 'cancelled') return null;

    const { valid, invalidCount, duplicateCount, overflowCount } = validatePickedFiles(parsed.files);
    const notices: string[] = [];
    if (invalidCount > 0) notices.push(t('fulltext_driveImportInvalidShape', String(invalidCount)));
    if (duplicateCount > 0) notices.push(t('fulltext_driveImportDuplicateShape', String(duplicateCount)));
    if (overflowCount > 0) {
        notices.push(t('fulltext_driveImportOverflowShape', [String(MAX_PICKED_FILES), String(overflowCount)]));
    }
    if (notices.length > 0) showToast(notices.join(' '), 6000);

    return valid;
}

// ---------------------------------------------------------------------------
// ② 受信ファイルの検証（mimeType再確認・trashed・canCopy・サイズ・共有ドライブ検出・
//    取り込み状態の3値判定: none / incomplete / done）
// ---------------------------------------------------------------------------

interface ValidatedFile {
    id: string;
    name: string;
    sizeBytes: number | null;
    parents: string[];
    canCopy: boolean;
    canTrash: boolean;
    blockedReason: string | null;
    warning: string | null;
    /** none: 未取り込み / incomplete: コピーはあるがシート未反映 / done: 取り込み済み */
    importState: 'none' | 'incomplete' | 'done';
    existingCopyLink?: string;
    existingCopyRefId?: string;
}

/**
 * 共有ドライブ上のファイルは**ブロックしない**。
 *
 * この分岐はかつて `meta.driveId`（現在は取得していない）で共有ドライブを弾いていたが、`getDriveFileMetadata()` の
 * `files.get` に `supportsAllDrives` が無かったため `driveId` を読む前に 404 で throw しており、
 * 一度も到達していなかった（2026-08-15 実測）。パラメータを全経路へ付けた時点でこの分岐は
 * 生きたコードに変わり、**実測では読める共有ドライブ上のPDFを新たに弾き始める**ため、
 * パラメータ付与とセットで削除した。
 *
 * 実測で分かっているのは「付与済みなら共有ドライブ上のファイルもメタデータ・実体とも読める」
 * ことまでで、**共有ドライブ上のPDFをマイドライブの fulltext フォルダへ `files.copy` する経路は
 * 直接は測定していない**（測定したのは逆向き＝マイドライブ→共有ドライブ）。ここで事前に弾くより、
 * 失敗したら copy 本体のエラーがそのまま出る方が実態に合うと判断している。
 * 詳細は AGENTS.md「共有ドライブ（Shared drives）で実測して確定した挙動」。
 */
function classifyBlockedReason(meta: DriveFileMetadata): string | null {
    if (meta.trashed) return t('fulltext_importErrorTrashed');
    if (meta.mimeType !== 'application/pdf') return t('fulltext_importErrorNotPdf', meta.mimeType || '?');
    if (!meta.capabilities?.canCopy) return t('fulltext_importErrorNoCopyPermission');
    return null;
}

interface ImportStateClassification {
    state: 'none' | 'incomplete' | 'done';
    existingCopy?: ImportedCopyMatch;
}

/**
 * 既存コピーの有無と、シートへの反映状況から3状態を判定する（検証フェーズ・表示専用）。
 * 判定の純関数本体は drive-import-classify.ts の classifyDriveImportState に切り出してある
 * （担当・可視性に依存しない全メンバー共通の判定。詳細は同モジュールの冒頭コメント参照）。
 * ここでは Drive検索（findImportedCopy）を呼び、クレームスナップショット（claimsSnapshot、
 * validateAndCheckFiles 経由で1回だけ取得済み）と組み合わせて渡すだけの薄い層。
 * findImportedCopy 自体の失敗は fail-open（existingCopy=nullとして続行。クレーム判定は
 * Drive検索に依存しないため、Drive側が失敗してもクレーム由来の done 判定は生きる）。
 */
async function classifyImportState(
    fileId: string,
    claimsSnapshot: FulltextClaimsSnapshot
): Promise<ImportStateClassification> {
    let existingCopy: ImportedCopyMatch | null = null;
    try {
        existingCopy = await findImportedCopy(fileId, state.spreadsheetId);
    } catch (err) {
        console.warn('[fulltext-drive-import] 冪等性チェック（表示用）に失敗（fail-open: クレーム判定へ続行）:', fileId, err);
    }
    const claims = claimsSnapshot.bySourceId.get(fileId) ?? [];
    return classifyDriveImportState(fileId, claims, existingCopy, claimsSnapshot.byRefId);
}

async function validateAndCheckFiles(
    files: PickedDriveFile[],
    claimsSnapshot: FulltextClaimsSnapshot
): Promise<ValidatedFile[]> {
    const results: ValidatedFile[] = [];
    for (const file of files) {
        let meta: DriveFileMetadata;
        try {
            meta = await getDriveFileMetadata(file.id);
        } catch (err) {
            results.push({
                id: file.id,
                name: file.name,
                sizeBytes: null,
                parents: [],
                canCopy: false,
                canTrash: false,
                blockedReason: t('fulltext_importErrorMetaFailed', (err as Error).message),
                warning: null,
                importState: 'none',
            });
            continue;
        }

        const blockedReason = classifyBlockedReason(meta);
        const sizeBytes = meta.size ? Number(meta.size) : null;
        const warning = sizeBytes !== null && sizeBytes > MAX_SIZE_WARN_BYTES
            ? t('fulltext_importWarnLargeSize', formatBytes(sizeBytes))
            : null;

        let importState: 'none' | 'incomplete' | 'done' = 'none';
        let existingCopy: ImportedCopyMatch | undefined;
        if (!blockedReason) {
            const classification = await classifyImportState(file.id, claimsSnapshot);
            importState = classification.state;
            existingCopy = classification.existingCopy;
        }

        results.push({
            id: file.id,
            name: meta.name || file.name,
            sizeBytes,
            parents: meta.parents ?? [],
            canCopy: meta.capabilities?.canCopy ?? false,
            canTrash: meta.capabilities?.canTrash ?? false,
            blockedReason,
            warning,
            importState,
            existingCopyLink: existingCopy?.webViewLink,
            existingCopyRefId: existingCopy?.refId,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// ③ 対応付けUI（モーダル）
// ---------------------------------------------------------------------------

interface MappingEntry {
    file: ValidatedFile;
    refId: string | null;
    /** ファイル名の最良マッチがcached済み文献だった場合の、そのマッチ先タイトル（既定値はプリセットしない） */
    likelyImportedTitle?: string;
}

function openMappingModal(files: ValidatedFile[]): void {
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

    const entries: MappingEntry[] = files.map(file => {
        if (file.blockedReason || file.importState === 'done') {
            return { file, refId: null };
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
        onClose: () => releaseImportGuard(),
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

// ---------------------------------------------------------------------------
// ④ 実行（ファイル単位・部分失敗設計）
// ---------------------------------------------------------------------------

interface ExecResult {
    file: ValidatedFile;
    refId: string;
    refTitle: string;
    outcome: 'success' | 'skipped-cached' | 'error';
    message: string;
}

function errorResult(file: ValidatedFile, refId: string, refTitle: string, err: unknown): ExecResult {
    return {
        file, refId, refTitle, outcome: 'error',
        message: t('fulltext_importResultError', (err as Error).message),
    };
}

/** 今回このattemptで新規作成したコピーのみ、失敗を無視してゴミ箱へ移動する（後始末） */
async function safeTrash(fileId: string): Promise<void> {
    try {
        await deleteDriveFile(fileId);
    } catch (err) {
        console.warn('[fulltext-drive-import] 今回作成したコピーの後始末（ゴミ箱移動）に失敗:', fileId, err);
    }
}

/**
 * resolveImportAction の 'error' / 'already-done' / 'conflict-keep' を ExecResult に変換する。
 * 'reuse-and-update' / 'copy-and-update' はここでは処理せず null を返す（呼び出し側が担当）。
 */
function toShortCircuitResult(
    action: ImportAction,
    file: ValidatedFile,
    ref: ReferenceWithStatus,
    refId: string,
    refTitle: string,
    sheetState: SheetFulltextState | undefined
): ExecResult | null {
    if (action === 'error') {
        return {
            file, refId, refTitle, outcome: 'error',
            message: t('fulltext_importResultError', t('fulltext_importErrorRefNotFound')),
        };
    }
    if (action === 'already-done') {
        // シートは既にこのコピーを指している（応答喪失後の再試行、または他人が同じsourceを
        // 先に取り込み済み。どちらもmatchedByに関わらずローカル state 側の見た目は同じ）。
        // 書き込み不要でそのまま成功扱い。ローカル state もシートの真値で揃えておく。
        ref.fulltext_url = sheetState!.url;
        ref.fulltext_status = 'cached';
        ref.fulltext_drive_source_id = sheetState!.sourceFileId || undefined;
        ref.fulltext_drive_copy_id = sheetState!.copyFileId || undefined;
        return { file, refId, refTitle, outcome: 'success', message: t('fulltext_importResultSuccess') };
    }
    if (action === 'conflict-keep') {
        return { file, refId, refTitle, outcome: 'skipped-cached', message: t('fulltext_importResultSkippedCached') };
    }
    return null;
}

/**
 * バックフィル（Issue #73 Phase 2 Step 5・実行フェーズのみ）。
 * matchedBy==='url'（＝Driveコピーが見えている作成者本人）の already-done で、対象行の
 * W/Xが空の場合にのみ、直前に読み直したサーバーの真値（sheetState/existingCopy）を使って
 * fulltext_drive_source_id/copy_id を埋める。旧版クライアントがT:Uだけ書いた行を、
 * 新版クライアントが取り込みを再確認したタイミングで自己修復する。
 *
 * **表示フェーズからは絶対に呼ばないこと**（呼び出し元は実行フェーズの importOneFile のみ）。
 * 書き込み条件の判定（3条件）は shouldBackfillDriveColumns に切り出し純関数として
 * テストしている。ベストエフォート: 失敗しても取り込み結果は success のままにし、
 * 例外は握り潰して console.warn に留める（ユーザーには見せない）。
 */
async function backfillDriveColumnsIfEmpty(
    file: ValidatedFile,
    refId: string,
    sheetState: SheetFulltextState,
    existingCopy: ImportedCopyMatch,
    ref: ReferenceWithStatus
): Promise<void> {
    if (!shouldBackfillDriveColumns(refId, sheetState, existingCopy)) return;
    try {
        await updateReferenceFulltextUrl(
            state.spreadsheetId, refId, sheetState.url, sheetState.status,
            { sourceFileId: file.id, copyFileId: existingCopy.id }
        );
        ref.fulltext_drive_source_id = file.id;
        ref.fulltext_drive_copy_id = existingCopy.id;
    } catch (err) {
        console.warn('[fulltext-drive-import] W/X列（クレーム）のバックフィルに失敗（ベストエフォート、取り込み結果には影響しない）:', refId, err);
    }
}

/**
 * 1ファイル分の取り込みを実行する。resolveImportAction を2回呼ぶ:
 *  1回目（実行直前）: 既存コピー・シート状態から「再利用/新規コピー/何もしない」を決める
 *  2回目（コピー確保後）: files.copy 自体に時間がかかるため、書き込み直前に再度シート状態を
 *    読み直して競合（他ユーザーが先にcached済み）や消失（Referenceの行が無い）を検出する
 * 削除してよいのは「今回このattemptで新規作成したコピー」だけ。再利用した既存コピーは
 * 競合が判明しても絶対に削除しない。
 *
 * 残存する二段構えについて: 「files.copy は成功したが Sheets 更新に失敗した」という部分障害の
 * 間は Drive の appProperties だけが頼りになる。詳細は drive-import-action.ts 冒頭コメント参照
 * （Sheetsが全メンバー向けの真値、Driveは作成者本人向けの中断復帰用ベストエフォート）。
 */
async function importOneFile(
    file: ValidatedFile,
    ref: ReferenceWithStatus,
    folderId: string,
    operationId: string
): Promise<ExecResult> {
    const refId = ref.ref_id;
    const refTitle = ref.title || ref.ref_id;

    // 1. 実行直前の冪等性チェック（fail-closed: 失敗したらコピーへ進まず即エラーにする。
    //    フォールバックして続行すると再試行のたびに複製が増える恐れがあるため）
    let existingCopy: ImportedCopyMatch | null;
    try {
        existingCopy = await findImportedCopy(file.id, state.spreadsheetId);
    } catch (err) {
        return errorResult(file, refId, refTitle, err);
    }

    let sheetState: SheetFulltextState | undefined;
    try {
        sheetState = await getReferenceFulltextState(state.spreadsheetId, refId);
    } catch (err) {
        return errorResult(file, refId, refTitle, err);
    }

    const preResult = resolveImportAction(existingCopy, sheetState, refId, file.id);
    const preAction = preResult.action;
    const preShortCircuit = toShortCircuitResult(preAction, file, ref, refId, refTitle, sheetState);
    if (preShortCircuit) {
        if (preAction === 'already-done' && preResult.matchedBy === 'url' && existingCopy && sheetState) {
            // 直前に読み直したサーバーの真値なので、ここでのみバックフィルしてよい（表示フェーズ厳禁）。
            // toShortCircuitResult が先に ref.fulltext_drive_source_id/copy_id を（空の）sheetState
            // で埋めているため、バックフィルは必ずその後に呼び、上書きされないようにする。
            await backfillDriveColumnsIfEmpty(file, refId, sheetState, existingCopy, ref);
        }
        return preShortCircuit;
    }

    // ここに来るのは 'reuse-and-update'（refId一致の既存コピーを再利用） | 'copy-and-update'（新規コピー）
    let copy: DriveFileInfo;
    let createdByThisAttempt = false;
    if (preAction === 'reuse-and-update') {
        copy = existingCopy!; // resolveImportActionの契約上ここでは非null
    } else {
        try {
            copy = await copyPdfToFulltextFolder(file.id, folderId, buildPdfFileName(ref), {
                sourceFileId: file.id,
                refId,
                spreadsheetId: state.spreadsheetId,
                importOperationId: operationId,
            });
            createdByThisAttempt = true;
        } catch (err) {
            return errorResult(file, refId, refTitle, err);
        }
    }

    // 2. コピー確保後、書き込み直前にもう一度シート状態を読み直す
    let postState: SheetFulltextState | undefined;
    try {
        postState = await getReferenceFulltextState(state.spreadsheetId, refId);
    } catch (err) {
        if (createdByThisAttempt) await safeTrash(copy.id);
        return errorResult(file, refId, refTitle, err);
    }

    const postCopy: ImportedCopyMatch = { id: copy.id, webViewLink: copy.webViewLink, refId };
    const postResult = resolveImportAction(postCopy, postState, refId, file.id);
    const postAction = postResult.action;
    if (
        createdByThisAttempt
        && (
            postAction === 'conflict-keep'
            || postAction === 'error'
            // 他人が同一source×同一refIdへ我々より先に取り込みを完了させていた（レース）。
            // 今回このattemptで作った新規コピーは孤立するため後始末する
            // （matchedBy==='url' の場合は今回作った/再利用したcopyがそのまま正なので消さない）
            || (postAction === 'already-done' && postResult.matchedBy === 'source-id')
        )
    ) {
        // 今回新規作成した分のみ後始末する（再利用した既存コピーは絶対に削除しない）
        await safeTrash(copy.id);
    }
    const postShortCircuit = toShortCircuitResult(postAction, file, ref, refId, refTitle, postState);
    if (postShortCircuit) {
        if (postAction === 'already-done' && postResult.matchedBy === 'url' && postState) {
            // toShortCircuitResult の後に呼ぶ理由は上の pre チェック側と同じ（上書き防止）
            await backfillDriveColumnsIfEmpty(file, refId, postState, postCopy, ref);
        }
        return postShortCircuit;
    }

    // postAction === 'reuse-and-update'（＝「確保済みのcopyでシートを更新する」の意）
    try {
        await updateReferenceFulltextUrl(
            state.spreadsheetId, refId, copy.webViewLink, 'cached',
            { sourceFileId: file.id, copyFileId: copy.id }
        );
    } catch (err) {
        // 作成/再利用したコピーは残す（appProperties経由で次回このrefIdへ再利用されるため孤立コピーにはならない）
        return errorResult(file, refId, refTitle, err);
    }
    ref.fulltext_url = copy.webViewLink;
    ref.fulltext_status = 'cached';
    ref.fulltext_drive_source_id = file.id;
    ref.fulltext_drive_copy_id = copy.id;
    return { file, refId, refTitle, outcome: 'success', message: t('fulltext_importResultSuccess') };
}

async function runImportAndShowResults(
    body: HTMLElement,
    footer: HTMLElement,
    targets: MappingEntry[]
): Promise<void> {
    const refsById = new Map(state.references.map(r => [r.ref_id, r]));

    setModalCloseEnabled(false);
    body.innerHTML = '';
    footer.innerHTML = '';
    const progress = document.createElement('div');
    progress.className = 'ft-import-progress';
    body.appendChild(progress);

    const operationId = crypto.randomUUID();
    const results: ExecResult[] = [];

    try {
        const folderId = await ensureFulltextFolder(state.spreadsheetId);
        for (let i = 0; i < targets.length; i++) {
            const entry = targets[i];
            const refId = entry.refId as string; // openMappingModal のフィルタで非nullが保証される
            progress.textContent = t('fulltext_importRunning', [String(i + 1), String(targets.length)]);
            const ref = refsById.get(refId);
            if (!ref) {
                results.push({
                    file: entry.file, refId, refTitle: refId, outcome: 'error',
                    message: t('fulltext_importResultError', t('fulltext_importErrorRefNotFound')),
                });
                continue;
            }
            results.push(await importOneFile(entry.file, ref, folderId, operationId));
        }
    } catch (err) {
        // フォルダ確保自体に失敗した場合は残り全件をエラーとして記録する
        // （型付きエラーなら原因＋対処の文言に差し替え、結果リストの表示形式は変えない）
        const knownMessage = describeDriveAccessError(err);
        for (const entry of targets.slice(results.length)) {
            const refId = entry.refId as string;
            results.push({
                file: entry.file, refId, refTitle: refsById.get(refId)?.title ?? refId, outcome: 'error',
                message: t('fulltext_importResultError', knownMessage ?? (err as Error).message),
            });
        }
    }

    await renderResultStep(body, footer, results);
}

async function retrySingle(
    original: ExecResult,
    body: HTMLElement,
    footer: HTMLElement,
    allResults: ExecResult[]
): Promise<void> {
    const idx = allResults.indexOf(original);
    if (idx === -1) return;

    setModalCloseEnabled(false);

    const ref = state.references.find(r => r.ref_id === original.refId);
    if (!ref) {
        allResults[idx] = {
            ...original,
            outcome: 'error',
            message: t('fulltext_importResultError', t('fulltext_importErrorRefNotFound')),
        };
        await renderResultStep(body, footer, allResults);
        return;
    }

    try {
        const folderId = await ensureFulltextFolder(state.spreadsheetId);
        allResults[idx] = await importOneFile(original.file, ref, folderId, crypto.randomUUID());
    } catch (err) {
        const knownMessage = describeDriveAccessError(err);
        allResults[idx] = {
            ...original,
            message: t('fulltext_importResultError', knownMessage ?? (err as Error).message),
        };
    }
    await renderResultStep(body, footer, allResults);
}

// ---------------------------------------------------------------------------
// ⑤ 結果表示 + クリーンアップ（元ファイルのゴミ箱移動）
// ---------------------------------------------------------------------------

async function renderResultStep(body: HTMLElement, footer: HTMLElement, results: ExecResult[]): Promise<void> {
    body.innerHTML = '';
    footer.innerHTML = '';

    const successCount = results.filter(r => r.outcome === 'success').length;
    const skippedCount = results.filter(r => r.outcome === 'skipped-cached').length;
    const errorCount = results.filter(r => r.outcome === 'error').length;

    const summary = document.createElement('p');
    summary.className = 'ft-import-summary';
    summary.textContent = t('fulltext_importDoneSummary', [String(successCount), String(skippedCount), String(errorCount)]);
    body.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'ft-import-row-list';
    body.appendChild(list);

    for (const r of results) {
        const row = document.createElement('div');
        row.className = `ft-import-result-row ft-import-result-row--${r.outcome}`;

        const name = document.createElement('span');
        name.className = 'ft-import-row-name';
        name.textContent = `${r.file.name} → ${r.refTitle}`;
        row.appendChild(name);

        const msg = document.createElement('span');
        msg.className = 'ft-import-result-msg';
        msg.textContent = r.message;
        row.appendChild(msg);

        if (r.outcome === 'error') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'btn btn-outline btn-small';
            retryBtn.textContent = t('fulltext_importRetryBtn');
            retryBtn.addEventListener('click', () => {
                retryBtn.disabled = true;
                void retrySingle(r, body, footer, results);
            });
            row.appendChild(retryBtn);
        }

        list.appendChild(row);
    }

    const cleanupTargets = results.filter(r => r.outcome === 'success');
    if (cleanupTargets.length > 0) {
        body.appendChild(await buildCleanupSection(cleanupTargets));
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary btn-small';
    closeBtn.textContent = t('fulltext_importCloseBtn');
    closeBtn.addEventListener('click', () => hideModal());
    footer.appendChild(closeBtn);

    setModalCloseEnabled(true);
    if (_rerenderTab) _rerenderTab();
}

async function buildCleanupSection(cleanupTargets: ExecResult[]): Promise<HTMLElement> {
    const section = document.createElement('div');
    section.className = 'ft-import-cleanup';

    const title = document.createElement('h4');
    title.className = 'ft-import-cleanup-title';
    title.textContent = t('fulltext_importCleanupTitle');
    section.appendChild(title);

    const intro = document.createElement('p');
    intro.className = 'ft-import-cleanup-intro';
    intro.textContent = t('fulltext_importCleanupIntro');
    section.appendChild(intro);

    let projectFolderId: string | null = null;
    try {
        projectFolderId = await getProjectDriveFolderId(state.spreadsheetId);
    } catch (err) {
        console.warn('[fulltext-drive-import] プロジェクトフォルダID取得に失敗（既定チェックはフォルダ外扱い）:', err);
    }
    let fulltextFolderId: string | null = null;
    try {
        fulltextFolderId = await ensureFulltextFolder(state.spreadsheetId);
    } catch (err) {
        // チェックボックスの初期状態（既知フォルダ内か）を絞れないだけなので処理は続行するが、
        // fail-fast エラー（アクセス拒否等）は原因が分かるよう別途通知する
        const knownMessage = describeDriveAccessError(err);
        if (knownMessage) showToast(knownMessage, 6000);
        console.warn('[fulltext-drive-import] fulltextフォルダID取得に失敗（既定チェックはフォルダ外扱い）:', err);
    }

    const list = document.createElement('div');
    list.className = 'source-file-list';
    const checkboxes: Array<{ result: ExecResult; checkbox: HTMLInputElement }> = [];

    for (const result of cleanupTargets) {
        const row = document.createElement('div');
        row.className = 'source-file-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `ft-import-cleanup-${result.file.id}`;
        checkbox.disabled = !result.file.canTrash;
        const inKnownFolder = !!(
            (projectFolderId && result.file.parents.includes(projectFolderId)) ||
            (fulltextFolderId && result.file.parents.includes(fulltextFolderId))
        );
        checkbox.checked = result.file.canTrash && inKnownFolder;

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = result.file.canTrash
            ? result.file.name
            : `${result.file.name} ${t('fulltext_importCleanupNoTrashPermission')}`;

        row.appendChild(checkbox);
        row.appendChild(label);
        list.appendChild(row);
        checkboxes.push({ result, checkbox });
    }
    section.appendChild(list);

    const note = document.createElement('p');
    note.className = 'ft-import-cleanup-note';
    note.textContent = t('fulltext_importCleanupNote');
    section.appendChild(note);

    const cleanupBtn = document.createElement('button');
    cleanupBtn.className = 'btn btn-danger btn-small';
    cleanupBtn.textContent = t('fulltext_importCleanupBtn');
    cleanupBtn.addEventListener('click', () => {
        void runCleanup(checkboxes, cleanupBtn);
    });
    section.appendChild(cleanupBtn);

    return section;
}

async function runCleanup(
    checkboxes: Array<{ result: ExecResult; checkbox: HTMLInputElement }>,
    button: HTMLButtonElement
): Promise<void> {
    const targets = checkboxes.filter(c => c.checkbox.checked && !c.checkbox.disabled);
    if (targets.length === 0) return;

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = t('fulltext_importCleanupRunning');

    let successCount = 0;
    const failedNames: string[] = [];
    for (const { result, checkbox } of targets) {
        try {
            await deleteDriveFile(result.file.id);
            successCount += 1;
            checkbox.disabled = true;
        } catch (err) {
            console.warn('[fulltext-drive-import] 元ファイルのゴミ箱移動に失敗:', result.file.id, err);
            failedNames.push(result.file.name);
        }
    }

    button.disabled = false;
    button.textContent = originalLabel;
    if (successCount > 0) showToast(t('fulltext_importCleanupDone', String(successCount)), 4000);
    if (failedNames.length > 0) showToast(t('fulltext_importCleanupError', failedNames.join(', ')), 6000);
}

// ---------------------------------------------------------------------------
// エントリーポイント + イベントリスナー
// ---------------------------------------------------------------------------

async function handleImportFromDriveClick(): Promise<void> {
    if (importInProgress) return;
    importInProgress = true;
    dom.fulltextImportDriveBtn.disabled = true;
    setDriveImportStatus(t('fulltext_driveImportRunning'));

    // 対応付けモーダルを開けたら、以降のガード解除はモーダルの onClose に委ねる
    // （Cancel/X/結果画面のCloseのいずれも hideModal() 経由で onClose が発火する）。
    let modalOpened = false;
    try {
        const picked = await runPickerFlow();
        if (picked === null) return; // キャンセル・解析不能（解析不能時は既にtoast済み）
        if (picked.length === 0) {
            showToast(t('fulltext_driveImportNoFiles'), 4000);
            return;
        }

        setDriveImportStatus(t('fulltext_driveImportValidating'));
        // state.allReferences は画面ロード時のスナップショットなので、選択確定直後に
        // クレームスナップショット（source ID→クレーム配列 と ref_id→行状態の両方）だけ
        // Sheetsから1回だけ取り直す（ファイルごとに取り直すとN+1になるため、ここでまとめて取得する）。
        // 失敗しても表示フェーズをブロックしない: fail-open で両マップとも空にし、
        // 従来のDrive検索ベースの判定（classifyDriveImportStateの2.以降）へフォールバックする。
        let claimsSnapshot: FulltextClaimsSnapshot;
        try {
            claimsSnapshot = await getFulltextClaimsSnapshot(state.spreadsheetId);
        } catch (err) {
            console.warn('[fulltext-drive-import] クレームスナップショットの再取得に失敗（fail-open: Drive検索ベースの判定へ続行）:', err);
            claimsSnapshot = { bySourceId: new Map(), byRefId: new Map() };
        }
        const validated = await validateAndCheckFiles(picked, claimsSnapshot);
        setDriveImportStatus(null);
        openMappingModal(validated);
        modalOpened = true;
    } catch (err) {
        console.warn('[fulltext-drive-import] エラー', err);
        showToast(t('fulltext_driveImportError', (err as Error).message), 6000);
    } finally {
        setDriveImportStatus(null);
        if (!modalOpened) releaseImportGuard();
    }
}

export function setupFulltextDriveImportListeners(): void {
    dom.fulltextImportDriveBtn?.addEventListener('click', () => { void handleImportFromDriveClick(); });
}
