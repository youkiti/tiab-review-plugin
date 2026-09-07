/**
 * fulltext-access.ts - 「他のメンバーがアップロードしたPDFを自分が読めるか」の判定（純粋関数のみ）
 *
 * 背景（Issue #60 / 実測で確定済み。詳細は src/platform/AGENTS.md の
 * 「drive.file の403/404は『無い』ではなく『このユーザーに未付与』」を参照）:
 * drive.file の付与単位は「アプリ×ユーザー×ファイル」で、Drive の共有では付与されない。
 * そのため共同研究者がアップロードしたPDFは、他のメンバーから見ると 403/404 になる。
 *
 * 本モジュールは副作用（fetch等）を一切持たない。Drive/Sheetsからの読み取り結果を
 * 受け取って判定するだけにすることで、node:test で網羅的に検証できるようにしている
 * （実際の Drive API 呼び出しは drive-api.ts の listAccessibleFileIdsInFolder が担う）。
 */

import type { ReferenceWithStatus } from './types';
import { extractDriveFileId } from './drive-api';

// Drive APIクエリの組み立て（fulltextフォルダ直下の子ファイルを列挙するクエリ）は
// drive-api.ts の buildFolderChildrenQuery が担う。drive-api.ts はDrive APIを叩く
// 低レイヤのモジュールで、本モジュールはその上のドメイン判定なので、クエリ組み立て自体は
// 低レイヤ側に置き、本モジュールからは import するだけの一方向にする（逆向きの import が
// あると循環参照になり、将来どちらかがモジュールトップレベルで相手のシンボルを使った瞬間に
// TDZでロード時クラッシュしうる）。ここでは再エクスポートしない — 必要な呼び出し側は
// drive-api.ts から直接 import すること（経路を2つ作ると次の人がどちらを使うか迷うため）。

/** fulltext_status='cached' かつ fulltext_url からDriveファイルIDを取り出せた文献 */
export interface CachedFulltextRef {
    refId: string;
    title: string;
    fileId: string;
    url: string;
}

/**
 * References のうち fulltext_status === 'cached' かつ fulltext_url から Drive ファイルIDを
 * 取り出せたものだけを返す（Drive保存済みPDFの一覧。ファイルID抽出は drive-api.ts の
 * extractDriveFileId を再利用し、URL形式の解釈をここで二重実装しない）。
 */
export function collectCachedFulltextRefs(refs: ReferenceWithStatus[]): CachedFulltextRef[] {
    const result: CachedFulltextRef[] = [];
    for (const ref of refs) {
        if (ref.fulltext_status !== 'cached') continue;
        if (!ref.fulltext_url) continue;
        const fileId = extractDriveFileId(ref.fulltext_url);
        if (!fileId) continue;
        result.push({ refId: ref.ref_id, title: ref.title, fileId, url: ref.fulltext_url });
    }
    return result;
}

/**
 * accessibleIds（= listAccessibleFileIdsInFolder の結果。現在のユーザーが files.list で
 * 実際に見えているファイルIDの集合）に含まれない cached 文献 = このユーザーが読めない文献。
 *
 * 【前提と、崩れた場合の既知の限界】
 * accessibleIds は「fulltext フォルダ（1つの folderId）直下」を files.list した結果である。
 * つまりこの関数は「fulltext フォルダ直下に無い cached ファイル = 読めない」と等価に扱っている。
 * これが正しいのは、アプリが保存する PDF が必ずそのフォルダを親として作られているから
 * （`uploadPdfToDrive` / `copyPdfToFulltextFolder` はどちらも `parents: [folderId]` で作成する）。
 *
 * この前提が崩れると **偽陽性**（実際は読めるのに「読めない」と報告する）になる。
 * 典型例: Config の fulltext フォルダIDが作り直された後、古い cached の fulltext_url が
 * 旧フォルダのファイルを指している場合。そのファイルは実際には読めているのに、
 * 新フォルダ直下の一覧には出てこないため「読めない」と誤判定される。しかも新フォルダを
 * 初期表示にした Picker にもそのファイルは出てこないため、ユーザーは復旧しようがない
 * 一覧を見せられることになる。今回のスコープではこれを検知・救済する仕組みは持たない
 * 既知の限界として許容する（fulltextフォルダの作り直し自体が稀な操作であるため）。
 */
export function selectUnreadableRefs(
    cached: CachedFulltextRef[],
    accessibleIds: Set<string>
): CachedFulltextRef[] {
    return cached.filter(c => !accessibleIds.has(c.fileId));
}
