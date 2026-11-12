// Gemini Decisions API のモデル判定と、新しい Run の閾値を管理する。
export const GEMINI_DECISION_INCLUDE_THRESHOLD = 0.15;

export function isGeminiDecisionModel(modelId: string): boolean {
    return modelId === 'gemini-decision-1';
}

export function newRunIncludeThreshold(modelId: string, configured?: number): number {
    return isGeminiDecisionModel(modelId) ? GEMINI_DECISION_INCLUDE_THRESHOLD : configured ?? 0.3;
}

/** フルテキスト対応は Issue #348 に委ね、生成モデルだけを選ぶ。 */
export function filterFulltextGeminiModels<T extends { id: string; provider: string }>(models: readonly T[]): T[] {
    return models.filter(model => model.provider === 'gemini' && !isGeminiDecisionModel(model.id));
}
