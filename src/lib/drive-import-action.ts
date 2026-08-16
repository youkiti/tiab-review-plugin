/**
 * drive-import-action.ts - 「Driveへ直接置かれたPDFの取り込み」の実行時アクション判定（純関数）
 *
 * files.copy / Sheets API 呼び出しなどの副作用を一切持たない。呼び出し側
 * （fulltext-drive-import.ts）が Drive/Sheets から集めた情報をここに渡し、
 * 「今回のファイル×文献の組み合わせに対して何をすべきか」を決定させる。
 * 副作用と判定ロジックを分離することで、部分失敗・競合まわりの分岐を
 * node:test で網羅的に検証できるようにしている（コピーあり/なし ×
 * シート反映済み/未反映 × refId一致/不一致 × cached済みURL一致/不一致）。
 *
 * 残存する二段構えについて（Issue #73 Phase 2）: 「files.copy は成功したが Sheets 更新に
 * 失敗した」という部分障害の間は、Drive の appProperties（sourceFileId/refId/spreadsheetId）
 * だけが唯一の手がかりになる。Sheets（References の W/X 列）を全メンバー向けの真値とし、
 * Drive の appProperties は「コピー作成者本人が同じ操作を再試行したときの冪等性・中断復帰」の
 * ためのベストエフォートな補助情報として残している。真値をSheetsへ一本化しても
 * appProperties を廃止できないのはこのため。
 */

import type { FulltextStatus } from './types';
import { isFulltextClaimValid } from './drive-import-claim';

/** appProperties(sourceFileId, spreadsheetId) で見つかった既存コピー（refIdは見つかった場合のみ） */
export interface ImportedCopyMatch {
    id: string;
    webViewLink: string;
    refId?: string;
}

/**
 * 対象Referenceの現在のシート状態（fulltext_status / fulltext_url / Drive取り込みクレーム）。
 * データ層（sheets-api.ts の ReferenceFulltextRowState）と同じ形。
 */
export interface SheetFulltextState {
    status: FulltextStatus;
    url: string;
    /** fulltext_drive_source_id（W列）。Drive直接取り込み以外の経路では空文字 */
    sourceFileId: string;
    /** fulltext_drive_copy_id（X列）。Drive直接取り込み以外の経路では空文字 */
    copyFileId: string;
}

export type ImportAction =
    | 'reuse-and-update'   // 既存コピー（同じrefId向け）を再利用し、シートを更新する
    | 'copy-and-update'    // 新規に files.copy し、シートを更新する
    | 'already-done'       // シートは既に対象コピーを指している（応答喪失後の再試行など）。書き込み不要
    | 'conflict-keep'      // シートは既に別の実体でcached済み。上書きしない
    | 'error';             // 対象Referenceの行が見つからない（削除された等）

/**
 * already-done がどちらの経路で成立したかを示す。
 * - 'url': existingCopy（自分から見えているDriveコピー）の webViewLink がシートの
 *   fulltext_url と一致（コピー作成者本人。応答喪失後の再試行など）
 * - 'source-id': シートのクレームが自己矛盾なく有効（isFulltextClaimValid）で、かつ
 *   sourceFileId が importSourceFileId と一致（他人が同じsourceを先に取り込み済み。
 *   自分からはそのDriveコピーが見えなくても成立する）
 * already-done 以外の action（reuse-and-update/copy-and-update/conflict-keep/error）では
 * この値に意味は無い（呼び出し側は参照しないこと）。両方の経路が同時に成立する場合は
 * 'url' を優先する（バックフィル判定が matchedBy==='url' のときだけ行われるため）。
 */
export type ImportActionMatchedBy = 'url' | 'source-id';

export interface ResolvedImportAction {
    action: ImportAction;
    matchedBy: ImportActionMatchedBy;
}

