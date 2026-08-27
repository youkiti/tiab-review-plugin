// publication-import.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3（データ層）: 論文候補を References へ
// 取り込むときの「行の組み立て」を UI 非依存の純関数として切り出す。
// 呼び出し側（次チャンクのUI）とテストの両方から使えるようにするため、DOM/state には依存しない
// （fulltext-consensus.ts / fulltext-other-decisions.ts と同じ方針）。
//
// crypto.randomUUID() / new Date().toISOString() をこの中で直接呼ぶとテストが非決定的になるため、
// refId（新規発行する ref_id）と importedAt（取り込み日時）は必ず呼び出し側から注入する
// （registry-record.ts の buildRegistrySnapshotHtml が retrievedAt を注入させているのと同じ方針）。

import type { Reference, PublicationCandidate } from './types';
import type { FulltextAssignmentConfig } from './fulltext-assignment';
import { extractTrialId } from './registry-record';
import { generateDedupeKey } from './import-helpers';

/**
 * buildImportedPublicationReference() が受け取る候補の最小情報。
 * Publication_Candidates タブの1行（PublicationCandidate）から必要なフィールドだけを
 * Pick しているため、getPublicationCandidates() の戻り値をそのまま渡せる。
 */
export type ImportablePublicationCandidate = Pick<
    PublicationCandidate,
    'pmid' | 'doi' | 'title' | 'journal' | 'year' | 'trial_id'
>;

/** buildImportedPublicationReference() の入力 */
export interface BuildImportedPublicationReferenceInput {
    /** 取り込む論文候補（Publication_Candidates の1行、またはそれ相当のオブジェクト） */
    candidate: ImportablePublicationCandidate;
    /** 発見元の registration 行（References の既存行）。related_ref_id と source(試験ID) に使う */
    registrationRef: Pick<Reference, 'ref_id' | 'pmid' | 'url' | 'source'>;
    /** 新規発行する ref_id。関数内で crypto.randomUUID() を呼ばず、呼び出し側から注入する */
    refId: string;
    /** 取り込み者（email） */
    importedBy: string;
    /** 取り込み日時（ISO 8601）。関数内で new Date() を呼ばず、呼び出し側から注入する */
    importedAt: string;
}

/**
 * 論文候補を References へ取り込むときの1行を組み立てる（Issue #118 実装内容7・8）。
 *
 * 組み立て規則:
 * - record_type は常に 'article'。isRegistrationRecord() は record_type が確定値を持つ場合
 *   それを最優先するため、この行は取り込み後にレジストリ判定へ一切乗らない（通常の論文として
 *   OAウォーターフォール等の既存経路をそのまま通る）。
 * - related_ref_id は発見元 registration 行の ref_id。registration行 → 論文行の片方向のみ張る
 *   （逆方向のリンクは registration 行側に持たせない。1つの registration 行から複数の論文が
 *   取り込まれた場合でも、related_ref_id は「自分の発見元は1つ」という1対多の子側の関係として
 *   矛盾なく表現できるが、逆方向は1対1を超えるため）。
 * - source は `Registry linkage (試験ID)` 形式。試験IDは registrationRef から extractTrialId() で
 *   取る（候補側の trial_id は使わない。発見元行こそが正の情報源であるため）。取れない場合
 *   （通常のCTG/ICTRP由来行では起こらないはずだが、pmid列が空などの異常系）は
 *   buildRegistrySnapshotHtml() が試験ID不明時に使う表記 "(不明)" に合わせて
 *   `Registry linkage (不明)` とする。
 * - dedupe_key は import-helpers.ts の generateDedupeKey()（他インポータと同じ生成規則）を
 *   そのまま使う。独自のキー生成はしない。
 * - title/journal/year/pmid/doi は候補由来。title は Reference で必須（string）だが候補側は
 *   optional なため、欠落時は空文字にフォールバックする（他の任意フィールドと同じ `|| ''` の流儀。
 *   実運用では esummary/EuropePMC が必ず title を返す想定で、空になるのは異常系のみ）。
 * - url はここでは組み立てない。PubMed ID / DOI から URL 文字列を組み立てる、fetch を伴わない
 *   再利用可能な既存ヘルパーがリポジトリに存在しない（fulltext-retriever.ts 等にあるのは OA PDF
 *   探索のための fetch を伴う関数で、単純な文字列組み立てとは別物）。ここで独自の URL 形式
 *   （例: `https://pubmed.ncbi.nlm.nih.gov/{pmid}/`）を新設すると、将来 pmid/doi から URL を
 *   組み立てる正式なヘルパーができたときに実装が二重化するため、このチャンクでは url を
 *   空のままにする判断とした。取り込み後は次チャンクの単発OA検索が pmid/doi から fulltext_url を
 *   解決するため、ユーザーが論文本体へたどり着く手段自体は別途用意される。
 * - imported_at / imported_by は引数から。
 * - fulltext_url / fulltext_status は設定しない（取り込み後に単発OA検索で埋まる。次チャンクの担当）。
 *   buildReferenceInsertRow() 側で空文字パディングされる列のため、この戻り値では undefined の
 *   ままにしておけばよい。
 * - fulltext_set はここでは設定しない。担当割り振り済みプロジェクトで registration 行の
 *   fulltext_set をコピーすべきかどうかの判定は resolveImportedFulltextSet() に切り出してあり、
 *   実際に References へ書き込む呼び出し（updateReferenceFulltextSets()）は次チャンク（UI）が
 *   addReferences() の後に別途行う。
 */
export function buildImportedPublicationReference(
    input: BuildImportedPublicationReferenceInput
): Reference {
    const { candidate, registrationRef, refId, importedBy, importedAt } = input;

    const trialId = extractTrialId(registrationRef);
    // registry-record.ts の buildRegistrySnapshotHtml() は「(不明)」をそのまま埋め込むが、
    // ここでは呼び出し側の `Registry linkage (${trialLabel})` が既に括弧を付けるため、
    // 括弧を二重にしないよう中身の「不明」だけを持たせる。
    const trialLabel = trialId?.id || '不明';

    return {
        ref_id: refId,
        title: candidate.title || '',
        year: candidate.year,
        journal: candidate.journal || '',
        doi: candidate.doi || '',
        pmid: candidate.pmid || '',
        source: `Registry linkage (${trialLabel})`,
        imported_at: importedAt,
        imported_by: importedBy,
        dedupe_key: generateDedupeKey(candidate.title, candidate.pmid, candidate.doi),
        record_type: 'article',
        related_ref_id: registrationRef.ref_id,
    };
}

/**
 * 取り込んだ論文行へコピーすべき fulltext_set 値を決める（Issue #118 実装内容8）。
 *
 * 担当割り振りが 'configured' のときだけ、発見元 registration 行の fulltext_set をそのまま
 * 返す。'configured' 以外（'none'）では担当グループという概念自体が存在しないため空文字を返す
 * （fulltextSetOf() 等、既存の fulltext-assignment.ts の各関数も同様に status で分岐している）。
 *
 * この関数は「コピーすべき値」を返すだけの純関数で、実際に References へ書き込む呼び出し
 * （updateReferenceFulltextSets()、addReferences() の後に呼ぶ）は次チャンク（UI）の担当。
 */
export function resolveImportedFulltextSet(
    registrationRef: Pick<Reference, 'fulltext_set'>,
    assignment: FulltextAssignmentConfig
): string {
    if (assignment.status !== 'configured') return '';
    return registrationRef.fulltext_set || '';
}
