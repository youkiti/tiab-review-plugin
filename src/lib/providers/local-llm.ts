// スクリーニングの再試行は呼び出し側に任せ、形式非対応時だけ送信形式を切り替える。
import type { LlmScreeningOutput, LlmCriteria } from '../types';
import { getLocalLlmEndpoint } from '../storage';
import { normalizeLocalLlmEndpoint, deriveLocalLlmModelsUrl, stripLocalModelPrefix } from '../local-llm-model';
import { SCREENING_OUTPUT_SCHEMA, CRITERIA_CONVERSION_SCHEMA, normalizeCriteriaConversionResult } from '../gemini-api';
import { buildScreeningPrompt, buildCriteriaPrompt } from './structured-prompts';

interface LocalParams {
    model: string;
    outputLanguage: string;
}

interface ScreenParams extends LocalParams {
    title: string;
    abstract: string;
    screeningPrompt: string;
}

interface CriteriaParams extends LocalParams {
    protocolText: string;
}

interface CriteriaOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

interface CriteriaResult {
    criteria: LlmCriteria;
    screening_prompt: string;
}

interface ChatResponse {
    id?: string;
    model?: string;
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
    };
}

type OutputMode = 'strict' | 'schema' | 'object';
const MODES: OutputMode[] = ['strict', 'schema', 'object'];
const endpointModes = new Map<string, OutputMode>();

interface SchemaNode {
    type?: string | string[];
    properties?: Record<string, SchemaNode>;
    required?: string[];
    items?: SchemaNode;
    additionalProperties?: boolean;
}

function strictSchema(schema: object): object {
    const clone = JSON.parse(JSON.stringify(schema)) as SchemaNode;
    function visit(node: SchemaNode): void {
        if (node.type === 'object' && node.properties) {
            const required = new Set(node.required ?? []);
            for (const [key, child] of Object.entries(node.properties)) {
                if (!required.has(key) && typeof child.type === 'string') {
                    child.type = [child.type, 'null'];
                }
            }
            node.required = Object.keys(node.properties);
            node.additionalProperties = false;
        }
        for (const child of Object.values(node.properties ?? {})) {
            visit(child);
        }
        if (node.items) {
            visit(node.items);
        }
    }
    visit(clone);
    return clone;
}

async function localFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' });
        // タイムアウトは本文の読み取りにも適用する。
        const text = await response.text();
        return new Response(text, { status: response.status, headers: response.headers });
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error(`${url} に接続できません。サーバーを起動してください`);
        }
        if (controller.signal.aborted) {
            throw new Error(`${url} からの応答が ${Math.round(timeoutMs / 1000)} 秒以内に返りませんでした。この PC にはモデルが重すぎる可能性があります。小さいモデルを読み込むか、GPU を使う設定を確かめてください`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function httpError(status: number, body: string, url: string): Error {
    const reason = status === 403
        ? 'Ollama の OLLAMA_ORIGINS に chrome-extension://* を許可してください'
        : status === 404 ? 'モデルまたは URL が見つかりません' : body.slice(0, 200);
    return Object.assign(new Error(`ローカル LLM: HTTP ${status} (${url}): ${reason}`), {
        status,
        retryable: ![400, 401, 403, 404].includes(status),
    });
}

async function chat(endpoint: string, model: string, prompt: string, schema: object, timeoutMs: number): Promise<ChatResponse> {
    const url = normalizeLocalLlmEndpoint(endpoint);
    const start = MODES.indexOf(endpointModes.get(url) ?? 'strict');
    for (let index = start; index < MODES.length; index++) {
        const mode = MODES[index];
        const responseFormat = mode === 'object'
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'result', schema: mode === 'strict' ? strictSchema(schema) : schema, ...(mode === 'strict' ? { strict: true } : {}) } };
        const content = mode === 'object' ? `${prompt}\nJSON スキーマに従う JSON だけを返してください:\n${JSON.stringify(schema)}` : prompt;
        const response = await localFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: stripLocalModelPrefix(model),
                messages: [{ role: 'user', content }],
                temperature: 0,
                response_format: responseFormat,
            }),
        }, timeoutMs);
        if (!response.ok) {
            const body = await response.text();
            if ([400, 422].includes(response.status)
                && /response[_ -]?format|schema|strict|structured[_ -]?output/i.test(body)
                && index < MODES.length - 1) {
                endpointModes.set(url, MODES[index + 1]);
                continue;
            }
            throw httpError(response.status, body, url);
        }
        endpointModes.set(url, mode);
        return await response.json() as ChatResponse;
    }
    throw new Error('ローカル LLM の出力形式を設定できません');
}

