// 相談専用の固定モデルと、登録済みキーから使う社を決める規則。
import { resolveProviderId } from '../llm-provider';
import type { LlmProviderId } from '../llm-provider';
import { AVAILABLE_MODELS } from '../gemini-api';

export const CONSULT_MODELS = {
    gemini: 'gemini-3.1-flash-lite',
    openai: 'gpt-5.6-luna',
    anthropic: 'claude-haiku-5-5',
    openrouter: 'deepseek/deepseek-v4-flash',
} as const;
export type ConsultProviderId = keyof typeof CONSULT_MODELS;
const PRIORITY: readonly ConsultProviderId[] = ['gemini', 'openai', 'anthropic', 'openrouter'];

export function chooseConsultProvider(
    configuredProviders: ReadonlySet<LlmProviderId>, currentModelId?: string | null
): ConsultProviderId | null {
    if (currentModelId) {
        const current = resolveProviderId(currentModelId, AVAILABLE_MODELS);
        if (PRIORITY.includes(current as ConsultProviderId) && configuredProviders.has(current)) {
            return current as ConsultProviderId;
        }
    }
    return PRIORITY.find(provider => configuredProviders.has(provider)) ?? null;
}
