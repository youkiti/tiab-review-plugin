// 取得済み References と Decisions から画面用の ReferenceWithStatus を合成する純関数。
// 入力は書き換えない。正規化はコピーへ行う（Issue #153。以前は in-place だったため PR #161 で呼び出し側にシャローコピーを入れていた）。
// Blind 時（mergeReferencesWithStatus）は自分の票と llm: の票しか結果に含めない。

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus } from './types';
import { isLogicallyDeleted } from './duplicate-detect';
import { buildMyFulltextDecisionMap, buildAllFulltextDecisionsMap, detectConflict } from './decision-aggregate';

/**
 * 文献一覧に判定状態をマージ（キーオープン前）
 *
 * 【論理削除された行（重複）をここで除外する】isLogicallyDeleted() が true の行
 * （duplicate_of 非空）を戻り値から取り除く（Issue #145 チャンク2）。この関数の呼び出し元は
 * TiAb スクリーニング・エクスポート・ML/LLM判定対象取得など複数箇所にまたがるが、判断ロジックを
 * 各呼び出し元へ分散させず、共通のこの一箇所で外すことで全呼び出し元に一度に効かせる
 * （同じ判断のコピーが呼び出し元ごとに散ると、片方だけ直して漏れる事故につながるため）。
 * 除外なしで全件（論理削除済みの行も含む）が必要な場合は getReferences() を使うこと
 * （重複レビューUIの resolveSurvivor() / isPairAlreadySettled() が判定に論理削除済みの
 * 行を必要とするため。Issue #147 外部レビュー指摘。個別の統合判断を取り消す一般的なUIは
 * 実装されていない）。
 */
export function mergeReferencesWithStatus(
    allReferences: Reference[],
    decisionsData: { decision: Decision; rowIndex: number }[],
    reviewerEmail: string
): ReferenceWithStatus[] {
    const references = allReferences.filter((ref) => !isLogicallyDeleted(ref)).map(ref => {
        const refId = (ref.ref_id || '').trim();
        return refId && refId !== ref.ref_id ? { ...ref, ref_id: refId } : ref;
    });

    console.log('[mergeReferencesWithStatus] References:', references.length, 'Decisions:', decisionsData.length);

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // 自分の判定をマップ化
    const myDecisions = new Map<string, Decision>();
    // Blind ONでもAI Evidenceハイライトに必要なLLM判定だけ保持する
    const llmDecisionsMap = new Map<string, Decision[]>();
    tiabDecisionsData.forEach(({ decision }) => {
        // console.log('[mergeReferencesWithStatus] Decision reviewer_id:', decision.reviewer_id);
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        const normalizedReviewerId = reviewerId || normalizedReviewerEmail || decision.reviewer_id;
        if (refId !== decision.ref_id || normalizedReviewerId !== decision.reviewer_id) {
            decision = { ...decision, ref_id: refId, reviewer_id: normalizedReviewerId };
        }
        if (decision.reviewer_id === normalizedReviewerEmail) {
            myDecisions.set(decision.ref_id, decision);
        }
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!llmDecisionsMap.has(decision.ref_id)) {
                llmDecisionsMap.set(decision.ref_id, []);
            }
            llmDecisionsMap.get(decision.ref_id)!.push(decision);
        }
    });

    console.log('[mergeReferencesWithStatus] My decisions count:', myDecisions.size);

    return references.map(ref => {
        const myDecision = myDecisions.get(ref.ref_id);
        // decision='pending' の場合も未判定として扱う
        const status: DecisionStatus = (myDecision && myDecision.decision !== 'pending') ? myDecision.decision : 'pending';
        const llmDecisions = llmDecisionsMap.get(ref.ref_id) || [];
        return {
            ...ref,
            myDecision,
            status,
            allDecisions: llmDecisions,
            llmBatchIds: llmDecisions.map(d => d.reviewer_id),
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
        };
    });
}

/**
 * 文献一覧に全判定状態をマージ（キーオープン後）
 *
 * 論理削除された行（重複）をここでも除外する。理由は getReferencesWithStatus() の JSDoc を参照
 * （Issue #145 チャンク2）。除外しないと、盲検中は消えていた重複がキー開封の瞬間に復活して見える。
 */
