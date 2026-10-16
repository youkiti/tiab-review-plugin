import { AVAILABLE_MODELS } from './gemini-api';
import type { OpenRouterModel } from './openrouter-models';

/** 米ドル / 100万トークンの有料枠単価。 */
export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

// 2026-10-16 に公式料金表で確認した単価。Gemini はテキスト入力の有料枠。
const BUILT_IN_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
    // 出典: https://ai.google.dev/gemini-api/docs/pricing
    ['gemini-3.1-flash-lite', { inputPerMillion: 0.25, outputPerMillion: 1.50 }],
    ['gemini-3-flash-preview', { inputPerMillion: 0.50, outputPerMillion: 3.00 }],
    // 出典: https://platform.claude.com/docs/en/about-claude/pricing
    // Haiku は入力10万トークン以下（題名・抄録の判定）の単価。
    ['claude-sonnet-5-5', { inputPerMillion: 2, outputPerMillion: 10 }],
    ['claude-haiku-5-5', { inputPerMillion: 0.10, outputPerMillion: 0.50 }],
    // 出典: https://developers.openai.com/api/docs/pricing （先頭の表の入力 / 出力）
    ['gpt-5.6-terra', { inputPerMillion: 2, outputPerMillion: 12 }],
    ['gpt-5.6-luna', { inputPerMillion: 0.2, outputPerMillion: 1.2 }],
]);

/** 組み込み単価を優先し、なければ保存済みの公開一覧から解決する。 */
export function resolveModelPricing(
    modelId: string,
    fetchedModels: readonly OpenRouterModel[],
): ModelPricing | null {
    const builtIn = BUILT_IN_PRICING.get(modelId);
    if (builtIn) {
        return { ...builtIn };
    }
    const model = fetchedModels.find(candidate => candidate.id === modelId);
    if (model?.inputPerMillion === undefined || model.outputPerMillion === undefined) {
        return null;
    }
    return { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion };
}

/** 見積もりに必要な題名・抄録だけを受け取る。 */
export interface PricingReference {
    title: string;
    abstract?: string;
}

/** 文字数を4で割り、スキーマ・指示文などの固定部分として400を加える。 */
export function estimateInputTokens(prompt: string, ref: PricingReference): number {
    // experiments/gpt-5.6/report.md: depression 1,993件の入力1,900,027（約953/件）。
    // experiments/gemini-3.7-flash/report.md: 979,459 / 1,993 = 491.4/件。
    // experiments/gemini-prompt-cache/report.md も後者を参照している。
    // プロバイダごとに固定部分が異なるため幅があり、文字数からの概算として扱う。
    return Math.ceil((prompt.length + ref.title.length + (ref.abstract ?? '').length) / 4) + 400;
}

/** 思考しない組み込み設定は160、それ以外は思考分を含めて600とする。 */
export function estimateOutputTokens(modelId: string): number {
    // experiments/gpt-5.6/report.md: completion は none 305,905（約153/件）、low 441,587（約222/件）。
    // experiments/gemini-3.5-flash/report.md: LOW は約400思考トークン/件。
    // 取得一覧・カスタムなど思考量が不明なモデルは、費用を少なく見せないよう多めに見積もる。
    const model = AVAILABLE_MODELS.find(candidate => candidate.id === modelId);
    if (model && model.config.thinkingLevel === undefined && model.config.reasoningEffort === undefined) {
        return 160;
    }
    return 600;
}

/** 文献ごとの入力と、思考を含む出力の米ドル概算を合計する。 */
export function estimateBatchCost(
    refs: readonly PricingReference[],
    prompt: string,
    modelId: string,
    pricing: ModelPricing | null,
): number | null {
    if (pricing === null) {
        return null;
    }
    const inputTokens = refs.reduce((total, ref) => total + estimateInputTokens(prompt, ref), 0);
    return inputTokens * pricing.inputPerMillion / 1e6
        + refs.length * estimateOutputTokens(modelId) * pricing.outputPerMillion / 1e6;
}
