#!/usr/bin/env node
/**
 * 採用候補の判定器そのものを検証する。
 *
 * 判定器の形:
 *   POST /v1beta/models/{model}:batchGenerateContent に「requests が空の batch」を送る。
 *   - 無料キー: 課金チェックが body 検証より先に走り 400 FAILED_PRECONDITION
 *   - 有料キー: body 検証に進み 400 INVALID_ARGUMENT ("...non-empty list of inlined requests")
 *   どちらも 400 で終わるため、**バッチジョブは一切生成されない**（後片付け不要・課金ゼロ）。
 *
 * 実行: node experiments/gemini-tier-detection/probe3-detector.mjs
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
function redact(t) {
    let out = typeof t === 'string' ? t : JSON.stringify(t);
    for (const [l, k] of Object.entries(KEYS)) if (k && k.length >= 12) out = out.split(k).join(`<REDACTED_${l.toUpperCase()}_KEY>`);
    return out;
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL = path.join(RESULTS_DIR, `detector_${STAMP}.jsonl`);
const record = e => fs.appendFileSync(JSONL, redact(JSON.stringify({ ts: new Date().toISOString(), ...e })) + '\n');

/**
 * これが拡張機能に実装する想定のロジック（そのまま移植できる形で書く）。
 * 戻り値は3値: 'free' | 'paid' | 'unknown'（+ 鍵不正は 'invalid_key'）
 */
async function detectTier(apiKey, model = 'gemini-flash-lite-latest', timeoutMs = 10000) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE}/models/${model}:batchGenerateContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
            // requests を意図的に空にする → 有料キーでもジョブは作られない
            body: JSON.stringify({ batch: { display_name: 'tier-probe' } }),
            signal: controller.signal,
        });
        const text = await res.text();
        let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        const err = Array.isArray(json) ? json[0]?.error : json?.error;
        const status = err?.status ?? null;
        const message = typeof err?.message === 'string' ? err.message : '';
        const elapsedMs = Date.now() - started;

        if (/API key not valid/i.test(message)) return { tier: 'invalid_key', status, elapsedMs, message: redact(message) };
        if (res.status === 400 && status === 'FAILED_PRECONDITION') return { tier: 'free', status, elapsedMs, message: redact(message) };
        if (res.status === 400 && status === 'INVALID_ARGUMENT' && /inlined requests|input file/i.test(message)) return { tier: 'paid', status, elapsedMs, message: redact(message) };
        // 想定外はすべて unknown。一過性の失敗を free/paid と断定しない
        return { tier: 'unknown', status, elapsedMs, message: redact(message) || `HTTP ${res.status}` };
    } catch (e) {
        return { tier: 'unknown', status: null, elapsedMs: Date.now() - started, message: redact(String(e?.message ?? e)) };
    } finally {
        clearTimeout(timer);
    }
}

const REPEATS = 5;
console.log('=== 判定器の再現性（各5回）===');
const table = [];
for (const [label, key] of Object.entries(KEYS)) {
    const got = [];
    const times = [];
    for (let i = 0; i < REPEATS; i++) {
        const r = await detectTier(key);
        record({ test: 'detector', subject: label, iteration: i, ...r });
        got.push(r.tier);
        times.push(r.elapsedMs);
        await new Promise(s => setTimeout(s, 300));
    }
    const uniq = [...new Set(got)];
    const expected = label;
    const pass = uniq.length === 1 && uniq[0] === expected;
    table.push({ subject: label, got: got.join(','), expected, pass, medianMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)] });
    console.log(`${label.padEnd(4)} → ${got.join(' ')}  期待=${expected}  ${pass ? '✓' : '✗'}  中央値 ${times[Math.floor(times.length / 2)]}ms`);
}

console.log('\n=== 異常系（free/paid と誤断定しないこと）===');
for (const [name, key] of [['不正キー', 'AIzaSyINVALIDINVALIDINVALIDINVALID1234'], ['空文字キー', '']]) {
    const r = await detectTier(key);
    record({ test: 'detector_negative', name, ...r });
    console.log(`${name.padEnd(10)} → ${r.tier.padEnd(12)} (${r.status ?? '-'}) ${r.message.slice(0, 60)}`);
}

// 別モデルでも同じ判定になるか
console.log('\n=== モデル非依存の確認 ===');
for (const model of ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']) {
    const f = await detectTier(KEYS.free, model);
    const p = await detectTier(KEYS.paid, model);
    record({ test: 'detector_models', model, free: f.tier, paid: p.tier, freeStatus: f.status, paidStatus: p.status });
    console.log(`${model.padEnd(24)} free→${f.tier.padEnd(8)} paid→${p.tier.padEnd(8)} ${f.tier === 'free' && p.tier === 'paid' ? '✓' : '✗ (' + (f.message || p.message).slice(0, 50) + ')'}`);
}

console.log(`\n生ログ: ${path.relative(REPO_ROOT, JSONL)}`);
console.log(`合格判定: ${table.every(r => r.pass) ? '✓ 全ケース一致' : '✗ 不一致あり'}`);
