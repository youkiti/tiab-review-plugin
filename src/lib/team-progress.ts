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

import type { Decision, AssignmentConfig } from './types';
import { isMlAutoDecision } from './client-version';
import { isTiabDecision, type FulltextPoolRule } from './fulltext-pool';
import {
    createDefaultFulltextAssignment,
    getFulltextSetsForUser,
    type FulltextAssignmentConfig,
} from './fulltext-assignment';
import { isSharedFulltextPoolMember } from './fulltext-candidates';

/** 集計に必要な文献情報の最小形 */
export interface TeamProgressRef {
    ref_id: string;
    screening_set?: string;
    fulltext_set?: string;
}

/** レビュアー1人分の進捗 */
export interface TeamMemberProgress {
    email: string;
    isSelf: boolean;
    tiabDone: number;
    tiabTotal: number;
    /** 候補ルール未設定時は null（分母が共有できないため表示しない） */
    fulltextDone: number | null;
    fulltextTotal: number | null;
    /** 最終判定日時（ISO 8601）。進捗対象の判定が1件もなければ null */
    lastDecidedAt: string | null;
}

export interface TeamProgressInput {
    refs: TeamProgressRef[];
    decisions: Decision[];
    assignmentConfig: AssignmentConfig;
    poolRule: FulltextPoolRule | null;
    /** フルテキスト担当割り振り。省略時は未設定（全員が全候補）として扱う */
    fulltextAssignment?: FulltextAssignmentConfig;
    userEmail: string;
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

/** 文献の担当セットID（assignment.ts の getReferenceAssignmentSet と同じ規則） */
function refSetOf(ref: TeamProgressRef): string {
    const normalized = (ref.screening_set || '').trim();
    return normalized || 'unassigned';
}

/**
 * チーム全員の進捗を集計する
 * 返り値は自分が先頭、以降はメールアドレス昇順
 */
export function computeTeamProgress(input: TeamProgressInput): TeamMemberProgress[] {
    const { refs, decisions, assignmentConfig, poolRule, fulltextAssignment } = input;
    const userEmail = normalizeEmail(input.userEmail);
    const assignmentConfigured = assignmentConfig.status === 'configured';
    const ftAssignmentConfigured = fulltextAssignment?.status === 'configured';

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
        // TiAb 分母: 担当セット内の文献（割り振り未設定なら全文献）
        let tiabRefIds: Set<string> | null = null;
        let tiabTotal = refs.length;
        if (assignmentConfigured) {
            const assigned = assignedSetsFor(assignmentConfig, email);
            tiabRefIds = new Set(refs.filter((r) => assigned.has(refSetOf(r))).map((r) => r.ref_id));
            tiabTotal = tiabRefIds.size;
        }

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
            fulltextTotal = memberPoolRefIds.size;
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
            fulltextDone,
            fulltextTotal,
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
