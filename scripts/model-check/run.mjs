#!/usr/bin/env node
// 組み込みの AI モデル ID が各社の API でまだ使えるかを確かめる（週次点検 weekly-check.yml の models ジョブ）。
//
// 使い方:
//   npm run check:models -- [--report <Markdown の出力パス>]
//
// 一覧は scripts/model-check/inventory.ts を tsc で .tmp/model-check にコンパイルして読む
// （scripts/create-project.mjs と同じ手順）。確かめるのはモデルのメタデータの取得だけで、推論は呼ばない（課金なし）。
// 鍵は環境変数から読む（GEMINI_API_KEY・OPENAI_API_KEY・ANTHROPIC_API_KEY・TYPE_SAFE_API_KEY）。
// 未設定または空の社は「飛ばした」として報告に残す。OpenRouter の公開一覧は鍵が要らない。
// 鍵の値は出力にも例外メッセージにも出さない（AGENTS.md 基本ルール9）。
//
// 終了コード: 「見つからない」か「鍵が使えない」（401・403）が1件でもあれば 1。
// 「確認できない」（5xx・429・通信失敗・時間切れ）と「飛ばした」だけなら 0。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSCONFIG = path.join(REPO_ROOT, 'scripts', 'model-check', 'tsconfig.json');
const COMPILED_INVENTORY = path.join(REPO_ROOT, '.tmp', 'model-check', 'scripts', 'model-check', 'inventory.js');
const TIMEOUT_MS = 10000;

export const KEY_ENV = {
    gemini: 'GEMINI_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    typesafe: 'TYPE_SAFE_API_KEY',
};
const PROVIDER_LABEL = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', typesafe: 'TypeSafe', openrouter: 'OpenRouter' };
const STATUS_LABEL = {
    ok: '使える',
    missing: '見つからない',
    badkey: '鍵が使えない',
    unknown: '確認できない',
    skipped: '飛ばした',
};

function parseArgs(argv) {
    const args = { report: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--report') {
            const value = argv[++i];
            if (!value) throw new Error('--report には出力パスを指定してください');
            args.report = value;
        } else {
            throw new Error(`不明な引数: ${argv[i]}`);
        }
    }
    return args;
}

function compileInventory() {
    rmSync(path.join(REPO_ROOT, '.tmp', 'model-check'), { recursive: true, force: true });
    const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'node_modules', 'typescript-7', 'bin', 'tsc'), '--project', TSCONFIG],
        { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    if (result.error || result.status !== 0) throw new Error('inventory.ts のコンパイルに失敗しました');
    return createRequire(import.meta.url)(COMPILED_INVENTORY).listModelsToCheck();
}

/** 出力に載せる文字列から鍵の値を消す。 */
function redact(text, keys) {
    let out = String(text);
    for (const key of keys) {
        if (key) out = out.split(key).join('[REDACTED]');
    }
    return out;
}

function bodySnippet(text, keys) {
    return redact(text, keys).slice(0, 200).replace(/\s+/g, ' ');
}

async function request(fetchImpl, url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
        const text = await response.text().catch(() => '');
        return { status: response.status, text };
    } finally {
        clearTimeout(timer);
    }
}

/** 通信の失敗は「確認できない」にする。例外のメッセージにも鍵を残さない。 */
async function safeRequest(fetchImpl, url, headers, keys) {
    try {
        return { response: await request(fetchImpl, url, headers) };
    } catch (err) {
        const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const reason = aborted ? `${TIMEOUT_MS / 1000}秒で時間切れ` : `通信失敗: ${bodySnippet(err?.message ?? err, keys)}`;
        return { error: reason };
    }
}

function statusOnly(status) {
    if (status === 200) return { status: 'ok', detail: 'HTTP 200' };
    if (status === 404) return { status: 'missing', detail: 'HTTP 404' };
    if (status === 401 || status === 403) return { status: 'badkey', detail: `HTTP ${status}（鍵を確認してください）` };
    return { status: 'unknown', detail: `HTTP ${status}` };
}

function perModelRequest(provider, id, key) {
    const encoded = encodeURIComponent(id);
    if (provider === 'gemini') {
        return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encoded}`, headers: { 'x-goog-api-key': key } };
    }
    if (provider === 'openai') {
        return { url: `https://api.openai.com/v1/models/${encoded}`, headers: { Authorization: `Bearer ${key}` } };
    }
    return {
        url: `https://api.anthropic.com/v1/models/${encoded}`,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    };
}

