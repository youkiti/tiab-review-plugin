// 通信や画面に依存しない、モデルごとの送信設定の正本。
export interface ModelGenerationSettings {
    provider: 'gemini' | 'openrouter' | 'openai' | 'anthropic' | 'typesafe';
    temperature?: number;
    topP?: number;
    thinkingLevel?: string;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
}

export const MODEL_GENERATION_SETTINGS: Record<string, ModelGenerationSettings> = {
    'gemini-3.1-flash-lite': { provider: 'gemini', temperature: 0 },
    'gemini-3-flash-preview': { provider: 'gemini', temperature: 1, topP: 0.95, thinkingLevel: 'LOW' },
    'qwen/qwen3-235b-a22b-2507': { provider: 'openrouter', temperature: 0 },
    'deepseek/deepseek-v4-flash': { provider: 'openrouter', temperature: 0 },
    'gpt-5.6-terra': { provider: 'openai', reasoningEffort: 'low' },
    'gpt-5.6-luna': { provider: 'openai', reasoningEffort: 'low' },
    'claude-haiku-5-5': { provider: 'anthropic', reasoningEffort: 'low' },
    'claude-sonnet-5-5': { provider: 'anthropic', reasoningEffort: 'low' },
    'jev-1.14.0': { provider: 'typesafe' },
    'typesafe/jev-1.14': { provider: 'openrouter', temperature: 0 },
};

export function getModelGenerationSettings(model: string): ModelGenerationSettings {
    return MODEL_GENERATION_SETTINGS[model] ?? { provider: 'openrouter', temperature: 0 };
}

export function getModelGenerationConfig(model: string) {
    const { provider: _provider, ...config } = getModelGenerationSettings(model);
    return { temperature: 0, ...config };
}

/** Anthropic の上限は本文と思考の合計で送る。 */
export function anthropicMaxOutputTokens(requested?: number): number {
    return Math.min((requested ?? 16000) + 4000, 64000);
}

/** 未送信のフィールドを履歴に残さない。 */
export function sentGenerationSettings(model: string, config: Omit<ModelGenerationSettings, 'provider'>) {
    const { provider } = getModelGenerationSettings(model);
    const typeSafe = provider === 'typesafe' || model.startsWith('typesafe/') || model.startsWith('~typesafe/');
    const sampling = !typeSafe && (provider === 'gemini' || provider === 'openrouter');
    return {
        temperature: sampling ? config.temperature : undefined,
        topP: sampling ? config.topP : undefined,
        thinkingLevel: provider === 'gemini' ? config.thinkingLevel : undefined,
        reasoning_effort: provider === 'anthropic'
            ? config.reasoningEffort === 'none' ? 'low' : config.reasoningEffort ?? 'low'
            : provider === 'openai' ? config.reasoningEffort ?? 'low'
            : provider === 'openrouter' && !typeSafe ? config.reasoningEffort : undefined,
        max_output_tokens: typeSafe ? undefined : provider === 'anthropic'
            ? anthropicMaxOutputTokens(config.maxOutputTokens) : config.maxOutputTokens,
    };
}
