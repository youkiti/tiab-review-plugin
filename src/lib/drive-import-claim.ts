/**
 * drive-import-claim.ts - References シートに書かれた「Drive取り込み済み」クレームの
 * 有効性判定（純関数）
 *
 * 背景（Issue #73 Phase 2）: 更新前の旧バージョン拡張は fulltext_url/fulltext_status
 * （T:U）しか書かず、fulltext_drive_source_id/fulltext_drive_copy_id（W:X）をクリアしない。
 * そのため「誰かがDrive取り込みでW:Xを書く → 旧版ユーザーがOA取得やPDF差し替えでT:Uだけ
 * 書き換える」という操作が起きると、「別PDFのURL ＋ 古いsource ID」が同じ行に共存し、
 * 以後その source の取り込みが誤って成功扱い（実際は未取り込み）になる。Chrome拡張の
 * 自動更新ラグの間、現実に起こり得る。
 *
 * そこでクレームを自己検証可能にする: fulltext_url から抽出したDriveファイルIDが
 * fulltext_drive_copy_id と一致して初めて「今のURLと矛盾していないクレーム」とみなす。
 * 旧版がT:Uだけ書いた瞬間にURLとコピーIDが食い違い、クレームは自動的に無効化される。
 *
 * 循環importについて: extractDriveFileId は drive-api.ts の実装を再利用する（URL解釈の
 * 二重実装をしないため）。drive-api.ts は drive-import-action.ts の型を import type
 * でのみ参照しており（型情報はコンパイル時に消え、実行時のJSにこの import 文自体が
 * 出力されない）、このファイル → drive-api.ts の依存は一方向のみで実行時循環にはならない。
 */

import { extractDriveFileId } from './drive-api';
import type { FulltextStatus } from './types';

/** クレームの有効性判定に必要な最小限のシート行状態 */
export interface FulltextClaimState {
    status: FulltextStatus;
    url: string;
    /** そのクレームが指す（はずの）コピーのDriveファイルID（fulltext_drive_copy_id） */
    copyFileId: string;
}

/**
 * シートに書かれた「取り込み済み」クレームが自己矛盾していないかを判定する。
 * 有効条件（3つすべてを満たすこと）:
 *   1. status === 'cached'
 *   2. url が非空
 *   3. extractDriveFileId(url) === copyFileId
 */
export function isFulltextClaimValid(claim: FulltextClaimState): boolean {
    if (claim.status !== 'cached') return false;
    if (!claim.url) return false;
    return extractDriveFileId(claim.url) === claim.copyFileId;
}
