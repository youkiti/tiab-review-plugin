/**
 * drive-import-action.ts - 「Driveへ直接置かれたPDFの取り込み」の実行時アクション判定（純関数）
 *
 * files.copy / Sheets API 呼び出しなどの副作用を一切持たない。呼び出し側
 * （fulltext-drive-import.ts）が Drive/Sheets から集めた情報をここに渡し、
 * 「今回のファイル×文献の組み合わせに対して何をすべきか」を決定させる。
 * 副作用と判定ロジックを分離することで、部分失敗・競合まわりの分岐を
 * node:test で網羅的に検証できるようにしている（コピーあり/なし ×
 * シート反映済み/未反映 × refId一致/不一致 × cached済みURL一致/不一致）。
 */

import type { FulltextStatus } from './types';

/** appProperties(sourceFileId, spreadsheetId) で見つかった既存コピー（refIdは見つかった場合のみ） */
export interface ImportedCopyMatch {
    id: string;
    webViewLink: string;
    refId?: string;
}

/** 対象Referenceの現在のシート状態（fulltext_status / fulltext_url） */
export interface SheetFulltextState {
    status: FulltextStatus;
    url: string;
}

export type ImportAction =
    | 'reuse-and-update'   // 既存コピー（同じrefId向け）を再利用し、シートを更新する
    | 'copy-and-update'    // 新規に files.copy し、シートを更新する
    | 'already-done'       // シートは既に対象コピーを指している（応答喪失後の再試行など）。書き込み不要
    | 'conflict-keep'      // シートは既に別の実体でcached済み。上書きしない
    | 'error';             // 対象Referenceの行が見つからない（削除された等）

/**
 * 取り込みアクションを判定する。
 *
 * - sheetState が undefined（Referencesの行が見つからない）なら常に 'error'
 * - sheetState.status === 'cached' の場合は絶対に上書きしない:
 *   - 現在のfulltext_urlが existingCopy.webViewLink と一致するなら 'already-done'
 *     （このコピーが既にシートに反映済み。応答喪失後の再実行などで再度ここに来たケース。
 *      書き込み不要で成功扱いにしてよい）
 *   - 一致しないなら 'conflict-keep'（別の経路で既に確保済み。今回新規作成した分だけ後始末する）
 * - cached でなければ（not_retrieved/retrieved/unavailable）:
 *   - existingCopy があり、その refId が targetRefId と一致するなら 'reuse-and-update'
 *     （以前の取り込みが「コピー成功→シート更新前」で中断した状態からの再開。新規コピーは作らない）
 *   - それ以外（既存コピーが無い、または別のrefId向け）なら 'copy-and-update'
 *     （別Referenceへ対応付けられた既存コピーは絶対に流用しない。sourceFileIdの重複は許容する）
 */
export function resolveImportAction(
    existingCopy: ImportedCopyMatch | null,
    sheetState: SheetFulltextState | undefined,
    targetRefId: string
): ImportAction {
    if (!sheetState) return 'error';

    if (sheetState.status === 'cached') {
        return existingCopy !== null && sheetState.url === existingCopy.webViewLink
            ? 'already-done'
            : 'conflict-keep';
    }

    return existingCopy !== null && existingCopy.refId === targetRefId
        ? 'reuse-and-update'
        : 'copy-and-update';
}
