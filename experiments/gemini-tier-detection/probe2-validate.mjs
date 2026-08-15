#!/usr/bin/env node
/**
 * P4 (batches.create) を判定器として採用してよいかの検証。
 *
 * 検証したいのは3点:
 *  V1 再現性  : 同じキー・同じモデルで毎回同じ結果か（各3回）
 *  V2 モデル非依存: モデルを変えても成立するか
 *  V3 特異性  : FAILED_PRECONDITION が「無料枠」以外の原因（不正キー・存在しないモデル・
 *               壊れたリクエスト）でも出るなら、判定器として使えない
 *
 * 実行: node experiments/gemini-tier-detection/probe2-validate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RESULTS_DIR = path.join(HERE, 'results');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function loadEnv() {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return env;
}
const env = loadEnv();
const KEYS = { free: env.GEMINI_API_FREE_KEY, paid: env.GEMINI_API_KEY };

function redact(text) {
    let out = typeof text === 'string' ? text : JSON.stringify(text);
    for (const [label, key] of Object.entries(KEYS)) {
        if (key && key.length >= 12) out = out.split(key).join(`<REDACTED_${label.toUpperCase()}_KEY>`);
    }
    return out;
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL = path.join(RESULTS_DIR, `validate_${STAMP}.jsonl`);
function record(entry) {
    fs.appendFileSync(JSONL, redact(JSON.stringify({ ts: new Date().toISOString(), ...entry })) + '\n');
}

async function call(method, urlPath, { key, body } = {}) {
    const started = Date.now();
    try {
        const res = await fetch(`${BASE}${urlPath}`, {
            method,
            headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        const err = Array.isArray(json) ? json[0]?.error : json?.error;
        return {
            status: res.status,
            errorStatus: err?.status ?? null,
            message: err?.message ? redact(String(err.message)).split('\n')[0] : null,
            operationName: json?.name ?? null,
            elapsedMs: Date.now() - started,
            transportError: null,
        };
    } catch (e) {
        return { status: null, errorStatus: null, message: null, operationName: null, elapsedMs: Date.now() - started, transportError: redact(String(e?.message ?? e)) };
    }
}

function minimalBatch(displayName = 'tier-probe') {
    return {
        batch: {
            display_name: displayName,
            input_config: {
                requests: {
                    requests: [{
                        request: { contents: [{ parts: [{ text: 'hi' }], role: 'user' }], generationConfig: { maxOutputTokens: 1 } },
                        metadata: { key: 'probe-1' },
                    }],
                },
            },
        },
    };
}

/** batches.create を1回。作成できたら必ず cancel → delete */
async function tryBatch(label, key, model, body = minimalBatch()) {
    const r = await call('POST', `/models/${model}:batchGenerateContent`, { key, body });
    let cleanup = null;
    if (r.operationName) {
        const c = await call('POST', `/${r.operationName}:cancel`, { key, body: {} });
        const d = await call('DELETE', `/${r.operationName}`, { key });
        cleanup = { cancel: c.status, delete: d.status };
    }
    record({ test: label, model, status: r.status, errorStatus: r.errorStatus, message: r.message, created: Boolean(r.operationName), cleanup, elapsedMs: r.elapsedMs, transportError: r.transportError });
    return { ...r, cleanup };
}

const MODELS = ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const REPEATS = 3;
const rows = [];

// ---- V1 + V2: 再現性 × モデル非依存
console.log('=== V1/V2 再現性 × モデル ===');
for (const [label, key] of Object.entries(KEYS)) {
    for (const model of MODELS) {
        const results = [];
        for (let i = 0; i < REPEATS; i++) {
            const r = await tryBatch(`V1V2_${label}`, key, model);
            results.push(`${r.status}/${r.errorStatus ?? 'OK'}`);
            await new Promise(s => setTimeout(s, 400));
        }
        const uniq = [...new Set(results)];
        rows.push({ key: label, model, results: results.join(' '), deterministic: uniq.length === 1 });
        console.log(`${label.padEnd(4)} ${model.padEnd(26)} ${results.join('  ')}  ${uniq.length === 1 ? '✓一致' : '✗ばらつき'}`);
    }
}

// ---- V3: 特異性（FAILED_PRECONDITION が無料枠以外でも出るか）
console.log('\n=== V3 特異性（紛らわしい失敗との区別）===');
const specificity = [];
async function spec(name, fn) {
    const r = await fn();
    specificity.push({ name, status: r.status, errorStatus: r.errorStatus, message: r.message });
    record({ test: 'V3_specificity', name, status: r.status, errorStatus: r.errorStatus, message: r.message });
    console.log(`${name.padEnd(42)} HTTP ${String(r.status).padEnd(4)} ${r.errorStatus ?? 'OK'}  ${r.message ?? ''}`);
    return r;
}

await spec('不正なAPIキー + 正しいbatch', () => tryBatch('V3_badkey', 'AIzaSyINVALIDINVALIDINVALIDINVALID1234', MODELS[0]));
await spec('存在しないモデル (paid)', () => tryBatch('V3_badmodel_paid', KEYS.paid, 'gemini-does-not-exist-9'));
await spec('存在しないモデル (free)', () => tryBatch('V3_badmodel_free', KEYS.free, 'gemini-does-not-exist-9'));
await spec('壊れたbody (paid)', () => tryBatch('V3_badbody_paid', KEYS.paid, MODELS[0], { batch: { display_name: 'x' } }));
await spec('壊れたbody (free)', () => tryBatch('V3_badbody_free', KEYS.free, MODELS[0], { batch: { display_name: 'x' } }));
await spec('通常のgenerateContent (free)', () => call('POST', `/models/${MODELS[0]}:generateContent`, { key: KEYS.free, body: { contents: [{ parts: [{ text: 'hi' }], role: 'user' }], generationConfig: { maxOutputTokens: 1 } } }));
await spec('cachedContents.create 最小 (free)', () => call('POST', '/cachedContents', { key: KEYS.free, body: { model: `models/${MODELS[0]}`, contents: [{ parts: [{ text: 'hi' }], role: 'user' }], ttl: '60s' } }));
await spec('cachedContents.create 最小 (paid)', () => call('POST', '/cachedContents', { key: KEYS.paid, body: { model: `models/${MODELS[0]}`, contents: [{ parts: [{ text: 'hi' }], role: 'user' }], ttl: '60s' } }));

console.log(`\n生ログ: ${path.relative(REPO_ROOT, JSONL)}`);
