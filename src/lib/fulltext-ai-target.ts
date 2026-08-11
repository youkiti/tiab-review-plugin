/**
 * フルテキストAI判定（PDF全文）の「対象」を決める純粋ロジック
 *
 * 設計の要点:
 *
 * 1. **既定の対象範囲はプロジェクト全体**（`scope='project'`）。
 *    AI は人間とは独立した判定者なので、「誰がどの文献を読む担当か」という人間側の分業
 *    （フルテキスト担当割り振り・担当セットの絞り込み）で対象を狭める理由が無い。
 *    管理者が自分では読まない文献も含めて一括でAI判定したい、というのが通常の使い方。
 *    自分の担当分だけ試したいときのために `scope='assigned'`（従来の挙動）も残す。
 *
 * 2. **「AI判定済みか」の判定は Blind 状態に依存させない**。
 *    Blind 中（key_opened=FALSE）に読み込まれる `ReferenceWithStatus.allFulltextDecisions` は
 *    空なので、参照側の判定票から「AI判定済み」を導くと Blind 中は常に未判定に見えてしまい、
 *    同じPDFを何度も課金して判定する。そのため対象の除外は **Decisions タブから読み直した
 *    ラウンドID（reviewer_id）と ref_id の突き合わせ**で行う（`collectAiJudgedRefIds`）。
 *
 * 3. 除外に使うラウンドは「採用ラウンド」（Config `fulltext_ai_active_round`）。
 *    採用ラウンドが無いときは除外しない（＝別モデルでラウンドをもう1本作れる）。
 *
 * このモジュールは純関数のみで、DOM・state に依存しない。
 */

import type { FulltextStatus } from './types';

/** AI判定の対象範囲 */
export type FulltextAiScope = 'project' | 'assigned';

/** 既定はプロジェクト全体（上記 1.） */
export const DEFAULT_FULLTEXT_AI_SCOPE: FulltextAiScope = 'project';

/** ラジオ等の入力値を対象範囲へ正規化する（不正値は既定へ倒す） */
export function parseFulltextAiScope(raw: string | null | undefined): FulltextAiScope {
    return raw === 'assigned' ? 'assigned' : DEFAULT_FULLTEXT_AI_SCOPE;
}

/** AI判定の対象判定に必要な Reference の最小形 */
export interface FulltextAiTargetRef {
    ref_id: string;
    fulltext_status?: FulltextStatus;
    fulltext_url?: string;
}

/** 全文PDFが Drive に保存済み（＝Geminiへ送れる）か */
export function hasCachedFulltext(ref: FulltextAiTargetRef): boolean {
    return ref.fulltext_status === 'cached' && (ref.fulltext_url || '').trim() !== '';
}

/** 判定済み ref_id の抽出に必要な Decision の最小形（Decisions 1行分） */
export interface FulltextAiDecisionRow {
    reviewer_id?: string;
    ref_id?: string;
    screening_phase?: string;
}

/**
 * 指定ラウンド（reviewer_id）が判定済みの ref_id を Decisions 行から抽出する
 *
 * - fulltext フェーズの行だけを見る（TiAb のAIラウンドとは別枠）
 * - シート直編集で空白が混じりうるため trim してから突き合わせる
 * - ラウンドが空集合なら誰も判定していない扱い（＝全件が対象）
 */
export function collectAiJudgedRefIds(
    decisions: readonly FulltextAiDecisionRow[],
    roundIds: ReadonlySet<string>
): Set<string> {
    const judged = new Set<string>();
    if (roundIds.size === 0) return judged;

    for (const decision of decisions) {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') continue;
        const reviewerId = (decision.reviewer_id || '').trim();
        if (!roundIds.has(reviewerId)) continue;
        const refId = (decision.ref_id || '').trim();
        if (refId) judged.add(refId);
    }
    return judged;
}

/**
 * 実際にAI判定へ投げる文献を切り出す
 *
 * @param candidates 対象範囲を適用済みのフルテキスト候補
 * @param judgedRefIds 採用ラウンドが既に判定済みの ref_id 集合
 */
export function selectFulltextAiTargets<T extends FulltextAiTargetRef>(
    candidates: readonly T[],
    judgedRefIds: ReadonlySet<string>
): T[] {
    return candidates.filter(ref => hasCachedFulltext(ref) && !judgedRefIds.has(ref.ref_id));
}

export interface FulltextAiTargetCounts {
    /** これから判定する件数（全文確保済み・採用ラウンドで未判定） */
    target: number;
    /** 全文確保済み（cached）の件数 */
    cached: number;
    /** 全文確保済みだが採用ラウンドで判定済みのため除外された件数 */
    alreadyJudged: number;
}

/** 対象件数の内訳を数える（UI表示用。selectFulltextAiTargets と同じ条件） */
export function countFulltextAiTargets<T extends FulltextAiTargetRef>(
    candidates: readonly T[],
    judgedRefIds: ReadonlySet<string>
): FulltextAiTargetCounts {
    const cachedRefs = candidates.filter(hasCachedFulltext);
    const target = cachedRefs.filter(ref => !judgedRefIds.has(ref.ref_id)).length;
    return {
        target,
        cached: cachedRefs.length,
        alreadyJudged: cachedRefs.length - target,
    };
}
