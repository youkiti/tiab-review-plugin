// team-progress.ts - チーム進捗の集計ロジック（純粋関数）
//
// 目的: レビュアー同士がお互いの進捗（件数と最終判定日時のみ）を見られるようにし、
// 相互の緊張感を保つ。ブラインディング維持のため include/exclude の内訳は扱わない。
//
// 集計の考え方:
// - 進捗としてカウントする判定 = 人間の判定（確定ML判定を含む）。
//   LLM判定（reviewer_id が `llm:`）と ML自動判定（client_version に `-ml-auto`）、
//   メモのみの `pending` 行は進捗に含めない。
// - TiAb の分母: 担当割り振りが configured ならその人の担当セット
//   （calibration + reviewerMap で割り当てられたセット）内の文献数。未設定なら全文献数。
// - フルテキストの分母: 候補ルール（FulltextPoolRule）が設定済みの場合のみ、
//   ルールで決まる共通候補プールの文献数。未設定時は分母が人によって異なるため非表示（null）。
//
// 担当セットの絞り込み:
// - 画面下部の担当セットのチェックボックス選択を任意入力（tiabSetFilter / fulltextSetFilter）
//   として受け取ると、上記の分母・分子をさらに選択セット内へ限定する。省略時は従来どおり
//   絞り込まない（後方互換）。
// - TiAb 側の発動条件は src/sidepanel/store/selectors.ts の getFilteredReferences() の
//   担当セットフィルターと同じ規則（isTiabSetFilterActive）。
// - フルテキスト側は matchesSelectedFulltextSets()（fulltext-assignment.ts）をそのまま
//   再利用する（isFulltextSetFilterActive はその関数への薄いプローブで、同等の分岐を
//   別の場所へ書き直さない）。
// - 絞り込みが効いていて、そのメンバーが選択セット内に対象文献を1件も持たない場合は
//   tiabInScope / fulltextInScope を false にする（0/0 と「対象外」を区別するため）。

import type { Decision, AssignmentConfig, Reference } from './types';
import { isMlAutoDecision } from './client-version';
import { isTiabDecision, type FulltextPoolRule } from './fulltext-pool';
import { getRefAssignmentSet } from './assignment-roster';
import {
    createDefaultFulltextAssignment,
    getFulltextSetsForUser,
    matchesSelectedFulltextSets,
    type FulltextAssignmentConfig,
} from './fulltext-assignment';
import { isSharedFulltextPoolMember } from './fulltext-candidates';

/**
 * 集計に必要な文献情報の最小形。
 *
 * related_ref_id は isSharedFulltextPoolMember() の「取り込んだ論文行は無条件で候補」分岐
 * （Issue #118 チャンク3）に必要。この型を絞り込んで生成する箇所（sidepanel側の
 * initTeamProgress() / buildFooter() の🔄ボタン）が related_ref_id を落とすと、
 * 型は Pick<Reference, ...> と構造的に適合してしまうため typecheck では検出できないまま
 * その分岐が本番で一度も発火しなくなる（実際に発生した見落とし）。この型を絞り込んで
 * 生成し直す・キャッシュするコードを新設・変更するときは、必ず related_ref_id も含めること。
 */
export interface TeamProgressRef {
    ref_id: string;
    screening_set?: string;
    fulltext_set?: string;
    related_ref_id?: string;
}

