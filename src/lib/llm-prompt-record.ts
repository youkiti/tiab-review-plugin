// 送信用の組み立て関数をそのまま使い、文献だけを置換記号にした雛形を保存する。
import { buildGeminiScreeningPrompt } from './gemini-api';
import { buildPrompt } from './providers/openrouter';
import { buildScreeningPrompt } from './providers/structured-prompts';
import { buildTypeSafeScreeningRequest } from './providers/typesafe';
import { getModelGenerationSettings } from './model-generation-settings';
import { PROMPT_VERSION } from './prompt-templates';
import type { LlmCriteria } from './types';
import { isOpenRouterJevModel } from './openrouter-model';

export function buildTiabPromptTemplate(model: string, screeningPrompt: string, outputLanguage: string, criteria?: LlmCriteria | null): string {
    const { provider } = getModelGenerationSettings(model);
    const title = '{{TITLE}}';
    const abstract = '{{ABSTRACT}}';
    if (provider === 'typesafe' || (provider === 'openrouter' && isOpenRouterJevModel(model))) {
        return JSON.stringify(buildTypeSafeScreeningRequest({ model, title, abstract, screeningPrompt, outputLanguage, criteria }).body);
    }
    if (provider === 'gemini') {
        return buildGeminiScreeningPrompt(title, abstract, screeningPrompt, outputLanguage);
    }
    if (provider === 'openrouter') {
        return buildPrompt(title, abstract, screeningPrompt, outputLanguage);
    }
    return buildScreeningPrompt(title, abstract, screeningPrompt, outputLanguage);
}

export async function recordPromptTemplate(template: string, version = PROMPT_VERSION) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(template));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    return {
        prompt_version: version,
        prompt_sha256: hash,
        full_prompt_template: template.length > 45_000 ? template.slice(0, 45_000) + '…[truncated]' : template,
    };
}
