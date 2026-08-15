#!/usr/bin/env node
/**
 * Gemini APIキーの free/paid 判定プローブ（Phase 1 + P4 Batch API）
 *
 * 実行: node experiments/gemini-tier-detection/probe.mjs
 *
 * 安全上の約束（AGENTS.md 9 / グローバル方針「リクエストURLをそのままログに出さない」）:
 *  - APIキーは URL クエリではなく x-goog-api-key ヘッダで送る
 *  - 出力・ログに書く前に必ず redact() を通す
 *  - 1試行ごとに JSONL へ追記する（メモリに溜めない）
 *  - 一過性の失敗を「free と判定」として永続化しない（判定不能は unknown）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RESULTS_DIR = path.join(HERE, 'results');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ---------------------------------------------------------------- .env 読み込み

function loadEnv() {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return env;
}

const env = loadEnv();
const SUBJECTS = [
    { label: 'free', key: env.GEMINI_API_FREE_KEY },
    { label: 'paid', key: env.GEMINI_API_KEY },
].filter(s => {
    if (!s.key) console.warn(`[warn] ${s.label} のキーが .env に無いためスキップ`);
    return Boolean(s.key);
});

/** 出力に混入したAPIキーを伏せる。キーが短い/空でも誤爆しないよう長さで守る */
function redact(text) {
    let out = typeof text === 'string' ? text : JSON.stringify(text);
    if (out === undefined) return out;
    for (const s of SUBJECTS) {
        if (s.key && s.key.length >= 12) {
            out = out.split(s.key).join(`<REDACTED_${s.label.toUpperCase()}_KEY>`);
        }
    }
    return out;
}

// ---------------------------------------------------------------- HTTP

/**
 * リトライは「パース」まで含める（グローバル方針3）。
 * HTTPステータスだけ見るリトライでは、200でボディがエラー文書のケースが素通りする。
 */