/**
 * ReferenceWithStatus（またはそれを内包する Reference 系オブジェクト）から TeamProgressRef を
 * 組み立てる純関数。呼び出し側は `src/sidepanel/features/team-progress.ts` の
 * `initTeamProgress()` と `buildFooter()` の🔄ボタンのフォールバックの2箇所で、
 * 以前はそれぞれが同じ内容のオブジェクトリテラルを個別に手書きしていた。
 *
 * この関数へ集約した理由（Issue #118 チャンク3、PR #124 レビュー指摘フォローアップ）:
 * 上記コメントのとおり、`TeamProgressRef` はフィールドが全て optional のため、
 * `Pick<Reference, ...>` のような絞り込み型を渡す2箇所のどちらかが `related_ref_id` を
 * 落としても、構造的部分型のせいで typecheck は通ってしまう。手書きの回帰テスト
 * （`computeTeamProgress()` へ `TeamProgressRef[]` のリテラルを直接渡す形）もこの欠落を
 * 再現できない（絞り込み型を組み立てている箇所そのものを通らないため）。呼び出し元を
 * この1関数へ集約し、この関数自身の入出力をユニットテストすることで、
 * 「配線の境界」（実際に絞り込み型を組み立てている場所）でフィールド欠落を検出できるようにする。
 */
export function toTeamProgressRef(
    ref: Pick<Reference, 'ref_id' | 'screening_set' | 'fulltext_set' | 'related_ref_id'>
): TeamProgressRef {
    return {
        ref_id: ref.ref_id,
        screening_set: ref.screening_set,
        fulltext_set: ref.fulltext_set,
        related_ref_id: ref.related_ref_id,
    };
}

/** レビュアー1人分の進捗 */
export interface TeamMemberProgress {
    email: string;
    isSelf: boolean;
    tiabDone: number;
    tiabTotal: number;
    /**
     * 担当セットの絞り込みが効いていて、かつこのメンバーが選択中のセットに
     * 対象文献を1件も持たない場合は false（0/0 と「対象外」を区別するため）。
     * 絞り込みが効いていないときは常に true。
     */
    tiabInScope: boolean;
    /** 候補ルール未設定時は null（分母が共有できないため表示しない） */
    fulltextDone: number | null;
    fulltextTotal: number | null;
    /** tiabInScope と同じ考え方のフルテキスト版。絞り込みが効いていないときは常に true */
    fulltextInScope: boolean;
    /** 最終判定日時（ISO 8601）。進捗対象の判定が1件もなければ null */
    lastDecidedAt: string | null;
}

/** TiAb 担当セットの絞り込み指定（省略時は絞り込まない） */
export interface TiabSetFilterInput {
    /** 存在しうる全セットID（state.assignmentSets 相当） */
    availableSets: Set<string>;
    /** チェックボックスで選択中のセットID（state.selectedAssignmentSets 相当） */
    selectedSets: Set<string>;
}

/** フルテキスト担当セットの絞り込み指定（省略時は絞り込まない） */
export interface FulltextSetFilterInput {
    /** チェックボックスで選択中のセットID（state.selectedFulltextSets 相当） */
    selectedSets: Set<string>;
}

export interface TeamProgressInput {
    refs: TeamProgressRef[];
    decisions: Decision[];
    assignmentConfig: AssignmentConfig;
    poolRule: FulltextPoolRule | null;
    /** フルテキスト担当割り振り。省略時は未設定（全員が全候補）として扱う */
    fulltextAssignment?: FulltextAssignmentConfig;
    userEmail: string;
    /** TiAb 担当セットの絞り込み。省略時は絞り込まない */
    tiabSetFilter?: TiabSetFilterInput;
    /** フルテキスト担当セットの絞り込み。省略時は絞り込まない */
    fulltextSetFilter?: FulltextSetFilterInput;
}

function normalizeEmail(email: string): string {
    return (email || '').trim().toLowerCase();
}

/** 進捗としてカウントする判定か（人間 + 確定ML。LLM/ML自動/メモのみ行は除外） */
function isProgressDecision(d: Decision): boolean {
    const reviewerId = (d.reviewer_id || '').trim();
    if (!reviewerId || reviewerId.startsWith('llm:')) return false;
    if (isMlAutoDecision(d.client_version)) return false;
    if (d.decision === 'pending') return false;
    return true;
}

/**
 * 担当割り振りからそのレビュアーの担当セットを返す
 * assignment.ts の getAssignedSetsForUser と同じ規則（calibration は全員の担当）
 */
