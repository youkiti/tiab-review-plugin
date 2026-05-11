// llm-config-hash.ts - LLM 実行設定の正規化ハッシュ
//
// 同一設定で起動された複数バッチを Run として集約するための識別子を生成する。
// include_threshold は Run の更新可能属性のためハッシュ対象外。
// 改行コードのみ LF に統一し、空白やインデントは保持する（プロンプトの意味が変わるため）。

import type { LlmCriteria } from './types';

/**
 * config_hash の対象となる設定（Run の境界を決める要素のみ）
 */
export interface LlmHashableConfig {
    model: string;
    temperature?: number;
    topP?: number;
    thinkingLevel?: string;
    criteria_snapshot: LlmCriteria | null;
    screening_prompt: string;
}

const HASH_VERSION = 'v1';

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

/**
 * 改行コードを LF に統一する。空白・インデント・末尾空白は保持する。
 */
function normalizeNewlines(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 値を正規化してハッシュ可能な JSON 形式に変換する。
 * - undefined は除外（オブジェクトのキー自体を消す）
 * - null はそのまま null
 * - 文字列は改行コード正規化のみ
 * - 数値・真偽値はそのまま
 * - 配列は要素を再帰的に正規化
 * - オブジェクトはキーをソートして再帰的に正規化
 */
function canonicalize(value: unknown): Json | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === 'string') return normalizeNewlines(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return value;
    }
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.map(item => canonicalize(item) ?? null);
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const result: { [k: string]: Json } = {};
        const keys = Object.keys(obj).sort();
        for (const key of keys) {
            const normalized = canonicalize(obj[key]);
            if (normalized !== undefined) {
                result[key] = normalized;
            }
        }
        return result;
    }
    return undefined;
}

/**
 * オブジェクトを正規化された JSON 文字列に変換する。
 * - キーは再帰的にソート
 * - undefined フィールドは除外
 * - 改行は LF に統一
 */
export function canonicalJson(value: unknown): string {
    const normalized = canonicalize(value) ?? null;
    return JSON.stringify(normalized);
}

/**
 * SHA-256 を 16進文字列で計算する。
 * ブラウザでは crypto.subtle.digest、Node でも globalThis.crypto.subtle が利用可能。
 */
async function sha256Hex(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('SubtleCrypto is not available in this environment');
    }
    const hashBuffer = await subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * LLM 実行設定から config_hash を計算する。
 *
 * @param config ハッシュ対象の設定（include_threshold は含めない）
 * @returns "v1:sha256hex" 形式のハッシュ文字列
 */
export async function computeConfigHash(config: LlmHashableConfig): Promise<string> {
    const payload: LlmHashableConfig = {
        model: config.model,
        temperature: config.temperature,
        topP: config.topP,
        thinkingLevel: config.thinkingLevel,
        criteria_snapshot: config.criteria_snapshot,
        screening_prompt: config.screening_prompt,
    };
    const canonical = canonicalJson(payload);
    const hex = await sha256Hex(canonical);
    return `${HASH_VERSION}:${hex}`;
}

/**
 * 既存 Batch row が config_hash を計算可能な状態かを判定する。
 * 移行時、criteria_snapshot や screening_prompt が壊れている row は
 * 誤集約を避けるために通常ハッシュに入れず、legacy:<execution_id> として扱う。
 */
export function isHashable(config: Partial<LlmHashableConfig>): boolean {
    if (!config.model || typeof config.model !== 'string') return false;
    if (typeof config.screening_prompt !== 'string' || config.screening_prompt.length === 0) {
        return false;
    }
    // criteria_snapshot は null（テンプレ無し）も許容するが、未設定 (undefined) は不可
    if (config.criteria_snapshot === undefined) return false;
    return true;
}

/**
 * legacy 用の擬似ハッシュ。集約を避けるため execution_id をそのまま埋める。
 */
export function legacyHash(executionId: string): string {
    return `legacy:${executionId}`;
}
