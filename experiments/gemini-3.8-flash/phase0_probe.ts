/**
 * Phase 0 プローブ: gemini-3.8-flash のフル実行に入る前に、plan.md の P0-1〜P0-6 を
 * 各1リクエストずつ実測して潰しておく（gemini-3.7-flash の E2 事故 — thinking_level=MINIMAL
 * の非対応に気づかず smoke n=50 を無駄にし、無効な数値を出した — の再発防止）。
 *
 * 拡張機能本体の src/lib/gemini-api.ts は経由せず、このファイル内で fetch を直接使う
 * （生の HTTP ステータスコードとエラー本文が必要なため）。呼び出すエンドポイントは
 * 拡張機能本体と同じ streamGenerateContent（models.list のみ例外）。
 *
 * *** このスクリプトは「書くだけ」で実行しない ***（API 呼び出しは課金が発生するため、
 * 実行はコマンダー側の判断で行う）。
 *
 * 使い方（実行する場合）:
 *   npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
 *     experiments/gemini-3.8-flash/phase0_probe.ts
 *
 * 出力: 結果表をコンソールに日本語で出し、results/phase0_<タイムスタンプ>.json に保存する。
 * URL・APIキーは一切出力・保存しない（redact() で除去してから保存する）。
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';

const MODEL = 'gemini-3.8-flash';
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 30000;

// ============================================================
// 型定義
// ============================================================

interface ModelsListEntry {
    name: string; // "models/gemini-3.8-flash"
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
}

interface ModelsListResponse {
    models?: ModelsListEntry[];
    nextPageToken?: string;
}

interface ProbeResult {
    id: string;
    label: string;
    ok: boolean;
    summary: string;
    detail?: unknown;
}

// ============================================================
// ユーティリティ
// ============================================================

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function generateTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 文字列から APIキー・URL・クエリパラメータの key= を除去する。
 * エラーメッセージや保存前の JSON 化対象すべてにこれを通してから使うこと。
 */
function redact(text: string, apiKey: string): string {
    let out = text;
    if (apiKey) {
        out = out.split(apiKey).join('[REDACTED_KEY]');
    }
    // "?key=..." / "&key=..." クエリパラメータをまるごと除去（万一 URL がそのまま
    // 例外メッセージに含まれていた場合の保険）
    out = out.replace(/[?&]key=[^&\s"']+/g, '[REDACTED_KEY_PARAM]');
    // https://generativelanguage.googleapis.com/... 形式の URL 自体も出さない
    out = out.replace(/https:\/\/generativelanguage\.googleapis\.com\S*/g, '[REDACTED_URL]');
    return out;
}

/**
 * 任意の値を再帰的に redact する（保存前の最終防御）。
 */
function redactDeep<T>(value: T, apiKey: string): T {
    if (typeof value === 'string') {
        return redact(value, apiKey) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map(v => redactDeep(v, apiKey)) as unknown as T;
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = redactDeep(v, apiKey);
        }
        return out as unknown as T;
    }
    return value;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

/** streamGenerateContent のレスポンス本文（JSON配列文字列）をパースする最小実装 */
function parseStreamBody(text: string): any[] {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
        throw new Error('レスポンスが配列形式ではありません');
    }
    return parsed;
}

function extractUsageMetadata(chunks: any[]): Record<string, unknown> | undefined {
    const last = chunks[chunks.length - 1];
    return last?.usageMetadata;
}

function extractFullText(chunks: any[]): string {
    let text = '';
    for (const chunk of chunks) {
        const parts = chunk?.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
            if (part.thought === true) continue;
            if (part.text) text += part.text;
        }
    }
    return text;
}

/**
 * 全チャンクから finishReason を抽出する（src/lib/gemini-api.ts の callGeminiApiWithParts と
 * 同じロジック: 最後の非空値を採用）。includeThoughts: true にした結果、思考トークンが
 * maxOutputTokens を食って本文の前に MAX_TOKENS で打ち切られることがあるため、
 * 「非対応（HTTPエラー等）」と「単なる切り詰め」を区別するために使う。
 */
function extractFinishReason(chunks: any[]): string | undefined {
    return chunks
        .map(c => c?.candidates?.[0]?.finishReason)
        .filter((r): r is string => Boolean(r))
        .pop();
}

function buildStreamUrl(model: string, apiKey: string): string {
    return `${API_ROOT}/models/${model}:streamGenerateContent?key=${apiKey}`;
}

// ============================================================
// 各プローブ
// ============================================================