function parseOutput<T>(data: ChatResponse): T {
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
        throw Object.assign(new Error('ローカル LLM の応答が出力上限で打ち切られました'), {
            code: 'max_tokens_truncated',
            retryable: false,
        });
    }
    const text = (choice?.message?.content ?? '').trim()
        .replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!text) {
        throw new Error('ローカル LLM: 空の応答です');
    }
    return JSON.parse(text) as T;
}

async function savedEndpoint(): Promise<string> {
    const endpoint = await getLocalLlmEndpoint();
    if (!endpoint) {
        throw Object.assign(new Error('ローカル LLM の URL を保存して接続テストしてください'), { retryable: false });
    }
    return endpoint;
}

export async function fetchLocalLlmModels(endpoint: string, timeoutMs = 30000): Promise<string[]> {
    const url = deriveLocalLlmModelsUrl(endpoint);
    const response = await localFetch(url, { method: 'GET' }, timeoutMs);
    if (!response.ok) {
        throw httpError(response.status, await response.text(), url);
    }
    const data = await response.json() as { data?: { id?: unknown }[] };
    return [...new Set((data.data ?? []).map(entry => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !/embed/i.test(id)))];
}

export async function testLocalLlmChat(endpoint: string, model: string, timeoutMs = 180000): Promise<void> {
    const data = await chat(endpoint, model, 'Return {"ok":true}.', {
        type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    }, timeoutMs);
    const result = parseOutput<{ ok?: boolean }>(data);
    if (result.ok !== true) {
        throw new Error('ローカル LLM の接続テストで期待した JSON が返りませんでした');
    }
}

export async function screenViaLocalLlm(params: ScreenParams, timeoutMs = 300000) {
    const prompt = buildScreeningPrompt(params.title, params.abstract, params.screeningPrompt, params.outputLanguage);
    const data = await chat(await savedEndpoint(), params.model, prompt, SCREENING_OUTPUT_SCHEMA, timeoutMs);
    const promptTokenCount = data.usage?.prompt_tokens ?? 0;
    const candidatesTokenCount = data.usage?.completion_tokens ?? 0;
    return {
        output: parseOutput<LlmScreeningOutput>(data),
        usageMetadata: {
            promptTokenCount,
            candidatesTokenCount,
            thoughtsTokenCount: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
            totalTokenCount: data.usage?.total_tokens ?? promptTokenCount + candidatesTokenCount,
        },
        responseMetadata: { modelVersion: data.model || stripLocalModelPrefix(params.model), responseId: data.id },
    };
}

export async function convertCriteriaViaLocalLlm(params: CriteriaParams, options: CriteriaOptions = {}, timeoutMs = 600000): Promise<CriteriaResult> {
    const prompt = buildCriteriaPrompt(params.protocolText, params.outputLanguage);
    const maxRetries = options.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const data = await chat(await savedEndpoint(), params.model, prompt, CRITERIA_CONVERSION_SCHEMA, timeoutMs);
            const parsed = parseOutput<CriteriaResult>(data);
            const fields: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed.criteria.fields)) {
                if (typeof value === 'string') {
                    fields[key] = value;
                }
            }
            return normalizeCriteriaConversionResult({ ...parsed, criteria: { ...parsed.criteria, fields } });
        } catch (error) {
            lastError = error;
            if ((error as { retryable?: boolean })?.retryable === false || attempt >= maxRetries) {
                break;
            }
            const delay = (options.retryDelayMs ?? 5000) * Math.pow(2, attempt);
            options.onRetry?.(attempt + 1, maxRetries, delay);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
