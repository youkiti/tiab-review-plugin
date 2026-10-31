import type { LlmProviderId, KeyProviderId } from '../../../lib/llm-provider';
import { t } from '../../../lib/i18n';

export const keyProviders: KeyProviderId[] = ['gemini', 'openrouter', 'openai', 'anthropic', 'typesafe'];
export const providers: LlmProviderId[] = [...keyProviders, 'local_llm'];

export const providerNames: Record<LlmProviderId, string> = {
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    typesafe: 'TypeSafe',
    get local_llm() { return t('llmExt_localName'); },
};

export const providerCaptionKeys: Record<LlmProviderId, string> = {
    gemini: 'llm_providerCaptionGemini',
    openrouter: 'llm_providerCaptionOpenRouter',
    openai: 'llm_providerCaptionOpenAi',
    anthropic: 'llm_providerCaptionAnthropic',
    typesafe: 'llm_providerCaptionTypeSafe',
    local_llm: 'llmExt_localCaption',
};

