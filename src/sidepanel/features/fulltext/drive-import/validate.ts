/**
 * fulltext/drive-import/validate.ts - Driveへ直接置かれたPDFの取り込み: Pickerフローと検証
 *
 * drive-import/ 全体の設計意図は同ディレクトリの index.ts 冒頭コメントを参照。
 * 本ファイルは Picker（mode=pdf）でのファイル選択受信（runPickerFlow）と、受信ファイルの検証
 * （mimeType再確認・trashed・canCopy・サイズ・共有ドライブ検出・取り込み状態の3値判定:
 * none / incomplete / done）を担う（validateAndCheckFiles）。
 *
 * MappingEntry・ExecResult をここに置かず ./types.ts に切り出している理由は types.ts 冒頭
 * コメント参照（mapping-modal.ts と exec.ts の相互参照による循環import回避）。
 */

import { state } from '../../../state';
import { t } from '../../../../lib/i18n';
import { showToast } from '../../../ui/feedback';
import { buildPdfPickerUrl } from '../../../../lib/picker-url';
import { parsePdfPickerRedirect, validatePickedFiles, MAX_PICKED_FILES } from '../../../../lib/drive-picker-result';
import { isUserCancelledAuthError } from '../../../../lib/drive-regrant-picker';
import type { PickedDriveFile } from '../../../../lib/drive-picker-result';
import { getDriveFileMetadata, findImportedCopy } from '../../../../lib/drive-api';
import type { DriveFileMetadata } from '../../../../lib/drive-api';
import type { ImportedCopyMatch } from '../../../../lib/drive-import-action';
import { classifyDriveImportState } from '../../../../lib/drive-import-classify';
import { getProjectDriveFolderId } from '../../../../lib/sheets-api';
import type { FulltextClaimsSnapshot } from '../../../../lib/sheets-api';

const MAX_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50MB

export function formatBytes(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// ① Picker起動〜選択結果の受信
// ---------------------------------------------------------------------------

/** Pickerを開き、選択されたファイル一覧を返す。キャンセル/形状不正は null（呼び出し側で終了） */
export async function runPickerFlow(): Promise<PickedDriveFile[] | null> {
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

export interface ValidatedFile {
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

export async function validateAndCheckFiles(
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