/** P0-1 + P0-2: models.list に gemini-3.8-flash が存在するか、上限トークン数はいくつか */
async function probeModelsList(apiKey: string): Promise<{ result1: ProbeResult; result2: ProbeResult; entry?: ModelsListEntry }> {
    const url = `${API_ROOT}/models?key=${apiKey}&pageSize=1000`;
    try {
        const response = await fetchWithTimeout(url, { method: 'GET' }, REQUEST_TIMEOUT_MS);
        const bodyText = await response.text();
        if (!response.ok) {
            const msg = `HTTP ${response.status}: ${redact(bodyText, apiKey).slice(0, 300)}`;
            return {
                result1: { id: 'P0-1', label: 'models.list に gemini-3.8-flash が存在するか', ok: false, summary: msg },
                result2: { id: 'P0-2', label: '入力/出力トークン上限', ok: false, summary: 'P0-1 が失敗したため未取得' },
            };
        }
        const data = JSON.parse(bodyText) as ModelsListResponse;
        const entry = (data.models || []).find(m => m.name === `models/${MODEL}` || m.name === MODEL);
        if (!entry) {
            return {
                result1: {
                    id: 'P0-1',
                    label: 'models.list に gemini-3.8-flash が存在するか',
                    ok: false,
                    summary: `見つからない（先頭ページ ${data.models?.length ?? 0} 件中。nextPageToken=${data.nextPageToken ? 'あり（未追跡）' : 'なし'}）`,
                },
                result2: { id: 'P0-2', label: '入力/出力トークン上限', ok: false, summary: 'P0-1 が失敗したため未取得' },
            };
        }
        const methods = entry.supportedGenerationMethods || [];
        return {
            result1: {
                id: 'P0-1',
                label: 'models.list に gemini-3.8-flash が存在するか',
                ok: true,
                summary: `存在する。対応メソッド: ${methods.join(', ') || '(不明)'}`,
                detail: { supportedGenerationMethods: methods },
            },
            result2: {
                id: 'P0-2',
                label: '入力/出力トークン上限',
                ok: entry.inputTokenLimit !== undefined && entry.outputTokenLimit !== undefined,
                summary: `inputTokenLimit=${entry.inputTokenLimit ?? '不明'}, outputTokenLimit=${entry.outputTokenLimit ?? '不明'}（公称 1,048,576 / 65,536）`,
            },
            entry,
        };
    } catch (e) {
        const msg = redact((e as Error).message, apiKey);
        return {
            result1: { id: 'P0-1', label: 'models.list に gemini-3.8-flash が存在するか', ok: false, summary: `例外: ${msg}` },
            result2: { id: 'P0-2', label: '入力/出力トークン上限', ok: false, summary: 'P0-1 が失敗したため未取得' },
        };
    }
}

/** P0-3: thinking_level: low / medium で最小リクエストを投げ、HTTP ステータスを記録する */
async function probeThinkingLevel(apiKey: string, thinkingLevel: 'low' | 'medium'): Promise<ProbeResult> {
    const url = buildStreamUrl(MODEL, apiKey);
    const body = {
        contents: [{ parts: [{ text: 'Reply with a single word: OK.' }] }],
        generationConfig: {
            // includeThoughts: true にしたため思考トークンも出力枠を消費する。gemini-3.7-flash の
            // 実績（config.json E1: thinking LOW でも maxOutputTokens=8192）を踏まえ、最小プローブでも
            // 本文が出る前に切り詰められない余裕を持たせる。
            maxOutputTokens: thinkingLevel === 'low' ? 2048 : 4096,
            // includeThoughts は拡張機能本体 (src/lib/gemini-api.ts の callGeminiApiWithParts)
            // が常に true を送る構成に合わせる。P0-5 が「本番と同じ構成で thoughtsTokenCount が
            // 取れるか」を確認する目的のため、ここだけ false にすると確認にならない。
            thinkingConfig: { thinkingLevel, includeThoughts: true },
        },
    };
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, REQUEST_TIMEOUT_MS);
        const bodyText = await response.text();
        if (!response.ok) {
            return {
                id: 'P0-3',
                label: `thinking_level=${thinkingLevel} で HTTP 200`,
                ok: false,
                summary: `HTTP ${response.status}: ${redact(bodyText, apiKey).slice(0, 300)}`,
            };
        }
        return {
            id: 'P0-3',
            label: `thinking_level=${thinkingLevel} で HTTP 200`,
            ok: true,
            summary: `HTTP ${response.status}`,
        };
    } catch (e) {
        return {
            id: 'P0-3',
            label: `thinking_level=${thinkingLevel} で HTTP 200`,
            ok: false,
            summary: `例外: ${redact((e as Error).message, apiKey)}`,
        };
    }
}

