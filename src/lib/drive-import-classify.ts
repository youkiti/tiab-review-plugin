/**
 * drive-import-classify.ts - 対応付けモーダル表示用の取り込み状態3値判定（純関数）
 *
 * 旧実装（fulltext-drive-import.ts の classifyImportState）は state.references（読み込み済み
 * スナップショット）で判定していたため、次の2つの問題を抱えていた:
 *   1. drive.file スコープでは他人が作成したDriveコピーが自分からは見えない
 *      （Issue #71。files.list が HTTP 200 + 空配列を返す）ため、他人が取り込み済みのPDFでも
 *      「未取り込み(none)」と誤表示される
 *   2. state.references は非管理者では担当文献へ絞られているため、担当外文献へ取り込み済みの
 *      PDFは sheetState === undefined → resolveImportAction が 'error' を返し、incomplete表示に
 *      なる（本来は既に取り込み済みのはずが、担当外だと「未完了」に見える別バグ）
 *
 * ここでは判定の入力を「シート側のクレーム（source ID → クレーム配列）」と「Drive側
 * findImportedCopy の結果」に絞り、担当・可視性に依存しない全メンバー共通の判定にする。
 *
 * **仕様変更ではない**: クレーム由来で done になり実行対象から外れる挙動自体は、現行でも
 * 「コピー作成者本人が Drive 検索経由で同じ結果（already-done → done → 除外）になる」ケースの
 * 全メンバーへの拡張にすぎない。作成者本人しか正しく機能していなかった判定を、シート側の
 * 真値を使うことで担当・可視性に関わらず全員へ広げているだけで、判定順・除外の意味は変えていない。
 */

import { resolveImportAction } from './drive-import-action';
import type { ImportedCopyMatch } from './drive-import-action';
import { isFulltextClaimValid } from './drive-import-claim';
import type { FulltextSourceClaim, ReferenceFulltextRowState } from './sheets-api';

export interface DriveImportClassification {
    state: 'none' | 'incomplete' | 'done';
    /**
     * 判定に使った既存コピー（Drive検索由来、またはクレーム由来の合成値）。
     * refId は state==='done' のとき常に設定される（対応付けモーダルの既定値プリセットに使う）。
     */
    existingCopy?: ImportedCopyMatch;
}

/**
 * 1ファイル（sourceFileId）の取り込み状態を、シート側クレーム・全行の行状態・Drive検索結果から
 * 判定する。
 *
 * 判定順:
 *   1. claimsForSource（この source を指す全文献のクレーム）に有効なクレームが1件でもあれば
 *      'done'。全メンバーで一致する判定であり、Drive検索の結果は不要（existingCopyがnullでもよい）
 *   2. 有効なクレームが無く、Driveコピーだけ見えている場合は現行ロジック
 *      （resolveImportAction 経由で 'already-done' なら done、それ以外は incomplete）
 *   3. どちらも無ければ 'none'
 *
 * claimsForSource は sourceFileId でグルーピング済みの配列を渡すこと（呼び出し側で
 * bySourceId.get(sourceFileId) ?? [] を渡す想定）。判定順1専用の入力であり、W列
 * （fulltext_drive_source_id）が空の行は含まれない。
 *
 * **1つのソースPDFを2件目の文献へ対応付けることはできない（表示フェーズの仕様。PR #105 指摘3）**:
 * 判定順1は「有効なクレームが**1件でも**あれば done」なので、既にどこかの文献へ取り込まれた
 * ソースPDFは対応付けモーダルで候補から外れる。データ層（sheets/references.ts の bySourceId）が
 * クレームを配列で持つのは「同一sourceへの複数対応付けを表示フェーズで支援するため」ではなく、
 * **無効化された古いクレームに紛れた有効なクレームを取りこぼさないため**である
 * （実行フェーズの resolveImportAction は別文献への `copy-and-update` を今も許容しており、
 * sourceFileId の重複自体はデータとして成立しうる）。
 *
 * この制限は本Issue以前からコピー作成者本人には掛かっていたもので（自分のコピーが
 * findImportedCopy で見つかる → already-done → done → 除外）、それを全メンバーへ揃えた結果である。
 * 作成者以外は「他人のコピーが見えない」というバグの副作用として対応付けできていたにすぎない。
 * 2件目へ対応付け直したい場合は、先に1件目の文献のフルテキストPDFを削除する（削除経路が
 * W/Xをクリアするためクレームが消え、再び 'none' として選べるようになる）。UI側はこの
 * 逃げ道をユーザーへ案内すること（fulltext_importAlreadyMappedNotice）。
 *
 * byRefId は**全行**分の現在の行状態（ref_id → {status,url,sourceFileId,copyFileId}）。
 * 判定順2のフォールバックはここから引く。claimsForSource（source ID起点）で代用すると、
 * W/X 列が空の行（本Issue #73 修正前に取り込まれた既存ファイル全て）が
 * 「クレーム無し」＝「行が見つからない」と誤認識され、実際には反映済みの取り込みが
 * incomplete と誤表示される退行を起こす。判定順2は「クレームの有無」ではなく
 * 「その行の現在のURLがexistingCopyと一致するか」を見るため、クレーム由来のマップでは
 * なく全行対象のマップが必要。
 */
export function classifyDriveImportState(
    sourceFileId: string,
    claimsForSource: FulltextSourceClaim[],
    existingCopy: ImportedCopyMatch | null,
    byRefId: Map<string, ReferenceFulltextRowState>
): DriveImportClassification {
    // 1. 有効なクレームがあれば done（Drive検索の結果は不要）
    const validClaim = claimsForSource.find((claim) =>
        isFulltextClaimValid({ status: claim.status, url: claim.url, copyFileId: claim.copyId })
    );
    if (validClaim) {
        const resolvedCopy: ImportedCopyMatch =
            existingCopy && existingCopy.refId === validClaim.refId
                ? existingCopy
                : { id: validClaim.copyId, webViewLink: validClaim.url, refId: validClaim.refId };
        return { state: 'done', existingCopy: resolvedCopy };
    }

    // 2. Drive コピーのみ → 現行ロジック（resolveImportAction 経由の判定）
    if (existingCopy) {
        if (!existingCopy.refId) return { state: 'incomplete', existingCopy };

        // W/X列の有無に関わらず、その ref_id の「今の」行状態を引く（クレーム由来ではない）
        const sheetState = byRefId.get(existingCopy.refId);
        const { action } = resolveImportAction(existingCopy, sheetState, existingCopy.refId, sourceFileId);
        return { state: action === 'already-done' ? 'done' : 'incomplete', existingCopy };
    }

    // 3. どちらも無い → none
    return { state: 'none' };
}