/** 一覧を1回だけ取る社（typesafe・openrouter）の取得。全 ID をこの応答で判定する。 */
async function fetchList(fetchImpl, provider, key, keys) {
    const url = provider === 'typesafe' ? 'https://api.typesafe.ai/v1/models' : 'https://openrouter.ai/api/v1/models';
    const headers = provider === 'typesafe' ? { Authorization: `Bearer ${key}` } : {};
    const { response, error } = await safeRequest(fetchImpl, url, headers, keys);
    if (error) return { failure: { status: 'unknown', detail: error } };
    if (response.status === 401 || response.status === 403) {
        return { failure: { status: 'badkey', detail: `HTTP ${response.status}（鍵を確認してください）` } };
    }
    if (response.status !== 200) {
        return { failure: { status: 'unknown', detail: `HTTP ${response.status}: ${bodySnippet(response.text, keys)}` } };
    }
    if (provider === 'typesafe') {
        // 応答の形をコードから読まないので、JSON を文字列にしたものに "<id>" が含まれるかで判定する
        let text = response.text;
        try { text = JSON.stringify(JSON.parse(response.text)); } catch { /* JSON でなければ本文のまま */ }
        return { has: (id) => text.includes(`"${id}"`) };
    }
    try {
        const ids = new Set((JSON.parse(response.text).data ?? []).map((m) => m?.id).filter((v) => typeof v === 'string'));
        return { has: (id) => ids.has(id) };
    } catch {
        return { failure: { status: 'unknown', detail: `一覧を JSON として読めません: ${bodySnippet(response.text, keys)}` } };
    }
}

/**
 * models: listModelsToCheck() の戻り値。env: 鍵を読む環境変数。fetchImpl: 通信の差し替え口（テスト用）。
 * 戻り値は models と同じ順の { ...model, status, detail }。
 */
export async function checkModels(models, env, fetchImpl = fetch) {
    const keys = Object.values(KEY_ENV).map((name) => (env[name] ?? '').trim()).filter(Boolean);
    const lists = new Map();
    const results = [];
    for (const model of models) {
        const { provider, id } = model;
        const keyName = KEY_ENV[provider];
        const key = keyName ? (env[keyName] ?? '').trim() : '';
        if (keyName && !key) {
            results.push({ ...model, status: 'skipped', detail: `鍵なし: ${keyName}` });
            continue;
        }
        if (provider === 'typesafe' || provider === 'openrouter') {
            if (!lists.has(provider)) lists.set(provider, await fetchList(fetchImpl, provider, key, keys));
            const list = lists.get(provider);
            if (list.failure) results.push({ ...model, ...list.failure });
            else if (list.has(id)) results.push({ ...model, status: 'ok', detail: '一覧に載っている' });
            else results.push({ ...model, status: 'missing', detail: '一覧に載っていない' });
            continue;
        }
        const { url, headers } = perModelRequest(provider, id, key);
        const { response, error } = await safeRequest(fetchImpl, url, headers, keys);
        if (error) results.push({ ...model, status: 'unknown', detail: error });
        else results.push({ ...model, ...statusOnly(response.status) });
    }
    return results;
}

function formatJst(date) {
    return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

function escapeCell(text) {
    return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function buildReport(results, { now, sha }) {
    const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map((k) => [k, 0]));
    for (const r of results) counts[r.status] += 1;
    const lines = [
        '## AI モデル ID の生存確認',
        '',
        `- 実行日時: ${now.toISOString()}（UTC）/ ${formatJst(now)}（日本時間）`,
        `- コミット: ${sha}`,
        '',
        '| モデル ID | 社 | 使われている場所 | 結果 | 詳細 |',
        '| --- | --- | --- | --- | --- |',
        ...results.map((r) => `| \`${r.id}\` | ${PROVIDER_LABEL[r.provider]} | ${escapeCell(r.usedBy.join('、'))} | ${STATUS_LABEL[r.status]} | ${escapeCell(r.detail)} |`),
        '',
        `集計: 全${results.length}件（${Object.keys(STATUS_LABEL).map((k) => `${STATUS_LABEL[k]} ${counts[k]}`).join('、')}）`,
        '',
    ];
    return { markdown: lines.join('\n'), failed: counts.missing + counts.badkey };
}

function resolveSha() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '（不明）';
}

async function main() {
    const { report } = parseArgs(process.argv.slice(2));
    const models = compileInventory();
    const results = await checkModels(models, process.env);
    const { markdown, failed } = buildReport(results, { now: new Date(), sha: resolveSha() });
    console.log(markdown);
    if (report) {
        const target = path.resolve(report);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, markdown, 'utf8');
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
    if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error('生存確認が異常終了しました:', err?.message ?? err);
        process.exit(1);
    });
}
