// fulltext-display-mode.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3c: フルテキストビューア（src/fulltext/fulltext.ts）の
// showPdfForRef() が「どの表示経路を使うか」を決める分岐条件を、UI非依存の純関数として切り出した
// もの。DOM・fetch に依存しないためユニットテストできる（fulltext-consensus.ts 等と同じ方針）。
// 既存分岐（cached→PDF.js / retrieved→リンク表示 / unavailable→論文ページ埋め込み /
// それ以外→自動でOA検索）を壊していないことは、この関数のテストで担保する。

import type { Reference } from './types';
import { isRegistrationRecord } from './registry-record';

export type FulltextDisplayMode =
    | 'registry_snapshot'
    | 'pdf'
    | 'linked'
    | 'unavailable'
    | 'not_retrieved';

/**
 * ある文献をフルテキストビューアでどう表示すべきかを判定する。
 *
 * - registry_snapshot: isRegistrationRecord(ref) かつ fulltext_status==='cached' かつ
 *   fulltext_url がある（registration行の自己完結HTMLスナップショット。Issue #118 実装内容10）。
 *   通常のPDF経路（showCachedPdf、PDF.js）へは一切入らない。
 * - pdf: registry_snapshot に該当しない cached（Drive保存済みの実PDF）。従来どおりの経路。
 * - linked: fulltext_status==='retrieved' かつ fulltext_url がある（OA全文リンクのみ、未保存）。
 * - unavailable: fulltext_status==='unavailable'（OA全文なし、論文ページ埋め込み表示）。
 * - not_retrieved: 上記いずれでもない（未取得。表示時に自動でOA/レジストリ検索を行う）。
 *
 * 【registry_snapshot と pdf の判定順序が重要】isRegistrationRecord(ref) は record_type
 * （メタデータ）だけを見るため、フルテキストビューアのツールバー「別のPDFをアップロード」で
 * registration行の fulltext_url が実PDFへ差し替えられていても record_type は 'registration' の
 * ままで、この関数は引き続き registry_snapshot を返す。実ファイルの中身が本当にHTML
 * スナップショットかどうか（差し替え後の実PDFでないか）の最終確認はバイト取得を伴うため
 * 純関数にはできず、この関数の返り値を使う側（fulltext.ts の showRegistrySnapshot()、
 * マジックナンバー判定）が追加の安全網として行う。この関数の責務はメタデータだけで
 * 「まず何を試すか」を決めることに限定している。
 */
export function resolveFulltextDisplayMode(
    ref: Pick<Reference, 'record_type' | 'journal' | 'source' | 'fulltext_status' | 'fulltext_url'>
): FulltextDisplayMode {
    const hasCachedFile = ref.fulltext_status === 'cached' && !!ref.fulltext_url;
    if (hasCachedFile) {
        return isRegistrationRecord(ref) ? 'registry_snapshot' : 'pdf';
    }
    if (ref.fulltext_status === 'retrieved' && !!ref.fulltext_url) return 'linked';
    if (ref.fulltext_status === 'unavailable') return 'unavailable';
    return 'not_retrieved';
}