/** P0-4: temperature / topP を送った場合の HTTP ステータスとエラー本文を記録する */
async function probeWithSamplingParams(apiKey: string): Promise<ProbeResult> {
    const url = buildStreamUrl(MODEL, apiKey);
    const body = {
        contents: [{ parts: [{ text: 'Reply with a single word: OK.' }] }],
        generationConfig: {
            temperature: 1.0,
            topP: 0.95,
            maxOutputTokens: 2048,
            // includeThoughts: true は本番構成（src/lib/gemini-api.ts）に合わせている
            thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
    };
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, REQUEST_TIMEOUT_MS);
        const bodyText = await response.text();
        return {
            id: 'P0-4',
            label: 'temperature / topP を送った場合のステータス',
            ok: true, // このプローブは「記録のみ」が目的。200/400 いずれも成功として扱う
            summary: `HTTP ${response.status}${response.ok ? '' : `: ${redact(bodyText, apiKey).slice(0, 300)}`}`,
        };
    } catch (e) {
        return {
            id: 'P0-4',
            label: 'temperature / topP を送った場合のステータス',
            ok: false,
            summary: `例外: ${redact((e as Error).message, apiKey)}`,
        };
    }
}

/** P0-5: temperature / topP を送らない場合の HTTP 200 と usageMetadata（thoughtsTokenCount）を記録する */
async function probeWithoutSamplingParams(apiKey: string): Promise<ProbeResult> {
    const url = buildStreamUrl(MODEL, apiKey);
    const body = {
        contents: [{ parts: [{ text: 'Reply with a single word: OK.' }] }],
        generationConfig: {
            // includeThoughts: true にしたため思考トークンも出力枠を消費する（コメントは
            // probeThinkingLevel 参照）。usageMetadata の取得確認が目的で切り詰めさせたくないため
            // 十分な余裕を持たせる。
            maxOutputTokens: 2048,
            // includeThoughts: true は本番構成（src/lib/gemini-api.ts）に合わせている
            thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
    };
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, REQUEST_TIMEOUT_MS);
        const bodyText = await response.text();
        if (!response.ok) {
            return {
                id: 'P0-5',
                label: 'temperature / topP なしで HTTP 200 + usageMetadata',
                ok: false,
                summary: `HTTP ${response.status}: ${redact(bodyText, apiKey).slice(0, 300)}`,
            };
        }
        const chunks = parseStreamBody(bodyText);
        const usage = extractUsageMetadata(chunks);
        const finishReason = extractFinishReason(chunks);
        const hasThoughtsTokenCount = usage && typeof usage.thoughtsTokenCount === 'number';
        return {
            id: 'P0-5',
            label: 'temperature / topP なしで HTTP 200 + usageMetadata',
            ok: Boolean(usage) && hasThoughtsTokenCount,
            summary: `HTTP ${response.status}, finishReason=${finishReason ?? '不明'}, usageMetadata=${usage ? JSON.stringify(usage) : '取得できず'}`,
            detail: usage,
        };
    } catch (e) {
        return {
            id: 'P0-5',
            label: 'temperature / topP なしで HTTP 200 + usageMetadata',
            ok: false,
            summary: `例外: ${redact((e as Error).message, apiKey)}`,
        };
    }
}

