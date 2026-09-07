// prisma-identification.ts - PRISMA Identification 相の集計（純関数、UI/state 非依存）
//
// src/sidepanel/features/manuscript.ts の collectIdentification() は state に依存していて
// テストできなかった。集計の核をここへ切り出す（Issue #145 チャンク2）。
// IdentificationData 型もこのファイルへ集約する。manuscript.ts はこのファイルから import して使う
// （domain の行そのものを表す Reference/Decision 等の型は src/lib/types.ts に置くが、
// IdentificationData は「この集計関数の戻り値の形」であって References 行の型ではないため、
// 型定義の主目的である計算ロジックとセットでこのファイルに置くほうが自然と判断した）。

import type { Reference, ImportStatsMap } from './types';
import { splitByIdentificationRoute } from './identification-route';
import { isLogicallyDeleted } from './duplicate-detect';

export interface IdentificationData {
    files: Array<{ file: string; identified: number; hasStats: boolean }>;
    identifiedTotal: number;
    duplicatesTotal: number | null;  // null = 統計未記録のファイルがあり合計不明
    screened: number;                // 重複除去後（シート上のユニーク文献数）
    statsComplete: boolean;
}

/**
 * Identification 相の数値（import_stats + シート上の件数）を計算する。
 *
 * refs は database 腕・other methods 腕（related_ref_id 非空）の別を問わず、
 * 論理削除された行（duplicate_of 非空）も含めて全件を渡すこと（getReferences() 由来）。
 * database 腕への絞り込みは splitByIdentificationRoute() をこの関数の中で行う。
 *
 * 【論理削除された行の扱い（Issue #145 チャンク2）】
 * 取り込み時に自動スキップされなかった重複（正規化タイトル一致など、人が重複レビューUIで
 * 判断するもの）は References に行として残ったまま duplicate_of で論理削除される。この行は
 * 判定（Decisions）が付いていたかどうかに関わらず、常に "Records removed before screening
 * (duplicates)" として重複除去数へ合算する。判定の有無で区別しないのは、書誌重複はそもそも
 * スクリーニング前に除くべきものだった（人がスクリーニングとして判定したのではなく、後から
 * 重複と判明した）という整理による（Issue #145 本文の設計判断）。
 *
 * 計算:
 *   screened        = 論理削除されていない database 腕の件数
 *   duplicatesTotal = import_stats の duplicates 合計 + 論理削除された database 腕の件数
 *                      （import_stats が全ファイルに揃っているときだけ計算し、そうでなければ
 *                      従来どおり null のまま。一部のファイルにだけ論理削除件数を足す部分計算はしない）
 *   identifiedTotal = import_stats の identified 合計（統計が無いファイルは現行どおり
 *                      statsComplete = false にして、論理削除されていない件数（重複除去後の
 *                      代表値）で代用する）
 *
 * splitByIdentificationRoute() は related_ref_id 非空の行を other methods 腕として別集計するため
 * （Issue #120）、その扱いはこの関数でも変えない。other methods 腕の行が論理削除されていても
 * duplicatesTotal には混入しない（database 腕に絞り込んだ後で論理削除件数を数えるため）。
 *
 * 【refsMayOmitLogicallyDeleted オプション（Issue #145 チャンク2）】
 * refs は本来「論理削除された行も含む全件」（getReferences() 由来）を渡す契約だが、呼び出し側が
 * それを取得できず、既に論理削除済みの行が除外された一覧（selectReferencesWithStatus() 由来）
 * へフォールバックすることがある。その場合、論理削除された
 * 行はこの関数から見えず「単に存在しない」ため、duplicatesTotal は論理削除件数の分だけ静かに
 * 過少になる。数字が黙って狂うのはこの機能で最も避けたい失敗のため、refsMayOmitLogicallyDeleted:
 * true を渡すと、実際の集計結果によらず duplicatesTotal を null・statsComplete を false に強制する。
 * これにより既存の「統計未記録ファイルがあり合計不明」の経路（[n] 表示・manuscript_warnNoStats
 * 警告）にそのまま乗る。screened/identifiedTotal/files は refs に実在する行から計算した値を
 * そのまま返す（論理削除された行は refs 自体に存在しないため、これらの値は結果的に正しい）。
 */
export function computeIdentification(
    refs: Pick<Reference, 'source_file' | 'related_ref_id' | 'duplicate_of'>[],
    importStats: ImportStatsMap,
    options?: { refsMayOmitLogicallyDeleted?: boolean }
): IdentificationData {
    const databaseRefs = splitByIdentificationRoute(refs).database;

    // ファイル一覧の列挙用（論理削除の有無を問わず、行が存在するファイルは列挙する）と、
    // 統計未記録ファイルのフォールバック用（論理削除されていない件数＝重複除去後の代表値）を分けて数える。
    const perFileAll = new Map<string, number>();
    const perFileNonDeleted = new Map<string, number>();
    let logicallyDeletedCount = 0;

    for (const r of databaseRefs) {
        const file = r.source_file || '(unknown source)';
        perFileAll.set(file, (perFileAll.get(file) ?? 0) + 1);
        if (isLogicallyDeleted(r)) {
            logicallyDeletedCount += 1;
        } else {
            perFileNonDeleted.set(file, (perFileNonDeleted.get(file) ?? 0) + 1);
        }
    }

    const screened = databaseRefs.length - logicallyDeletedCount;

    let identifiedTotal = 0;
    let duplicatesTotal = 0;
    let statsComplete = true;

    const files = [...perFileAll.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([file]) => {
            const s = importStats[file];
            if (s) {
                identifiedTotal += s.identified;
                duplicatesTotal += s.duplicates;
                return { file, identified: s.identified, hasStats: true };
            }
            // 統計なし: 論理削除されていない件数（重複除去後の代表値）で代用
            statsComplete = false;
            const nonDeleted = perFileNonDeleted.get(file) ?? 0;
            identifiedTotal += nonDeleted;
            return { file, identified: nonDeleted, hasStats: false };
        });

    if (options?.refsMayOmitLogicallyDeleted) {
        // refs から論理削除された行が欠けている可能性があるため、duplicatesTotal は信用できない。
        // 既存の「合計不明」経路（[n] 表示・manuscript_warnNoStats 警告）へ合流させる。
        return {
            files,
            identifiedTotal,
            duplicatesTotal: null,
            screened,
            statsComplete: false,
        };
    }

    return {
        files,
        identifiedTotal,
        duplicatesTotal: statsComplete ? duplicatesTotal + logicallyDeletedCount : null,
        screened,
        statsComplete,
    };
}
