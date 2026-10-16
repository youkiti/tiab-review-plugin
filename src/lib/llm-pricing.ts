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

const OUTPUT_TOKENS_BY_MODEL: ReadonlyMap<string, number> = new Map([
    // experiments/openrouter-bench/report.md: Qwen は completion 401,739 / 1,993件（約202/件、reasoning 0）。
    // experiments/gpt-5.6/report.md: none は305,905 / 1,993件（約153/件）。両実測を上回る220を採る。
    ['gemini-3.1-flash-lite', 220],
    ['qwen/qwen3-235b-a22b-2507', 220],
    // experiments/openrouter-bench/report.md: DeepSeek は completion 1,735,288 / 1,993件（約871/件、reasoning 1,412,316）。
    ['deepseek/deepseek-v4-flash', 900],
    // experiments/gpt-5.6/report.md: low は441,587 / 1,993件（約222/件）。
    // experiments/gemini-3.5-flash/report.md: LOW は思考約400/件。思考を指定するモデルは600と見積もる。
    ['gemini-3-flash-preview', 600],
    ['gpt-5.6-terra', 600],
    ['gpt-5.6-luna', 600],
    ['claude-haiku-5-5', 600],
    ['claude-sonnet-5-5', 600],
]);

/** モデル別の実測を参考に、思考を含む出力トークンを見積もる。 */
export function estimateOutputTokens(modelId: string): number {
    // 表に無いモデルは、上記OpenRouter実測で最大のDeepSeek（約871/件）に合わせて900とする。
    return OUTPUT_TOKENS_BY_MODEL.get(modelId) ?? 900;
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
