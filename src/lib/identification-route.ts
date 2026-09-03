// identification-route.ts - フルテキスト候補の「同定経路」判定（Issue #120）
//
// #118（レジストリ連携フェーズ1）で registration 行から「取り込む」を押すと、References に
// TiAb 判定を一切持たない行が追加される（related_ref_id 非空・source='Registry linkage (試験ID)'）。
// この行は src/lib/fulltext-candidates.ts の isProjectFulltextCandidateRef() が
// 「related_ref_id が非空なら無条件でフルテキスト候補」として扱うため、データベース検索由来では
// ない行がデータベース検索腕の PRISMA 数値に混ざってしまう。PRISMA 2020 では citation searching
// 等と同じ「Identification of studies via other methods」腕で報告するのが正しい。
//
// このモジュールは純関数のみで、DOM・state に依存しない
// （src/lib/fulltext-candidates.ts と同方針）。

import type { Reference } from './types';

export type IdentificationRoute = 'database' | 'registry_linkage';

/**
 * 1文献の同定経路を判定する。
 *
 * 【判定条件は related_ref_id が非空かどうか「だけ」にすること】
 * Issue #120 の本文は「related_ref_id 非空（または source の Registry linkage 接頭辞）」と
 * 書いているが、ここでは source は使わない。理由: fulltext-candidates.ts の
 * isProjectFulltextCandidateRef() が候補プールへ無条件投入する条件が related_ref_id 非空
 * のみなので、判定条件をそれと完全に一致させないと「候補一覧には database 腕として入っている
 * のに、集計では registry 腕に数えられる（またはその逆）」というズレが起きる。PRISMA の腕別
 * 集計は合計が候補総数と一致することが生命線なので、Single Source of Truth（related_ref_id）
 * に合わせる。
 */
export function identificationRouteOf(
    ref: Pick<Reference, 'related_ref_id'>
): IdentificationRoute {
    return (ref.related_ref_id || '').trim() !== '' ? 'registry_linkage' : 'database';
}

/**
 * 候補一覧を同定経路で database / registryLinkage に分割する。
 * 2つの戻り値配列の合計件数は必ず入力件数と一致する（PRISMA の腕別集計はここがズレると
 * 数字が合わなくなるため、分岐は identificationRouteOf() の二値のいずれかに必ず落ちる）。
 */
export function splitByIdentificationRoute<T extends Pick<Reference, 'related_ref_id'>>(
    refs: T[]
): { database: T[]; registryLinkage: T[] } {
    const database: T[] = [];
    const registryLinkage: T[] = [];
    for (const ref of refs) {
        if (identificationRouteOf(ref) === 'registry_linkage') {
            registryLinkage.push(ref);
        } else {
            database.push(ref);
        }
    }
    return { database, registryLinkage };
}

/** other methods 腕の PRISMA 集計に必要な最小限の構造（FulltextResultsSummary が構造的に適合する） */
export interface OtherMethodsPrismaSummary {
    sought: number;
    obtained: number;
    notRetrieved: number;
    include: number;
    exclude: number;
    reasons: Array<{ reason: string; count: number }>;
}

/**
 * other methods 腕（レジストリ連携）の PRISMA 行を組み立てる。
 *
 * summary が null または sought === 0（＝レジストリ連携経由の候補が0件）のときは空配列を返す。
 * これにより、呼び出し側（manuscript.ts の buildPrismaBlock()）は「0件のときは現行の出力から
 * 1文字も変わらない」という要件を、この関数の戻り値を無条件で追記するだけで満たせる。
 *
 * FulltextResultsSummary 型を src/lib/ から import しないのは、src/sidepanel/ → src/lib/ の
 * 依存方向を逆流させないため。構造的に必要な形（OtherMethodsPrismaSummary）だけを受け取り、
 * FulltextResultsSummary はその上位互換なので構造的部分型としてそのまま渡せる。
 * 除外理由の英語ラベル化は manuscript.ts の reasonLabelEn() を呼び出し側から関数で渡してもらう。
 */
export function buildOtherMethodsPrismaLines(
    summary: OtherMethodsPrismaSummary | null,
    reasonLabel: (reason: string) => string
): string[] {
    if (!summary || summary.sought === 0) return [];

    const lines: string[] = [];
    lines.push('Identification (other methods)');
    lines.push(`  Records identified via registry linkage (n = ${summary.sought})`);
    lines.push('Retrieval (other methods)');
    lines.push(`  Reports sought for retrieval (n = ${summary.sought})`);
    lines.push(`  Reports not retrieved (n = ${summary.notRetrieved})`);
    lines.push('Eligibility (other methods)');
    lines.push(`  Reports assessed for eligibility (n = ${summary.obtained})`);
    lines.push(`  Reports excluded (n = ${summary.exclude})${summary.reasons.length > 0 ? ':' : ''}`);
    for (const r of summary.reasons) {
        lines.push(`    ${reasonLabel(r.reason)} (n = ${r.count})`);
    }
    lines.push('Included (other methods)');
    lines.push(`  Studies included in review (n = ${summary.include})`);
    return lines;
}