/**
 * 取り込みアクションを判定する。
 *
 * - sheetState が undefined（Referencesの行が見つからない）なら常に 'error'
 * - sheetState.status === 'cached' の場合は絶対に上書きしない:
 *   - 現在のfulltext_urlが existingCopy.webViewLink と一致するなら 'already-done'（matchedBy: 'url'）
 *     （このコピーが既にシートに反映済み。応答喪失後の再実行などで再度ここに来たケース。
 *      書き込み不要で成功扱いにしてよい）
 *   - 一致しなくても、シートのクレームが有効（isFulltextClaimValid）かつ
 *     sheetState.sourceFileId === importSourceFileId なら 'already-done'（matchedBy: 'source-id'）
 *     （他人が既に同じsourceをこの文献へ取り込み済み。自分からはそのコピーが drive.file
 *      スコープ越しに見えなくても、シート側の真値で成功扱いにできる。Issue #71 症状1・2の解消）
 *   - どちらも成立しないなら 'conflict-keep'（別の実体で既に確保済み。今回新規作成した分だけ後始末する）
 * - cached でなければ（not_retrieved/retrieved/unavailable）:
 *   - existingCopy があり、その refId が targetRefId と一致するなら 'reuse-and-update'
 *     （以前の取り込みが「コピー成功→シート更新前」で中断した状態からの再開。新規コピーは作らない）
 *   - それ以外（既存コピーが無い、または別のrefId向け）なら 'copy-and-update'
 *     （別Referenceへ対応付けられた既存コピーは絶対に流用しない。sourceFileIdの重複は許容する）
 *
 * @param importSourceFileId 今回取り込もうとしているソースPDFのDriveファイルID
 */
export function resolveImportAction(
    existingCopy: ImportedCopyMatch | null,
    sheetState: SheetFulltextState | undefined,
    targetRefId: string,
    importSourceFileId: string
): ResolvedImportAction {
    if (!sheetState) return { action: 'error', matchedBy: 'url' };

    if (sheetState.status === 'cached') {
        if (existingCopy !== null && sheetState.url === existingCopy.webViewLink) {
            return { action: 'already-done', matchedBy: 'url' };
        }
        if (
            sheetState.sourceFileId === importSourceFileId
            && isFulltextClaimValid({
                status: sheetState.status,
                url: sheetState.url,
                copyFileId: sheetState.copyFileId,
            })
        ) {
            return { action: 'already-done', matchedBy: 'source-id' };
        }
        return { action: 'conflict-keep', matchedBy: 'url' };
    }

    const action = existingCopy !== null && existingCopy.refId === targetRefId
        ? 'reuse-and-update'
        : 'copy-and-update';
    return { action, matchedBy: 'url' };
}

/**
 * バックフィル（Issue #73 Phase 2 Step 5）の書き込み条件を判定する純関数。
 *
 * matchedBy==='url' の already-done（＝Driveコピーが見えている作成者本人）で、対象行の
 * W/X（fulltext_drive_source_id/copy_id）が空のときだけ使う。旧版クライアントが T:U だけ
 * 書いてW/Xをクリアしなかった行を、新版クライアントが取り込みを再確認したタイミングで
 * 埋め直すためのもの。**表示フェーズからは絶対に呼ばないこと**: 表示判定はロード済み
 * スナップショット依存であり、判定と書き込みの間に他ユーザーがPDFを削除・差し替えると、
 * 古いsource IDを新しいPDFに結び付けてしまう。Sheetsの原子性は1リクエスト内のみで
 * read-check-write のCASにはならないため、実行フェーズで直前に読み直した真値
 * （sheetState）を使う場合のみ呼び出すこと。
 *
 * true を返すのは次の条件をすべて満たすときだけ:
 *   0. 対象行のW/X（sourceFileId/copyFileId）がともに空（既に埋まっている行は上書きしない）
 *   1. sheetState.status === 'cached'
 *   2. existingCopy.refId === refId
 *   3. sheetState.url === existingCopy.webViewLink
 */
export function shouldBackfillDriveColumns(
    refId: string,
    sheetState: SheetFulltextState,
    existingCopy: ImportedCopyMatch
): boolean {
    if (sheetState.sourceFileId || sheetState.copyFileId) return false;
    if (sheetState.status !== 'cached') return false;
    if (existingCopy.refId !== refId) return false;
    return sheetState.url === existingCopy.webViewLink;
}