function assignedSetsFor(config: AssignmentConfig, email: string): Set<string> {
    const assigned = new Set<string>(['calibration']);
    const normalized = normalizeEmail(email);
    for (const [setId, reviewers] of Object.entries(config.reviewerMap || {})) {
        if ((reviewers || []).some((r) => normalizeEmail(r) === normalized)) {
            assigned.add(setId);
        }
    }
    return assigned;
}

/**
 * 文献の担当セットID（assignment.ts の getReferenceAssignmentSet と同じ規則）
 * 実体は assignment-roster.ts の getRefAssignmentSet に委譲（重複定義を避けるため）。
 */
function refSetOf(ref: TeamProgressRef): string {
    return getRefAssignmentSet(ref);
}

/**
 * TiAb 担当セットの絞り込みが実際に効くかどうか。
 * src/sidepanel/store/selectors.ts の getFilteredReferences() の担当セットフィルター
 * （コメント「担当セットフィルター（全選択時は絞らず、未選択時は空にする）」の直後）と
 * 同じ規則: 「全セット数 > 0 かつ 選択数 < 全セット数」のときだけ絞る。
 * computeTeamProgress() 本体と、対象セット名の表示要否を決める呼び出し側
 * （src/sidepanel/features/team-progress.ts）の両方から使い、判定基準がずれないようにする。
 */
export function isTiabSetFilterActive(
    assignmentConfigured: boolean,
    availableSets: Set<string>,
    selectedSets: Set<string>
): boolean {
    return assignmentConfigured && availableSets.size > 0 && selectedSets.size < availableSets.size;
}

/**
 * フルテキスト担当セットの絞り込みが実際に効くかどうか。
 * matchesSelectedFulltextSets() は「未設定 / 選択0件 / 全グループ選択」のときに
 * 絞らない判定をすでに持っているため、その分岐をここで書き直さず、
 * 存在しうる ft-group-1..N を順にプローブして matchesSelectedFulltextSets() 自身に
 * 判定させることで再利用する（全グループが選択されていれば全プローブが true になり非絞込と判定）。
 */
export function isFulltextSetFilterActive(
    fulltextAssignment: FulltextAssignmentConfig,
    selectedSets: Set<string>
): boolean {
    for (let i = 1; i <= fulltextAssignment.groupCount; i += 1) {
        if (!matchesSelectedFulltextSets({ fulltext_set: `ft-group-${i}` }, fulltextAssignment, selectedSets)) {
            return true;
        }
    }
    return false;
}

/**
 * チーム全員の進捗を集計する
 * 返り値は自分が先頭、以降はメールアドレス昇順
 */
