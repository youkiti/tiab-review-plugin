// ai-evidence-empty-reason.ts - 全文閲覧ウィンドウでAI evidence が0件になる理由の判定（純関数）
//
// 背景（2026-08 実事故）: フルテキストAI判定を一度も実行していないプロジェクトで、
// 全文閲覧ウィンドウのハイライト欄が
// 「AI判定の採用ラウンドが未設定です（Config タブ fulltext_ai_active_round）」だけを表示していた。
// 実際の原因は「フルテキストAI判定がまだ1件も無い」ことで、Config を直せば解決するかのような
// 誤誘導になっていた（しかもそのキーはUIから編集できない）。さらに TiAb のAIラウンドと
// フルテキストのAIラウンドは別枠なのに、「AI判定なら2つある」と混同する原因にもなった。
// この関数は0件の理由を切り分け、UI側が理由に応じた文言と導線を出せるようにする。
//
// ブラインディング上の制約:
//   表示レベル 'none'（AI evidence 非表示の実験条件）では、理由で文言を出し分けると
//   「この文献にAI判定があるか」が推測できてしまう。'none' のときは常に 'blinded' を返し、
//   UI側は他状態と同じ既定文言に固定すること。
// DOM/i18n には依存しない（描画は src/fulltext/fulltext.ts が担う）。

/** ブラインド中のAI evidence 表示レベル（Config の fulltext_evidence_display 相当） */
export type AiEvidenceLevel = 'none' | 'neutral' | 'full';

export type AiEvidenceEmptyReason =
    | 'blinded'                // 表示レベル none: 状態を漏らさないため既定文言に固定する
    | 'no_round'               // フルテキストAI判定が1件も存在しない（＝まだ実行していない）
    | 'round_not_adopted'      // ラウンドは存在するが、採用ラウンドが選ばれていない
    | 'adopted_round_missing'  // 採用ラウンドの判定が1件も見つからない（削除済み等の不整合）
    | 'no_evidence';           // 採用ラウンドはあるが、この文献には根拠が無い

/**
 * AI evidence（ハイライト・根拠カード）が0件になった理由を判定する
 *
 * 優先順位:
 *   ① evidenceLevel === 'none' → 'blinded'（他の状態より必ず優先。上記の制約参照）
 *   ② フルテキストAI判定が1件も無い → 'no_round'
 *   ③ 採用ラウンド未設定 → 'round_not_adopted'
 *   ④ 採用ラウンドの判定が1件も無い → 'adopted_round_missing'
 *   ⑤ それ以外 → 'no_evidence'（この文献に根拠が無いだけ）
 *
 * hasAnyFulltextAiDecision / hasAdoptedRoundDecision は「プロジェクト全体で1件でもあるか」で、
 * 表示中の文献に限定しないこと（限定すると ② と ⑤ が区別できない）。
 * なおブラインド中でも LLM 判定はクライアントへ配られる（sheets/decisions.ts の filterDecisionsForBlind）
 * ため、この2つのフラグはブラインド状態に関わらず正しく求められる。
 */
export function explainEmptyAiEvidence(input: {
    evidenceLevel: AiEvidenceLevel;
    /** フルテキストフェーズのAI判定(llm:)がプロジェクトに1件でも存在するか */
    hasAnyFulltextAiDecision: boolean;
    /** 採用ラウンド(activeRound)に属する判定が1件でも存在するか */
    hasAdoptedRoundDecision: boolean;
    /** 採用中のフルテキストAI判定ラウンド（reviewer_id）。未設定は null */
    activeRound: string | null;
}): AiEvidenceEmptyReason {
    const { evidenceLevel, hasAnyFulltextAiDecision, hasAdoptedRoundDecision, activeRound } = input;

    if (evidenceLevel === 'none') return 'blinded';
    if (!hasAnyFulltextAiDecision) return 'no_round';
    if (!activeRound) return 'round_not_adopted';
    if (!hasAdoptedRoundDecision) return 'adopted_round_missing';
    return 'no_evidence';
}
