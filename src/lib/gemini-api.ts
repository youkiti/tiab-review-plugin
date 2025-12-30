// gemini-api.ts - Gemini API クライアント

import type { LlmScreeningOutput, LlmCriteria } from './types';
import { getEffectiveApiKey } from './storage';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini APIモデル設定
 */
export interface GeminiModelConfig {
    model: string;
    temperature: number;
    maxOutputTokens: number;
}

/**
 * デフォルト設定
 */
export const DEFAULT_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-2.5-flash-lite',
    temperature: 0,
    maxOutputTokens: 2048,
};

/**
 * スクリーニング出力のJSONスキーマ
 */
const SCREENING_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        include_probability: {
            type: 'number',
            description: 'タイトル・抄録レベルで最終的に組み入れになり得る確率（0-1）',
        },
        reasons: {
            type: 'array',
            items: { type: 'string' },
            description: 'この確率になった理由（短文の配列）',
        },
        evidence: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: ['title', 'abstract'],
                        description: '抜粋元フィールド',
                    },
                    quote: {
                        type: 'string',
                        description: '原文からの正確な抜粋',
                    },
                    start_char: {
                        type: 'integer',
                        description: 'field内テキストの0始まり開始位置',
                    },
                    end_char: {
                        type: 'integer',
                        description: 'field内テキストの終了位置（排他的）',
                    },
                },
                required: ['field', 'quote', 'start_char', 'end_char'],
            },
            description: 'ハイライト用の根拠',
        },
    },
    required: ['include_probability', 'reasons', 'evidence'],
};

/**
 * 基準変換出力のJSONスキーマ
 */
const CRITERIA_CONVERSION_SCHEMA = {
    type: 'object',
    properties: {
        criteria: {
            type: 'object',
            properties: {
                template: {
                    type: 'string',
                    enum: ['pico', 'peco', 'spider', 'custom'],
                    description: '使用するテンプレート形式',
                },
                fields: {
                    type: 'object',
                    description: 'テンプレートに応じたフィールド（P, I, C, O など）',
                    properties: {
                        P: { type: 'string', description: '対象患者/集団' },
                        I: { type: 'string', description: '介入' },
                        E: { type: 'string', description: '曝露' },
                        C: { type: 'string', description: '比較対照' },
                        O: { type: 'string', description: 'アウトカム' },
                        S: { type: 'string', description: '研究デザイン/セッティング' },
                    },
                },
            },
            required: ['template', 'fields'],
        },
        screening_prompt: {
            type: 'string',
            description: 'スクリーニング用のプロンプトテンプレート',
        },
    },
    required: ['criteria', 'screening_prompt'],
};

/**
 * Gemini APIを呼び出す
 */
async function callGeminiApi<T>(
    prompt: string,
    responseSchema: object,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG
): Promise<T> {
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        throw new Error('Gemini APIキーが設定されていません');
    }

    const url = `${GEMINI_API_BASE}/${config.model}:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [
            {
                parts: [{ text: prompt }],
            },
        ],
        generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || response.statusText;
        throw new Error(`Gemini API エラー: ${errorMessage}`);
    }

    const data = await response.json();

    // レスポンスからテキストを抽出
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini APIからの応答が空です');
    }

    // JSONをパース
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        console.error('Failed to parse Gemini response:', text);
        throw new Error('Gemini APIの応答をパースできませんでした');
    }
}

/**
 * 文献をスクリーニング
 */
export async function screenReference(
    title: string,
    abstract: string,
    screeningPrompt: string,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    outputLanguage: string = 'ja'
): Promise<LlmScreeningOutput> {
    const prompt = `${screeningPrompt}

## 対象文献

**タイトル:**
${title}

**抄録:**
${abstract || '(抄録なし)'}

## 出力指示
- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力
- reasons: 判断理由を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で短文配列で出力
- evidence: タイトルまたは抄録から判断根拠となる部分を正確に抜粋（quote）し、その開始位置（start_char）と終了位置（end_char）を指定

注意: quoteはtitleまたはabstract内の正確な部分文字列でなければなりません。`;

    return await callGeminiApi<LlmScreeningOutput>(
        prompt,
        SCREENING_OUTPUT_SCHEMA,
        config
    );
}

/**
 * プロトコルの基準を最適化（PICO形式等に変換）
 */
export async function convertCriteria(
    protocolText: string,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    outputLanguage: string = 'ja'
): Promise<{ criteria: LlmCriteria; screening_prompt: string }> {
    const prompt = `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
${protocolText}

## 出力指示

1. **criteria**: PICO/PECO形式で構造化
   - template: "pico"（または適切な形式）
   - fields: 各要素を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で簡潔に記述
     - P: 対象患者/集団
     - I: 介入（または E: 曝露）
     - C: 比較対照
     - O: アウトカム
     - 必要に応じて「研究デザイン」等の追加フィールド

2. **screening_prompt**: スクリーニング用のプロンプトテンプレート
   - タイトル・抄録から組み入れ/除外を判断するための詳細な指示
   - 各PICO要素をどのようにチェックするかの具体的なガイダンス
   - ${outputLanguage === 'ja' ? '日本語' : outputLanguage}で記述

注意:
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;

    return await callGeminiApi<{ criteria: LlmCriteria; screening_prompt: string }>(
        prompt,
        CRITERIA_CONVERSION_SCHEMA,
        config
    );
}

/**
 * APIキーの有効性をテスト
 */
export async function testApiKey(apiKey: string): Promise<boolean> {
    const url = `${GEMINI_API_BASE}/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [
            {
                parts: [{ text: 'Hello' }],
            },
        ],
        generationConfig: {
            maxOutputTokens: 10,
        },
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        return response.ok;
    } catch {
        return false;
    }
}

/**
 * 利用可能なモデル一覧
 */
export const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite (推奨)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview (原則使わない)' },
];