async function request(method, urlPath, { key, body, attempts = 3 } = {}) {
    const url = `${BASE}${urlPath}`;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        const started = Date.now();
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    'x-goog-api-key': key,
                    ...(body ? { 'content-type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const text = await res.text(); // ボディ読み込みで落ちる系もここで捕まえる
            let json;
            try {
                json = text ? JSON.parse(text) : undefined;
            } catch {
                json = undefined;
            }
            const headers = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            return {
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                headers,
                json,
                text,
                elapsedMs: Date.now() - started,
                attempt: i,
                transportError: null,
            };
        } catch (e) {
            // 4xx を恒久失敗と決めつけない／一過性の失敗を結論にしない（グローバル方針4,5）
            lastErr = e;
            if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
    return {
        ok: false,
        status: null,
        statusText: null,
        headers: {},
        json: undefined,
        text: null,
        elapsedMs: null,
        attempt: attempts,
        transportError: redact(String(lastErr && lastErr.message ? lastErr.message : lastErr)),
    };
}

// ---------------------------------------------------------------- 記録

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL = path.join(RESULTS_DIR, `probe_${STAMP}.jsonl`);

function record(entry) {
    const safe = JSON.parse(redact(JSON.stringify({ ts: new Date().toISOString(), ...entry })));
    fs.appendFileSync(JSONL, JSON.stringify(safe) + '\n');
    return safe;
}

/** 429 の QuotaFailure から quotaId / FreeTier を抜く（src/lib/gemini-api.ts と同じ考え方） */
function parseQuota(json) {
    const err = Array.isArray(json) ? json[0]?.error : json?.error;
    const details = Array.isArray(err?.details) ? err.details : [];
    const qf = details.find(d => d?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
    const violations = Array.isArray(qf?.violations) ? qf.violations : [];
    const quotaIds = violations.map(v => v?.quotaId).filter(v => typeof v === 'string');
    const quotaMetrics = violations.map(v => v?.quotaMetric).filter(v => typeof v === 'string');
    return {
        errorStatus: err?.status ?? null,
        errorMessage: err?.message ? redact(String(err.message)).split('\n')[0] : null,
        quotaIds,
        quotaMetrics,
        quotaValues: violations.map(v => v?.quotaValue ?? null),
        isFreeTierQuota: quotaIds.some(id => id.includes('FreeTier'))
            || quotaMetrics.some(m => m.includes('free_tier')),
        hasQuotaFailure: Boolean(qf),
    };
}

// ---------------------------------------------------------------- プローブ

/** P1: models.list 全ページ。件数ではなく「集合」と supportedGenerationMethods を見る */
async function probeModels(subject) {
    const models = [];
    let pageToken;
    let pages = 0;
    do {
        const q = `?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await request('GET', `/models${q}`, { key: subject.key });
        record({ probe: 'P1_models_list', subject: subject.label, page: pages, status: res.status, headers: res.headers, transportError: res.transportError });
        if (!res.ok) return { error: res.status ?? res.transportError, models: [], headers: res.headers };
        for (const m of res.json?.models ?? []) models.push(m);
        pageToken = res.json?.nextPageToken;
        pages++;
    } while (pageToken && pages < 10);

    const batchCapable = models
        .filter(m => (m.supportedGenerationMethods ?? []).includes('batchGenerateContent'))
        .map(m => m.name);
    return {
        models,
        names: models.map(m => m.name).sort(),
        batchCapable: batchCapable.sort(),
        methodsByModel: Object.fromEntries(models.map(m => [m.name, (m.supportedGenerationMethods ?? []).slice().sort()])),
    };
}

/** P3: 有料限定の疑いがあるリソースの list（生成しないのでコスト0） */
async function probeLists(subject) {
    const out = {};
    for (const [name, p] of [['batches', '/batches'], ['cachedContents', '/cachedContents'], ['tunedModels', '/tunedModels'], ['files', '/files']]) {
        const res = await request('GET', p, { key: subject.key });
        const quota = parseQuota(res.json);
        out[name] = { status: res.status, errorStatus: quota.errorStatus, errorMessage: quota.errorMessage, quotaIds: quota.quotaIds, isFreeTierQuota: quota.isFreeTierQuota };
        record({ probe: 'P3_list', subject: subject.label, resource: name, ...out[name], headers: res.headers, transportError: res.transportError });
    }
    return out;
}

/** P4 本命: batches.create（最小1件）。作成できたら即 cancel → delete する */
async function probeBatchCreate(subject, model) {
    const body = {
        batch: {
            display_name: 'tier-probe-minimal',
            input_config: {
                requests: {
                    requests: [
                        {
                            request: {
                                contents: [{ parts: [{ text: 'hi' }], role: 'user' }],
                                generationConfig: { maxOutputTokens: 1 },
                            },
                            metadata: { key: 'probe-1' },
                        },
                    ],
                },
            },
        },
    };
    const res = await request('POST', `/models/${model}:batchGenerateContent`, { key: subject.key, body, attempts: 1 });
    const quota = parseQuota(res.json);
    const opName = res.json?.name ?? null;
    const entry = record({
        probe: 'P4_batch_create',
        subject: subject.label,
        model,
        status: res.status,
        ok: res.ok,
        operationName: opName,
        ...quota,
        rawBody: redact(res.text ?? '').slice(0, 2000),
        headers: res.headers,
        transportError: res.transportError,
    });

    // 後片付け: 作れてしまった場合は必ず止めて消す
    if (opName) {
        const cancel = await request('POST', `/${opName}:cancel`, { key: subject.key, body: {}, attempts: 1 });
        const del = await request('DELETE', `/${opName}`, { key: subject.key, attempts: 1 });
        record({ probe: 'P4_cleanup', subject: subject.label, operationName: opName, cancelStatus: cancel.status, deleteStatus: del.status, cancelBody: redact(cancel.text ?? '').slice(0, 500), deleteBody: redact(del.text ?? '').slice(0, 500) });
        entry.cleanup = { cancelStatus: cancel.status, deleteStatus: del.status };
    }
    return entry;
}

// ---------------------------------------------------------------- main

const summary = {};

for (const subject of SUBJECTS) {
    console.log(`\n=== ${subject.label} key ===`);
    const m = await probeModels(subject);
    summary[subject.label] = { models: m };
    console.log(`P1 models.list: ${m.names?.length ?? 'ERROR'} 件 / batchGenerateContent 対応 ${m.batchCapable?.length ?? 0} 件`);

    const lists = await probeLists(subject);
    summary[subject.label].lists = lists;
    for (const [k, v] of Object.entries(lists)) {
        console.log(`P3 ${k}: HTTP ${v.status}${v.errorStatus ? ` (${v.errorStatus})` : ''}${v.isFreeTierQuota ? ' [FreeTier!]' : ''}`);
    }
}

// P1 の集合差分（「件数」ではなく「集合」を比べる — 既存の実測が見ていなかった点）
if (summary.free?.models?.names && summary.paid?.models?.names) {
    const f = new Set(summary.free.models.names);
    const p = new Set(summary.paid.models.names);
    const onlyPaid = [...p].filter(x => !f.has(x));
    const onlyFree = [...f].filter(x => !p.has(x));
    const methodDiff = [...f].filter(x => p.has(x))
        .filter(x => JSON.stringify(summary.free.models.methodsByModel[x]) !== JSON.stringify(summary.paid.models.methodsByModel[x]))
        .map(x => ({ model: x, free: summary.free.models.methodsByModel[x], paid: summary.paid.models.methodsByModel[x] }));
    record({ probe: 'P1_diff', onlyPaid, onlyFree, methodDiff, freeCount: f.size, paidCount: p.size });
    console.log(`\n=== P1 集合差分 ===`);
    console.log(`free のみ: ${onlyFree.length} 件 ${JSON.stringify(onlyFree.slice(0, 10))}`);
    console.log(`paid のみ: ${onlyPaid.length} 件 ${JSON.stringify(onlyPaid.slice(0, 10))}`);
    console.log(`supportedGenerationMethods が違うモデル: ${methodDiff.length} 件`);
    if (methodDiff.length) console.log(JSON.stringify(methodDiff.slice(0, 5), null, 2));
}

// P4: 両キーが batch 対応と申告しているモデルを選ぶ（無ければ拡張が使うモデル名で強行）
const preferred = ['models/gemini-flash-lite-latest', 'models/gemini-3.1-flash-lite', 'models/gemini-2.5-flash-lite', 'models/gemini-2.5-flash'];
const candidates = summary.free?.models?.batchCapable ?? [];
const chosen = preferred.find(p => candidates.includes(p)) ?? candidates[0] ?? preferred[0];
const chosenId = chosen.replace(/^models\//, '');

console.log(`\n=== P4 batches.create (model=${chosenId}) ===`);
for (const subject of SUBJECTS) {
    const r = await probeBatchCreate(subject, chosenId);
    summary[subject.label].batchCreate = r;
    console.log(`${subject.label}: HTTP ${r.status} ${r.errorStatus ?? ''} ${r.isFreeTierQuota ? '[FreeTier!]' : ''} quotaIds=${JSON.stringify(r.quotaIds)}`);
    if (r.errorMessage) console.log(`  message: ${r.errorMessage}`);
    if (r.operationName) console.log(`  created: ${r.operationName} → cleanup ${JSON.stringify(r.cleanup)}`);
}

console.log(`\n生ログ: ${path.relative(REPO_ROOT, JSONL)}`);
