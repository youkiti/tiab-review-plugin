// Gemini への自由問い合わせ。初期 JS に入る gemini-api.ts から分け、llm-feature チャンクで読む。
import { getEffectiveApiKey } from '../storage';
import { getModelGenerationConfig } from '../model-generation-settings';
import type { AskParams } from './ask-types';
import { askError, parseAskText, withAskSignal } from './ask-request';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** gemini-api.ts の GEMINI_API_KEY_HEADER と同じ値（初期 JS の gemini-api.ts を import しないため自前で持つ。tests/gemini-api-key-header.test.ts が一致を検査）。 */
export const GEMINI_ASK_API_KEY_HEADER = 'x-goog-api-key';

/** Gemini の問い合わせの POST 送信。 */
async function postGemini(url: string, apiKey: string, body: object, signal: AbortSignal): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [GEMINI_ASK_API_KEY_HEADER]: apiKey },
        body: JSON.stringify(body),
        signal,
    });
}

/** 一問一答の自由問い合わせ。JSON 指定がなければ通常のテキストを要求する。 */
export async function askViaGemini(params: AskParams): Promise<unknown> {
    return withAskSignal(params, async signal => {
        const apiKey = await getEffectiveApiKey();
        if (!apiKey) {
            throw askError('no_key');
        }
        const config = getModelGenerationConfig(params.model);
        const body = {
            contents: [{ parts: [{ text: params.prompt }] }],
            ...(params.systemPrompt ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } } : {}),
            generationConfig: {
                maxOutputTokens: params.maxOutputTokens,
                ...(config.thinkingLevel ? { thinkingConfig: { thinkingLevel: config.thinkingLevel.toLowerCase() } } : {}),
                ...(params.jsonSchema ? { responseMimeType: 'application/json', responseSchema: params.jsonSchema } : {}),
            },
        };
        const response = await postGemini(`${GEMINI_API_BASE}/${params.model}:generateContent`, apiKey, body, signal);
        if (!response.ok) {
            throw Object.assign(new Error(`Gemini API error ${response.status}`), { status: response.status });
        }
        const data = await response.json() as {
            candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        };
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
            throw askError('invalid_response');
        }
        const text = (candidate?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? '').join('');
        return parseAskText(text, params.jsonSchema);
    });
}
