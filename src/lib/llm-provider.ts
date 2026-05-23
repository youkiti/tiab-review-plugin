// llm-provider.ts - LLM プロバイダ抽象化
//
// Gemini / OpenRouter を共通インタフェースで呼び分ける薄いディスパッチ層。
// llm-processor.ts はこのレイヤだけを叩き、プロバイダ実装の詳細を知らない。

import type { LlmScreeningOutput, LlmCriteria, UsageMetadata, LlmModelResponseMetadata } from './types';

export type LlmProviderId = 'gemini' | 'openrouter';

/**
 * プロバイダ非依存のスクリーニング入力
 * （Gemini の thinkingLevel と OpenRouter の reasoningEffort はそれぞれ対応プロバイダのみで参照される）
 */
export interface LlmScreenParams {
    title: string;
    abstract: string;
    screeningPrompt: string;
    model: string;
    temperature: number;
    topP?: number;
    thinkingLevel?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
    outputLanguage: string;
}

export interface LlmScreenResult {
    output: LlmScreeningOutput;
    usageMetadata: UsageMetadata;
    responseMetadata: LlmModelResponseMetadata;
}

/**
 * モデル ID から所属プロバイダを判定する。
 * AVAILABLE_MODELS に登録されていれば `provider` フィールドを優先し、
 * 未登録ならスラッシュを含む ID（`qwen/...`, `deepseek/...` 等の OpenRouter 形式）を
 * openrouter として扱い、それ以外を gemini にフォールバックする。
 *
 * 循環依存を避けるため、モデル一覧は引数で受け取る形にしてある。
 */
export function resolveProviderId(
    modelId: string,
    models: ReadonlyArray<{ id: string; provider?: LlmProviderId }>
): LlmProviderId {
    const found = models.find(m => m.id === modelId);
    if (found?.provider) return found.provider;
    if (modelId.includes('/')) return 'openrouter';
    return 'gemini';
}

/**
 * API キー設定済みプロバイダのモデルだけを抽出する純関数。
 * UI 層 (populateModelSelect) のフィルタロジックをここに切り出すことで
 * DOM ・ chrome.storage に依存せずテスト可能にしている。
 */
export function filterModelsByConfiguredProviders<T extends { provider: LlmProviderId }>(
    models: ReadonlyArray<T>,
    configured: ReadonlySet<LlmProviderId>
): T[] {
    return models.filter(m => configured.has(m.provider));
}

/**
 * 基準最適化（criteria 変換）の共通パラメータ
 */
export interface ConvertCriteriaParams {
    protocolText: string;
    model: string;
    temperature: number;
    topP?: number;
    thinkingLevel?: string;                          // Gemini 専用
    reasoningEffort?: 'low' | 'medium' | 'high';     // OpenRouter 専用
    maxOutputTokens?: number;
    outputLanguage: string;
}

export interface ConvertCriteriaResult {
    criteria: LlmCriteria;
    screening_prompt: string;
}

export interface ConvertCriteriaOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

/**
 * 基準最適化のディスパッチ
 *
 * Gemini は responseSchema による JSON 強制、OpenRouter はプロンプト指示 + フォールバックパース。
 * 失敗時は両者ともリトライ後にエラーを投げる（呼び出し側でユーザーへ再試行可能）。
 */
export async function convertCriteriaWithProvider(
    providerId: LlmProviderId,
    params: ConvertCriteriaParams,
    options?: ConvertCriteriaOptions
): Promise<ConvertCriteriaResult> {
    if (providerId === 'openrouter') {
        const { convertCriteriaViaOpenRouter } = await import('./providers/openrouter');
        return convertCriteriaViaOpenRouter(params, options);
    }
    const { convertCriteria } = await import('./gemini-api');
    return convertCriteria(
        params.protocolText,
        {
            model: params.model,
            temperature: params.temperature,
            topP: params.topP,
            thinkingLevel: params.thinkingLevel,
            maxOutputTokens: params.maxOutputTokens,
        },
        params.outputLanguage,
        options
    );
}

/**
 * スクリーニング呼び出しのディスパッチ
 *
 * Gemini / OpenRouter の実装モジュールを動的 import することで、
 * Sidepanel ビルドサイズや循環依存を最小化する。
 */
export async function screenWithProvider(
    providerId: LlmProviderId,
    params: LlmScreenParams
): Promise<LlmScreenResult> {
    if (providerId === 'openrouter') {
        const { screenViaOpenRouter } = await import('./providers/openrouter');
        return screenViaOpenRouter(params);
    }
    // Gemini はデフォルト
    const { screenReference } = await import('./gemini-api');
    return screenReference(
        params.title,
        params.abstract,
        params.screeningPrompt,
        {
            model: params.model,
            temperature: params.temperature,
            topP: params.topP,
            thinkingLevel: params.thinkingLevel,
            maxOutputTokens: params.maxOutputTokens,
        },
        params.outputLanguage
    );
}