/** P0-6: responseMimeType: application/json + responseSchema が従来通り機能するか */
async function probeResponseSchema(apiKey: string): Promise<ProbeResult> {
    const url = buildStreamUrl(MODEL, apiKey);
    const schema = {
        type: 'object',
        properties: {
            include_probability: { type: 'number' },
            reasons: { type: 'array', items: { type: 'string' } },
        },
        required: ['include_probability', 'reasons'],
    };
    const body = {
        contents: [{
            parts: [{
                text: 'Evaluate whether the sentence "The sky is blue." is about color. '
                    + 'Return include_probability (0 to 1) and reasons (short string array).',
            }],
        }],
        generationConfig: {
            // includeThoughts: true にしたため思考トークンも出力枠を消費する（コメントは
            // probeThinkingLevel 参照）。JSON 本文が出る前に切り詰められると「responseSchema が
            // 機能しない」という誤った NG になるため、他プローブより大きめに確保する。
            maxOutputTokens: 4096,
            // includeThoughts: true は本番構成（src/lib/gemini-api.ts）に合わせている
            thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
            responseMimeType: 'application/json',
            responseSchema: schema,
        },
    };
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, REQUEST_TIMEOUT_MS);
        const bodyText = await response.text();
        if (!response.ok) {
            return {
                id: 'P0-6',
                label: 'responseSchema 付きで従来通り JSON を返すか',
                ok: false,
                summary: `HTTP ${response.status}: ${redact(bodyText, apiKey).slice(0, 300)}`,
            };
        }
        const chunks = parseStreamBody(bodyText);
        const finishReason = extractFinishReason(chunks);
        // 切り詰め（MAX_TOKENS）と「responseSchema が機能しない」という本当の非対応を区別する。
        // 切り詰めの場合は JSON パースが失敗して当然なので、パース結果を見る前にここで返す。
        if (finishReason === 'MAX_TOKENS') {
            return {
                id: 'P0-6',
                label: 'responseSchema 付きで従来通り JSON を返すか',
                ok: false,
                summary: '切り詰めのため判定不能（finishReason=MAX_TOKENS。maxOutputTokens を上げて再実行すること。responseSchema 非対応の証拠ではない）',
            };
        }
        const fullText = extractFullText(chunks);
        try {
            const parsed = JSON.parse(fullText);
            const valid = typeof parsed.include_probability === 'number' && Array.isArray(parsed.reasons);
            return {
                id: 'P0-6',
                label: 'responseSchema 付きで従来通り JSON を返すか',
                ok: valid,
                summary: (valid ? 'JSON スキーマ通りにパース成功' : `パースはできたがスキーマ不一致: ${JSON.stringify(parsed).slice(0, 200)}`) + ` (finishReason=${finishReason ?? '不明'})`,
            };
        } catch {
            return {
                id: 'P0-6',
                label: 'responseSchema 付きで従来通り JSON を返すか',
                ok: false,
                summary: `JSON パース失敗（finishReason=${finishReason ?? '不明'}, 本文冒頭）: ${fullText.slice(0, 200)}`,
            };
        }
    } catch (e) {
        return {
            id: 'P0-6',
            label: 'responseSchema 付きで従来通り JSON を返すか',
            ok: false,
            summary: `例外: ${redact((e as Error).message, apiKey)}`,
        };
    }
}

// ============================================================
// メイン
// ============================================================

async function main(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('GEMINI_API_KEY が未設定です（.env を確認してください）。Phase 0 プローブを中止します。');
        process.exit(1);
    }

    console.log('=== Phase 0 プローブ: gemini-3.8-flash 疎通確認 ===');
    console.log('*** この実行は Gemini API を呼び出すため課金が発生する（6件程度、コストはほぼゼロ想定） ***\n');

    const results: ProbeResult[] = [];

    console.log('P0-1/P0-2: models.list を確認中...');
    const { result1, result2 } = await probeModelsList(apiKey);
    results.push(result1, result2);

    console.log('P0-3 (low): thinking_level=low を確認中...');
    results.push(await probeThinkingLevel(apiKey, 'low'));

    console.log('P0-3 (medium): thinking_level=medium を確認中...');
    results.push(await probeThinkingLevel(apiKey, 'medium'));

    console.log('P0-4: temperature / topP を付けた場合を確認中...');
    results.push(await probeWithSamplingParams(apiKey));

    console.log('P0-5: temperature / topP を付けない場合を確認中...');
    results.push(await probeWithoutSamplingParams(apiKey));

    console.log('P0-6: responseSchema 付きの呼び出しを確認中...');
    results.push(await probeResponseSchema(apiKey));

    console.log('\n=== Phase 0 結果 ===');
    for (const r of results) {
        console.log(`[${r.ok ? 'OK' : 'NG'}] ${r.id}: ${r.label}`);
        console.log(`      ${r.summary}`);
    }

    const resultsDir = path.join(__dirname, 'results');
    ensureDir(resultsDir);
    const timestamp = generateTimestamp();
    const outPath = path.join(resultsDir, `phase0_${timestamp}.json`);
    // 保存前に念のため再度 redact を通す（各プローブ内で summary/detail は redact 済みだが、
    // 予期しない箇所にキーが混入する事故を防ぐための最終防御）
    const safeResults = redactDeep(results, apiKey);
    fs.writeFileSync(outPath, JSON.stringify({ timestamp, model: MODEL, results: safeResults }, null, 2));
    console.log(`\n結果を保存しました: ${outPath}`);
    console.log('この結果を config.json の phase0Findings と report.md に転記すること。');
}

main().catch((e) => {
    // fetch 系の例外（や cause）には `?key=...` 付き URL が乗る経路があるため、
    // 各プローブ内と同じく redact() を通してから出力する（AGENTS.md CRITICAL PROTOCOLS 9）。
    // ここは main() の外（トップレベル catch）なので apiKey を改めて読み直す。
    const apiKey = process.env.GEMINI_API_KEY || '';
    console.error('Phase 0 プローブが失敗しました:', redact((e as Error).message, apiKey));
    process.exit(1);
});