export function mergeReferencesWithAllDecisions(
    allReferences: Reference[],
    decisionsData: { decision: Decision; rowIndex: number }[],
    reviewerEmail: string,
    activeBatchIds: Set<string>,
    fulltextAiActiveRound: string | null
): ReferenceWithStatus[] {
    const references = allReferences.filter((ref) => !isLogicallyDeleted(ref)).map(ref => {
        const refId = (ref.ref_id || '').trim();
        return refId && refId !== ref.ref_id ? { ...ref, ref_id: refId } : ref;
    });

    console.log('[mergeReferencesWithAllDecisions] References:', references.length, 'Decisions:', decisionsData.length);

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // デバッグ: ref_idのサンプルを表示
    if (decisionsData.length > 0) {
        console.log('[mergeReferencesWithAllDecisions] Sample decision ref_ids:', decisionsData.slice(0, 3).map(d => d.decision.ref_id));
    }
    if (references.length > 0) {
        console.log('[mergeReferencesWithAllDecisions] Sample reference ref_ids:', references.slice(0, 3).map(r => r.ref_id));
    }

    // 有効な LLM 判定 = active Run 配下の Batch IDs に含まれる reviewer_id のもの
    // Run/Batch 分離後、active 状態は LLM_Runs.is_active が正となる
    const validLlmExecutionIds = activeBatchIds;

    // 全レビュアー（+採用ラウンドのAI）のフルテキスト判定マップ（結果集計用）
    const allFulltextDecisionsMap = buildAllFulltextDecisionsMap(decisionsData, fulltextAiActiveRound);

    console.log('[mergeReferencesWithAllDecisions] activeBatchIds:', Array.from(validLlmExecutionIds));

    // 全判定をref_id別にグループ化（有効なLLM判定のみを含める）
    const allDecisionsMap = new Map<string, Decision[]>();
    // バッチ対象を Run 単位で決めるため、status/active を問わず
    // 「どの LLM バッチがこの文献を判定したか」を別途記録する
    const llmBatchIdsByRefId = new Map<string, string[]>();
    let skippedLlm = 0;
    let addedDecisions = 0;
    let addedHuman = 0;
    let addedLlm = 0;
    tiabDecisionsData.forEach(({ decision }) => {
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        const reviewerIdRaw = (decision.reviewer_id || '').trim();
        const reviewerId = reviewerIdRaw || normalizedReviewerEmail;
        const normalizedReviewerId = reviewerId || normalizedReviewerEmail || decision.reviewer_id;
        if (refId !== decision.ref_id || normalizedReviewerId !== decision.reviewer_id) {
            decision = { ...decision, ref_id: refId, reviewer_id: normalizedReviewerId };
        }

        if (decision.reviewer_id.startsWith('llm:')) {
            const ids = llmBatchIdsByRefId.get(decision.ref_id) ?? [];
            ids.push(decision.reviewer_id);
            llmBatchIdsByRefId.set(decision.ref_id, ids);
        }

        // LLMの判定かつ、有効な実行IDに含まれていない場合はスキップ
        if (decision.reviewer_id.startsWith('llm:') && !validLlmExecutionIds.has(decision.reviewer_id)) {
            skippedLlm++;
            return;
        }

        if (!allDecisionsMap.has(decision.ref_id)) {
            allDecisionsMap.set(decision.ref_id, []);
        }
        allDecisionsMap.get(decision.ref_id)!.push(decision);
        addedDecisions++;

        // デバッグ: reviewer_idの種類ごとにカウント
        if (decision.reviewer_id.startsWith('llm:')) {
            addedLlm++;
        } else {
            addedHuman++;
        }
    });

    console.log('[mergeReferencesWithAllDecisions] allDecisionsMap size:', allDecisionsMap.size, 'addedDecisions:', addedDecisions, 'skippedLlm:', skippedLlm);
    console.log('[mergeReferencesWithAllDecisions] addedHuman:', addedHuman, 'addedLlm:', addedLlm);

    // デバッグ: ref_idのマッチング状況
    const refIdsInDecisions = new Set(Array.from(allDecisionsMap.keys()));
    const refIdsInReferences = new Set(references.map(r => r.ref_id));
    const matchedRefIds = [...refIdsInDecisions].filter(id => refIdsInReferences.has(id));
    const unmatchedDecisionRefIds = [...refIdsInDecisions].filter(id => !refIdsInReferences.has(id));
    console.log('[mergeReferencesWithAllDecisions] ref_id matching: matched=', matchedRefIds.length, 'unmatched decisions=', unmatchedDecisionRefIds.length);
    if (unmatchedDecisionRefIds.length > 0) {
        console.log('[mergeReferencesWithAllDecisions] Sample unmatched decision ref_ids:', unmatchedDecisionRefIds.slice(0, 3));
    }

    return references.map(ref => {
        const allDecisions = allDecisionsMap.get(ref.ref_id) || [];
        const myDecision = normalizedReviewerEmail
            ? allDecisions.find(d => d.reviewer_id === normalizedReviewerEmail)
            : undefined;

        // 不一致検出
        const hasConflict = detectConflict(allDecisions);

        // ステータス決定
        let status: DecisionStatus;
        if (hasConflict) {
            status = 'conflict';
        } else if (myDecision && myDecision.decision !== 'pending') {
            // decision='pending' の場合も未判定として扱う
            status = myDecision.decision;
        } else {
            status = 'pending';
        }

        return {
            ...ref,
            myDecision,
            status,
            allDecisions,
            hasConflict,
            llmBatchIds: llmBatchIdsByRefId.get(ref.ref_id) ?? [],
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
            allFulltextDecisions: allFulltextDecisionsMap.get(ref.ref_id) || [],
        };
    });
}


