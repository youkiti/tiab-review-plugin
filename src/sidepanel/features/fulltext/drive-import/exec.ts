/**
 * fulltext/drive-import/exec.ts - Drive直接取り込み: 実行（ファイル単位・部分失敗設計）とシート更新
 *
 * drive-import/ 全体の設計意図は同ディレクトリの index.ts 冒頭コメントを参照。
 * 本ファイルは対応付けモーダル（mapping-modal.ts）で確定した対応付けから、実際に files.copy と
 * シート更新を行う。中断・再開の契約（シート上のクレームと Drive の appProperties の二段構え、
 * 非連続レンジでの書き込み、共有ドライブ対応）はこのファイルの importOneFile /
 * backfillDriveColumnsIfEmpty に集約されている（AGENTS.md「Drive直接取り込みの
 * 『取り込み済み』判定は二段構え」節・変更禁止。分割時もこの2関数は行の移動以外を加えていない）。
 */

import { state } from '../../../state';
import { t } from '../../../../lib/i18n';
import { resolveImportAction, shouldBackfillDriveColumns } from '../../../../lib/drive-import-action';
import type { ImportedCopyMatch, SheetFulltextState, ImportAction } from '../../../../lib/drive-import-action';
import {
    ensureFulltextFolder,
    copyPdfToFulltextFolder,
    findImportedCopy,
    deleteDriveFile,
    buildPdfFileName,
    describeDriveAccessError,
} from '../../../../lib/drive-api';
import type { DriveFileInfo } from '../../../../lib/drive-api';
import {
    getReferenceFulltextState,
    updateReferenceFulltextUrl,
} from '../../../../lib/sheets-api';
import type { ReferenceWithStatus } from '../../../../lib/types';
import type { ValidatedFile } from './validate';
import type { MappingEntry, ExecResult } from './types';
import { renderResultStep, setModalCloseEnabled } from './result-view';

// ---------------------------------------------------------------------------
// ④ 実行（ファイル単位・部分失敗設計）
// ---------------------------------------------------------------------------

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

export async function runImportAndShowResults(
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

    await renderResultStep(body, footer, results, retrySingle);
}

export async function retrySingle(
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
        await renderResultStep(body, footer, allResults, retrySingle);
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
    await renderResultStep(body, footer, allResults, retrySingle);
}
