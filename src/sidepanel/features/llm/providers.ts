import type { LlmProviderId } from '../../../lib/llm-provider';

export const providers: LlmProviderId[] = ['gemini', 'openrouter', 'openai', 'anthropic', 'typesafe'];

export const providerNames: Record<LlmProviderId, string> = {
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    typesafe: 'TypeSafe',
};

export const providerCaptionKeys: Record<LlmProviderId, string> = {
    gemini: 'llm_providerCaptionGemini',
    openrouter: 'llm_providerCaptionOpenRouter',
    openai: 'llm_providerCaptionOpenAi',
    anthropic: 'llm_providerCaptionAnthropic',
    typesafe: 'llm_providerCaptionTypeSafe',
};

