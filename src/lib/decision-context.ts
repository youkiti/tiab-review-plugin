// decision-context.ts - human判定の保存時に、判定の瞬間にAIの情報へどれだけ暴露されていたかを
// 記録するための純粋関数群。
//
// Decisions タブの context_json 列（末尾追記。AGENTS.md「Decisions タブ」参照）に保存する
// JSON文字列を組み立てる。将来「人間の判定はAIから独立していたか」を遡って検証するための、
// 書くだけ・読み手（既存のUI・集計）の挙動は一切変えない列。
//
// decision-summary.ts と同じ方針: `../sidepanel/state` / DOM には依存しない（テストのため）。
// 呼び出し側（actions.ts / fulltext.ts）が state・DOM から値を集めて引数として渡すこと。

/** AI evidence の表示レベル（フルテキスト画面。sheets-api.ts の FulltextEvidenceDisplay と同じ値） */
export type DecisionContextAiEvidenceLevel = 'none' | 'neutral' | 'full';

/**
 * Decisions.context_json に保存するスキーマ（v1）。
 * - key_opened: 判定時点でBlindキーが開封されていたか
 * - ai_highlights: TiAb画面のAI Evidenceハイライト表示がONだったか（TiAbのみ）
 * - ai_evidence_level: フルテキスト画面のAI evidence実効表示レベル（フルテキストのみ）
 * - ai_votes_at_decision: 判定時点でこの文献に付いていたAI票（採用中のもの）の件数
 * 将来 v2 で項目を追加する場合も、v1 の意味は変えないこと（過去行の解釈が変わってしまうため）。
 */
export interface DecisionContextV1 {
    v: 1;
    key_opened: boolean;
    ai_highlights?: boolean;
    ai_evidence_level?: DecisionContextAiEvidenceLevel;
    ai_votes_at_decision?: number;
}

/** buildDecisionContext() の入力。DecisionContextV1 のうち省略可能な項目は undefined を渡してよい。 */
export interface BuildDecisionContextInput {
    keyOpened: boolean;
    aiHighlights?: boolean;
    aiEvidenceLevel?: DecisionContextAiEvidenceLevel;
    aiVotesAtDecision?: number;
}

/**
 * 判定保存時の context_json 列に入れるJSON文字列を組み立てる。
 * undefined のフィールドは出力JSONに含めない（JSON.stringify の既定挙動どおり）。
 */
export function buildDecisionContext(input: BuildDecisionContextInput): string {
    const context: DecisionContextV1 = {
        v: 1,
        key_opened: input.keyOpened,
        ai_highlights: input.aiHighlights,
        ai_evidence_level: input.aiEvidenceLevel,
        ai_votes_at_decision: input.aiVotesAtDecision,
    };
    return JSON.stringify(context);
}
