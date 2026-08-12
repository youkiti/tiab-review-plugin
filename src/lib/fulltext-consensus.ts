// fulltext-consensus.ts - フルテキスト判定の合議計算（純粋関数）
//
// src/sidepanel/features/fulltext-results.ts は DOM と state に依存していてテストできないため、
// 「複数判定者の票から最終判定を決める」計算だけをここへ切り出す。fulltext-results.ts 側は
// ReferenceWithStatus → 票の配列への変換（judgeDecisionMap 等）と描画だけを担当する。
// DOM/i18n には依存しない（他の src/lib/fulltext-*.ts と同じ方針）。
//
// 合議のルール:
// - 通常は選択判定者の OR 合議（誰か1人でも include なら include、次に maybe、次に exclude、
//   全員 pending/判定なしなら pending）。挙動は従来の computeConsensus（旧 fulltext-results.ts）と同じ
// - 裁定票（reviewer_id が 'adjudication:{email}'）があれば、それが OR合議より優先される最終判定になる。
//   理由も裁定票のものを使う。裁定は誰でも可能なため裁定票が複数存在しうるが、その場合は
//   decidedAt が最も新しいものを最終とする（同一裁定者による「裁定のやり直し」も、別の裁定者による
//   後着の裁定も、同じルールで自然に決まる）
// - 除外理由は pickPrimaryExcludeReason（番号最小＝優先順位が上位）で代表を選ぶ。裁定票があれば
//   その理由を使う
//
// 不一致の種類（2種類を区別する。詳細は AGENTS.md「フルテキストの除外理由」参照）:
// - conflict: 非pendingの判定値（include/exclude/maybe）が2種類以上（従来どおりの「判定不一致」）
// - reasonConflict: 全員 exclude で、有効な除外理由が2種類以上（hasExcludeReasonConflict を使う）。
//   判定自体は一致していても理由が割れているケースを別枠で検出する
// - unresolved: (conflict || reasonConflict) && !adjudicated
//   裁定票があれば、判定・理由の不一致が残っていても「解消済み」として扱う

import { pickPrimaryExcludeReason, hasExcludeReasonConflict } from './exclude-reasons';

/** フルテキスト判定の合議結果の型（旧 fulltext-results.ts のローカル型をここへ移設） */
export type ConsensusDecision = 'include' | 'exclude' | 'maybe' | 'pending';

/** 裁定票の reviewer_id プレフィックス。この後ろに裁定者のメールアドレスを続ける。 */
export const ADJUDICATION_PREFIX = 'adjudication:';

/** 判定者キーが裁定票かどうか */
export function isAdjudicationKey(key: string): boolean {
    return key.startsWith(ADJUDICATION_PREFIX);
}

/** 裁定者のメールアドレスから裁定票の reviewer_id を組み立てる */
export function adjudicationReviewerId(email: string): string {
    return `${ADJUDICATION_PREFIX}${email}`;
}

/**
 * 裁定票の reviewer_id から裁定者のメールアドレスを取り出す。
 * 裁定票のキーでなければ（呼び出し側の誤用に対する安全弁として）そのまま返す。
 */
export function adjudicationEmail(reviewerId: string): string {
    return isAdjudicationKey(reviewerId) ? reviewerId.slice(ADJUDICATION_PREFIX.length) : reviewerId;
}

/** 合議計算に渡す1票分の入力。通常の判定者票・裁定票の両方をこの形で表す。 */
export interface FulltextVote {
    /** 判定者キー（reviewer_id。裁定票は adjudicationReviewerId() の形式）。 */
    judge: string;
    decision: ConsensusDecision;
    /** decision === 'exclude' のときの理由（PRISMA区分） */
    reason?: string;
    note?: string;
    /** ISO 8601。裁定票が複数ある場合に最新の裁定を選ぶために使う。 */
    decidedAt?: string;
}

export interface FulltextConsensusResult {
    /** 最終判定。裁定票があればその判定、無ければ選択判定者のOR合議。 */
    decision: ConsensusDecision;
    /** 除外時の代表理由。裁定票があればその理由、無ければ pickPrimaryExcludeReason の結果。 */
    primaryReason: string;
    /** 非pendingの判定値が2種類以上（従来どおりの「判定不一致」）。裁定の有無に関わらない生の値。 */
    conflict: boolean;
    /** 全員 exclude で有効な理由が2種類以上（「理由不一致」）。裁定の有無に関わらない生の値。 */
    reasonConflict: boolean;
    /** 裁定票があるか */
    adjudicated: boolean;
    /** 裁定者のメールアドレス（未裁定なら null） */
    adjudicatedBy: string | null;
    /** 裁定日時 ISO 8601（未裁定なら null） */
    adjudicatedAt: string | null;
    /** (conflict || reasonConflict) && !adjudicated */
    unresolved: boolean;
    /** exclude票を出した通常判定者ごとの理由・メモ（裁定票は含まない。PRISMA内訳・CSV・不一致解消UI用） */
    excludeReasons: Array<{ judge: string; reason: string; note?: string }>;
}

/**
 * 判定者の票配列から合議結果を計算する。
 *
 * votes には通常の判定者の票と裁定票（isAdjudicationKey で判定）を混在させてよい
 * （呼び出し側で事前に分ける必要はない）。conflict/reasonConflict は常に通常票だけから
 * 計算する（裁定票を「判定者の1人」として混ぜて誤検出しないため）。
 */
export function computeFulltextConsensus(votes: readonly FulltextVote[]): FulltextConsensusResult {
    const regularVotes = votes.filter(v => !isAdjudicationKey(v.judge));
    const adjudicationVotes = votes.filter(v => isAdjudicationKey(v.judge));

    const values = new Set<ConsensusDecision>();
    const excludeReasons: FulltextConsensusResult['excludeReasons'] = [];
    for (const v of regularVotes) {
        if (v.decision === 'pending') continue;
        values.add(v.decision);
        if (v.decision === 'exclude') {
            excludeReasons.push({ judge: v.judge, reason: v.reason || '', note: v.note });
        }
    }

    let decision: ConsensusDecision = 'pending';
    if (values.has('include')) decision = 'include';
    else if (values.has('maybe')) decision = 'maybe';
    else if (values.has('exclude')) decision = 'exclude';

    const conflict = values.size >= 2;
    // 「全員 exclude」= 非pendingの判定値が exclude だけ（値の種類が1つ、かつそれが exclude）
    const reasonConflict = values.size === 1 && values.has('exclude')
        && hasExcludeReasonConflict(excludeReasons.map(r => r.reason));

    let primaryReason = pickPrimaryExcludeReason(excludeReasons.map(r => r.reason));
    let adjudicated = false;
    let adjudicatedBy: string | null = null;
    let adjudicatedAt: string | null = null;

    if (adjudicationVotes.length > 0) {
        const latest = adjudicationVotes.reduce((best, v) =>
            (v.decidedAt || '') > (best.decidedAt || '') ? v : best
        );
        decision = latest.decision;
        primaryReason = latest.decision === 'exclude' ? (latest.reason || '') : '';
        adjudicated = true;
        adjudicatedBy = adjudicationEmail(latest.judge);
        adjudicatedAt = latest.decidedAt ?? null;
    }

    const unresolved = (conflict || reasonConflict) && !adjudicated;

    return {
        decision,
        primaryReason,
        conflict,
        reasonConflict,
        adjudicated,
        adjudicatedBy,
        adjudicatedAt,
        unresolved,
        excludeReasons,
    };
}
