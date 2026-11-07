// 小節選択と本文に基づく回答を一回ずつ呼び、失敗を該当なしと区別する。
import { askWithProvider } from '../llm-provider';
import type { LlmProviderId } from '../llm-provider';
import { CONSULT_MODELS } from './model';
import type { ConsultProviderId } from './model';
import { buildAnswerPrompt, buildSelectionPrompt, validateSelectedIds } from './prompt';
import type { ConsultFailureKind, ConsultResult, HelpLanguage, HelpSection } from './types';

export function classifyConsultError(error: unknown, signal?: AbortSignal): ConsultFailureKind {
    const err = error as { kind?: ConsultFailureKind; code?: string; status?: number; name?: string; message?: string } | null;
    const known: ConsultFailureKind[] = ['no_key', 'unsupported_provider', 'rate_limited', 'auth', 'timeout',
        'aborted', 'network', 'invalid_response', 'unknown'];
    if (err?.kind && known.includes(err.kind)) {
        return err.kind;
    }
    if (signal?.aborted && err?.name === 'AbortError') {
        return 'aborted';
    }
    const message = err?.message ?? '';
    const status = err?.status ?? Number(/API error (\d{3})/.exec(message)?.[1]);
    if (status === 429 || /rate_limit/i.test(message)) {
        return 'rate_limited';
    }
    if (status === 401 || status === 403) {
        return 'auth';
    }
    if (err?.code === 'api_key_missing' || /API_KEY が設定されていません/.test(message)) {
        return 'no_key';
    }
    if (error instanceof SyntaxError || /空のレスポンス|JSON パース|応答が不完全|応答を拒否/.test(message)) {
        return 'invalid_response';
    }
    if (error instanceof TypeError || /fetch failed|network|Failed to fetch/i.test(message)) {
        return 'network';
    }
    return 'unknown';
}

export async function consultHelp(params: {
    question: string; lang: HelpLanguage; sections: readonly HelpSection[]; providerId: LlmProviderId | null; signal?: AbortSignal;
}): Promise<ConsultResult> {
    const { question, lang, sections, providerId, signal } = params;
    if (!providerId) {
        return { status: 'failure', kind: 'no_key' };
    }
    if (!(providerId in CONSULT_MODELS)) {
        return { status: 'failure', kind: 'unsupported_provider' };
    }
    try {
        const common = { model: CONSULT_MODELS[providerId as ConsultProviderId], maxOutputTokens: 2048, signal };
        const selected = validateSelectedIds(await askWithProvider(providerId, {
            ...common, ...buildSelectionPrompt(sections, question),
        }), sections);
        if (selected.status === 'failure') {
            return selected;
        }
        if (selected.sectionIds.length === 0) {
            return { status: 'no_match' };
        }
        const picked = selected.sectionIds.map(id => sections.find(section => section.id === id)!);
        const answer = await askWithProvider(providerId, { ...common, prompt: buildAnswerPrompt(picked, question, lang) });
        return { status: 'success', sectionIds: selected.sectionIds, answer };
    } catch (error) {
        return { status: 'failure', kind: classifyConsultError(error, signal) };
    }
}
