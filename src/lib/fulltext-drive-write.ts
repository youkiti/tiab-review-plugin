/**
 * fulltext-drive-write.ts - References タブの fulltext_url 系列（T:U, W:X）書き込みを組み立てる純関数
 *
 * Issue #73（Phase 2）: 「取り込み済みか」の真値を Drive の appProperties から References
 * シートの fulltext_drive_source_id（W列）/ fulltext_drive_copy_id（X列）へ移す作業の一部。
 * V列（fulltext_set、フルテキスト担当割り振り）は updateReferenceFulltextSets が単独で書くため、
 * ここでは絶対に触れない。T:U と W:X を2つの非連続レンジとして values:batchUpdate の data に
 * 積むことで、同一 batchUpdate 呼び出し内でも V列を巻き込まないようにする。
 *
 * 副作用（fetch）を一切持たないため node:test でそのまま検証できる。
 */

import type { FulltextStatus } from './types';

/** 取り込み元PDF（source）と、そのとき作成/再利用したコピー（copy）の Drive ファイルID */
export interface FulltextUrlDriveSource {
    sourceFileId: string;
    copyFileId: string;
}

export interface FulltextUrlUpdateEntry {
    refId: string;
    fulltextUrl: string;
    status: FulltextStatus;
    /**
     * Driveへ直接置かれたPDFの取り込み（fulltext-drive-import.ts）で書き込む場合のみ値を持つ。
     * それ以外の全経路（一括OA検索・単発OA検索・手動アップロード・PDF削除等）は必ず null を渡し、
     * W/X 列を空文字でクリアする（省略ではなくクリア。findImportedCopy が持っていた
     * trashed=false 相当の保証はシート側の真値には無いため、削除経路でクリアしないと
     * 「ゴミ箱にあるコピーを取り込み済み」と誤判定してしまう）。
     */
    driveSource: FulltextUrlDriveSource | null;
}

export interface FulltextUrlRangeUpdate {
    range: string;
    values: string[][];
}

/**
 * References!T{r}:U{r}（fulltext_url/fulltext_status）を、エントリごとに生成する。
 * includeDriveColumns=true のときのみ References!W{r}:X{r}
 * （fulltext_drive_source_id/fulltext_drive_copy_id）も非連続レンジとして追加で生成する
 * （V列＝fulltext_set には絶対に触れない）。
 * includeDriveColumns=false は、W/X列がユーザー独自データと衝突していて書き込めない場合に使う
 * （呼び出し側 sheets/references.ts の ensureFulltextDriveColumnsOnce 参照）。
 * rowByRefId に行番号が見つからない ref_id は結果から除外する。
 */
export function buildFulltextUrlUpdateData(
    entries: FulltextUrlUpdateEntry[],
    rowByRefId: Map<string, number>,
    sheetName: string,
    includeDriveColumns: boolean
): FulltextUrlRangeUpdate[] {
    const data: FulltextUrlRangeUpdate[] = [];
    for (const entry of entries) {
        const row = rowByRefId.get(entry.refId);
        if (!row) continue;
        data.push({
            range: `${sheetName}!T${row}:U${row}`,
            values: [[entry.fulltextUrl, entry.status]],
        });
        if (includeDriveColumns) {
            data.push({
                range: `${sheetName}!W${row}:X${row}`,
                values: [[entry.driveSource?.sourceFileId ?? '', entry.driveSource?.copyFileId ?? '']],
            });
        }
    }
    return data;
}

/** References!W1/X1（ヘッダー行）の期待名 */
export const FULLTEXT_DRIVE_SOURCE_HEADER = 'fulltext_drive_source_id';
export const FULLTEXT_DRIVE_COPY_HEADER = 'fulltext_drive_copy_id';

/**
 * W/X ヘッダーの検証結果。
 * ユーザー向け文言はここでは組み立てない（AGENTS.md の i18n 規約により、UI文言は
 * messages.json 経由にする必要があるため）。呼び出し側（sheets/references.ts）が actualW/actualX を
 * 使ってメッセージを組み立てること。
 */
export interface FulltextDriveHeaderCheck {
    ok: boolean;
    /** 実際に入っていたW列のヘッダー名（trim済み。空なら未使用） */
    actualW: string;
    /** 実際に入っていたX列のヘッダー名（trim済み。空なら未使用） */
    actualX: string;
}

/**
 * References の W/X 列ヘッダーが「空（未使用）」または「期待名と一致」かを検証する。
 * ユーザーが独自の23列目以降を追加していた場合に、固定レンジ（W:X）書き込みで
 * そのデータを無警告で上書きしてしまわないよう、呼び出し側が書き込みを見送る/中止するための判定に使う。
 *
 * headerRow は References!A1:X1 等、A列起点のヘッダー行配列を想定する
 * （W = index 22 / X = index 23、いずれも0始まり）。
 */
export function validateFulltextDriveHeaders(headerRow: string[]): FulltextDriveHeaderCheck {
    const actualW = (headerRow[22] ?? '').trim();
    const actualX = (headerRow[23] ?? '').trim();
    const wOk = actualW === '' || actualW === FULLTEXT_DRIVE_SOURCE_HEADER;
    const xOk = actualX === '' || actualX === FULLTEXT_DRIVE_COPY_HEADER;
    return { ok: wOk && xOk, actualW, actualX };
}