export function computeTeamProgress(input: TeamProgressInput): TeamMemberProgress[] {
    const { refs, decisions, assignmentConfig, poolRule, fulltextAssignment, tiabSetFilter, fulltextSetFilter } = input;
    const userEmail = normalizeEmail(input.userEmail);
    const assignmentConfigured = assignmentConfig.status === 'configured';
    const ftAssignmentConfigured = fulltextAssignment?.status === 'configured';
    const resolvedFulltextAssignment = fulltextAssignment ?? createDefaultFulltextAssignment();

    // 絞り込みが実際に効くかどうかは1回だけ判定し、メンバーごとのループでは使い回す。
    // tiabSelectedSets は「絞り込みが効いているときだけ選択セットを持つ」形にし、
    // 効いていなければ null（tiabFilterActive はこの null 判定から導出する）。
    // isTiabSetFilterActive(assignmentConfigured, ...) が真になるのは assignmentConfigured
    // のときだけなので、下のメンバーごとのループでは「割り振り済みなら分母を絞る」の
    // 1ブロックへ選択セットの条件をそのまま畳み込める（担当セット判定と選択セット判定を
    // 別々に2回 refs を走査しなくてよい）。
    const tiabSelectedSets: Set<string> | null = (tiabSetFilter
        && isTiabSetFilterActive(assignmentConfigured, tiabSetFilter.availableSets, tiabSetFilter.selectedSets))
        ? tiabSetFilter.selectedSets
        : null;
    const tiabFilterActive = tiabSelectedSets !== null;
    const fulltextFilterActive = !!fulltextSetFilter
        && isFulltextSetFilterActive(resolvedFulltextAssignment, fulltextSetFilter.selectedSets);

    // ---- メンバー発見: 割り振り設定（TiAb + フルテキスト） + 判定実績 + 自分 ----
    const members = new Set<string>();
    for (const reviewers of Object.values(assignmentConfig.reviewerMap || {})) {
        for (const r of reviewers || []) {
            const email = normalizeEmail(r);
            if (email) members.add(email);
        }
    }
    for (const reviewers of Object.values(fulltextAssignment?.reviewerMap || {})) {
        for (const r of reviewers || []) {
            const email = normalizeEmail(r);
            if (email) members.add(email);
        }
    }
    for (const d of decisions) {
        if (!isProgressDecision(d)) continue;
        members.add(normalizeEmail(d.reviewer_id));
    }
    if (userEmail) members.add(userEmail);

    // ---- 文献ごとの全判定（フルテキスト候補プール計算用） ----
    const decisionsByRef = new Map<string, Decision[]>();
    for (const d of decisions) {
        const list = decisionsByRef.get(d.ref_id);
        if (list) {
            list.push(d);
        } else {
            decisionsByRef.set(d.ref_id, [d]);
        }
    }

    // ---- フルテキスト候補プール（全員共通の分母） ----
    // 担当割り振り設定済みなら fulltext_set 列（判定票に依存しない）が非空の文献に加えて、
    // 割り振り後にプールへ新規流入した「未割り当て」分（fulltext_set が空だがプールルール成立）も
    // 分母に含める（isSharedFulltextPoolMember、ユーザー非依存の共有分母判定）。
    // Blind中は他人の票が読み込まれずプールルール評価が人によってブレるため、
    // 割り振り済みプロジェクトでは fulltext_set 列を優先しつつ、流入分だけベストエフォートで
    // プールルール評価する。未設定時は従来どおりプールルール評価のみ（ルール未設定なら分母なし = null）。
    const poolRefIds = (ftAssignmentConfigured || poolRule)
        ? new Set(
            refs
                .filter((r) => isSharedFulltextPoolMember({
                    ref: r,
                    decisions: decisionsByRef.get(r.ref_id) ?? [],
                    poolRule,
                    assignment: fulltextAssignment ?? createDefaultFulltextAssignment(),
                }))
                .map((r) => r.ref_id)
        )
        : null;

    // ---- メンバー別: フェーズごとの判定済み ref_id と最終判定日時 ----
    const tiabDoneByMember = new Map<string, Set<string>>();
    const fulltextDoneByMember = new Map<string, Set<string>>();
    const lastDecidedByMember = new Map<string, string>();

    for (const d of decisions) {
        if (!isProgressDecision(d)) continue;
        const email = normalizeEmail(d.reviewer_id);

        if (isTiabDecision(d)) {
            let set = tiabDoneByMember.get(email);
            if (!set) tiabDoneByMember.set(email, (set = new Set()));
            set.add(d.ref_id);
        } else {
            let set = fulltextDoneByMember.get(email);
            if (!set) fulltextDoneByMember.set(email, (set = new Set()));
            set.add(d.ref_id);
        }

        const last = lastDecidedByMember.get(email);
        if (!last || (d.decided_at || '') > last) {
            lastDecidedByMember.set(email, d.decided_at || '');
        }
    }

    // ---- メンバーごとに分母・分子を確定 ----
    const result: TeamMemberProgress[] = [];
    for (const email of members) {
        // TiAb 分母: 担当セット内の文献（割り振り未設定なら全文献）。
        // 担当セットの絞り込みが効いている場合（tiabFilterActive）は、この1回の走査へ
        // 選択中セットの条件も畳み込んで分母を限定する（tiabFilterActive は assignmentConfigured
        // を含意するため、このブロックの外側に別扱いの分岐を作る必要はない）。
        let tiabRefIds: Set<string> | null = null;
        let tiabTotal = refs.length;
        if (assignmentConfigured) {
            const assigned = assignedSetsFor(assignmentConfig, email);
            tiabRefIds = new Set(
                refs
                    .filter((r) => {
                        const setId = refSetOf(r);
                        if (!assigned.has(setId)) return false;
                        return !tiabSelectedSets || tiabSelectedSets.has(setId);
                    })
                    .map((r) => r.ref_id)
            );
            tiabTotal = tiabRefIds.size;
        }
        const tiabInScope = !tiabFilterActive || tiabTotal > 0;

        const tiabDoneSet = tiabDoneByMember.get(email) ?? new Set<string>();
        let tiabDone = 0;
        for (const refId of tiabDoneSet) {
            if (!tiabRefIds || tiabRefIds.has(refId)) tiabDone++;
        }

        // フルテキスト: 共通プールがある場合のみ集計。
        // 担当割り振り設定済みなら、そのメンバーの分母 = プール ∩（担当セット + 未割り当て）
        // （未割り当て = 割り振り後の新規流入分。全員に表示される仕様に合わせて全員の分母に含める）
        let fulltextDone: number | null = null;
        let fulltextTotal: number | null = null;
        let fulltextInScope = true;
        if (poolRefIds) {
            let memberPoolRefIds = poolRefIds;
            if (ftAssignmentConfigured && fulltextAssignment) {
                const ftSets = getFulltextSetsForUser(fulltextAssignment, email);
                memberPoolRefIds = new Set(
                    refs
                        .filter((r) => {
                            if (!poolRefIds.has(r.ref_id)) return false;
                            const setId = (r.fulltext_set || '').trim();
                            return !setId || ftSets.has(setId);
                        })
                        .map((r) => r.ref_id)
                );
            }

            // 担当セットの絞り込みが効いている場合は、さらに選択中のセットへ限定する
            // （分岐は matchesSelectedFulltextSets() へ委譲し、ここでは書き直さない）
            if (fulltextFilterActive) {
                memberPoolRefIds = new Set(
                    refs
                        .filter((r) => memberPoolRefIds.has(r.ref_id)
                            && matchesSelectedFulltextSets(r, resolvedFulltextAssignment, fulltextSetFilter!.selectedSets))
                        .map((r) => r.ref_id)
                );
            }

            fulltextTotal = memberPoolRefIds.size;
            fulltextInScope = !fulltextFilterActive || fulltextTotal > 0;
            fulltextDone = 0;
            for (const refId of fulltextDoneByMember.get(email) ?? new Set<string>()) {
                if (memberPoolRefIds.has(refId)) fulltextDone++;
            }
        }

        result.push({
            email,
            isSelf: email === userEmail,
            tiabDone,
            tiabTotal,
            tiabInScope,
            fulltextDone,
            fulltextTotal,
            fulltextInScope,
            lastDecidedAt: lastDecidedByMember.get(email) || null,
        });
    }

    // 自分を先頭、以降はメール昇順（順位付けは意図的にしない）
    result.sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        return a.email.localeCompare(b.email);
    });
    return result;
}

/** 表示用の短縮名（メールのローカル部、長い場合は省略） */
export function shortNameOf(email: string, maxLength = 10): string {
    const local = email.split('@')[0] || email;
    return local.length > maxLength ? `${local.slice(0, maxLength)}…` : local;
}

/** 進捗率（0-100、分母0は0%） */
export function percentOf(done: number, total: number): number {
    return total > 0 ? Math.round((done / total) * 100) : 0;
}
