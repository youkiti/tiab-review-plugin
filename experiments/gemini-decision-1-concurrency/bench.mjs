// gemini-decision-1（Gemini Decisions API）の並列数ごとのスループットと上限を測る。
//
// 使い方（リポジトリ直下で実行）:
//   node experiments/gemini-decision-1-concurrency/bench.mjs --concurrency 8 --count 600
//   node experiments/gemini-decision-1-concurrency/bench.mjs --concurrency 8 --count 3 --stage smoke
//   node experiments/gemini-decision-1-concurrency/bench.mjs --fake --concurrency 64 --count 500
//   node experiments/gemini-decision-1-concurrency/bench.mjs --summarize
//
// 1件ごとに results/<stage>.jsonl へ追記する。同じ stage で再実行すると、記録済みの seq を飛ばして続きから流す。
// API キーは .env の GEMINI_API_KEY をこのスクリプトの中だけで読む（出力・引数・URL に載せない）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const REPO = path.resolve(HERE, '..', '..');
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const MODEL = 'gemini-decision-1';
const PRICE_INPUT_PER_M = 0.10; // 入力 $0.10 / 1M tokens、出力なし（Gemini API 料金ページ、2026-11-12）
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;        // 429 以外の失敗（5xx・400・タイムアウト・通信エラー・不正な本文）の試行上限
const MAX_429_ATTEMPTS = 20;   // 429 は別枠で数え、上限待ちを「失敗」に混ぜない
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_COOLDOWN_MS = 120_000; // これより長い RetryInfo は日次上限などとみなし、測定を止める
const STALL_MS = 180_000;        // 完了が1件も無い時間がこれを超えたら止める
// 再試行してよい呼び出しの allowlist。Decisions API は状態を持たない判定だけで、
// 二重に処理されても結果は変わらず、増えるのは1件分の入力費用（約 $0.00005）だけなので冪等として扱う。
const RETRY_ALLOWLIST = new Set([`POST ${ENDPOINT}`]);

// 本走（feat/gemini-decision-bench の config.json）と同じ screeningPrompt と cq1 の基準。
const CRITERIA = 'Include studies investigating Fluid Therapy (resuscitation fluid type, rate, bolus strategy) for patients with sepsis, septic shock, or critical illness.';
const PROMPT = 'You are a screener for a systematic review.\nSensitivity is paramount in systematic reviews to avoid missing relevant studies.\nIf you are unsure or if the full text is required to make a definitive decision, you MUST include the study.\n\n## Inclusion Criteria\n'
    + CRITERIA
    + '\n\nInclude studies that meet the inclusion criteria.\nExclude studies that do not meet the criteria or are clearly irrelevant.';
const INSTRUCTIONS = `${PROMPT}\n\nShould this record be included at the title/abstract screening stage?`;

function parseArgs(argv) {
    const o = { concurrency: null, count: null, stage: null, fake: false, summarize: false, dataset: 'cq1' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--concurrency') o.concurrency = Number(argv[++i]);
        else if (a === '--count') o.count = Number(argv[++i]);
        else if (a === '--stage') o.stage = argv[++i];
        else if (a === '--dataset') o.dataset = argv[++i];
        else if (a === '--fake') o.fake = true;
        else if (a === '--summarize') o.summarize = true;
        else throw new Error(`不明な引数: ${a}`);
    }
    if (o.summarize) return o;
    if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error('--concurrency は1以上の整数');
    if (!Number.isInteger(o.count) || o.count < 1) throw new Error('--count は1以上の整数');
    if (!/^[a-z0-9_-]{1,40}$/i.test(o.dataset)) throw new Error('--dataset が不正');
    o.stage ??= `${o.fake ? 'fake-' : ''}c${o.concurrency}`;
    if (!/^[a-z0-9_-]{1,40}$/i.test(o.stage)) throw new Error('--stage は英数字・-・_ のみ');
    return o;
}

function loadApiKey() {
    const candidates = [path.join(REPO, '.env')];
    try {
        const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
        candidates.push(path.join(path.dirname(common), '.env'));
    } catch { /* git が無くても REPO/.env だけ試す */ }
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*)$/);
            if (m) {
                const raw = m[1].trim();
                const quoted = raw.match(/^(['"])(.*?)\1/);
                const v = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
                if (v) return { key: v, file };
            }
        }
    }
    throw new Error('GEMINI_API_KEY が .env に見つかりません');
}

function loadRecords(dataset) {
    const file = path.join(REPO, 'scripts', 'asreview-baseline', 'datasets', `${dataset}_labeled.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const records = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(records) || records.length === 0) throw new Error(`${file} に records がありません`);
    return records;
}

/** 台帳を読み、seq ごとに最終行勝ちで圧縮する。 */
function readLedger(stage) {
    const file = path.join(RESULTS, `${stage}.jsonl`);
    const rows = new Map();
    if (!fs.existsSync(file)) return { file, rows };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (Number.isInteger(r.seq)) rows.set(r.seq, r);
        } catch { /* 途中で切れた最終行は無視し、その seq は流し直す */ }
    }
    return { file, rows };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 429 の本文から RetryInfo と QuotaFailure を抜き出す（入力文は含まれない部分だけ）。 */
function quotaInfo(body) {
    const err = body?.error;
    if (!err || typeof err !== 'object') return null;
    const out = { status: typeof err.status === 'string' ? err.status : null, retryDelay: null, violations: [],
        message: typeof err.message === 'string' ? err.message.slice(0, 300) : null };
    for (const d of Array.isArray(err.details) ? err.details : []) {
        const type = String(d?.['@type'] ?? '');
        if (type.endsWith('RetryInfo') && typeof d.retryDelay === 'string') out.retryDelay = d.retryDelay;
        if (type.endsWith('QuotaFailure') && Array.isArray(d.violations)) {
            for (const v of d.violations) {
                out.violations.push({ quotaMetric: v?.quotaMetric ?? null, quotaId: v?.quotaId ?? null,
                    quotaValue: v?.quotaValue ?? null, quotaDimensions: v?.quotaDimensions ?? null });
            }
        }
    }
    return out;
}

function parseDelay(s) {
    const m = typeof s === 'string' && s.match(/^(\d+(?:\.\d+)?)s$/);
    return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** 1回の試行。戻り値の kind: success | empty | http | invalid | timeout | network */
async function attemptReal(apiKey, record) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                input: `Title: ${record.title ?? ''}\n\nAbstract: ${record.abstract || '(no abstract)'}`,
                questions: { include: { type: 'noul', instructions: INSTRUCTIONS } },
            }),
            signal: controller.signal,
        });
        const text = await res.text();
        const ms = performance.now() - t0;
        let body = null;
        try { body = JSON.parse(text); } catch { /* 下で invalid / http として扱う */ }
        if (!res.ok) return { kind: 'http', http: res.status, ms, quota: res.status === 429 ? quotaInfo(body) : null,
            errorStatus: typeof body?.error?.status === 'string' ? body.error.status : null };
        if (!body) return { kind: 'invalid', http: res.status, ms };
        const p = body?.answers?.include?.noul;
        const tokens = body?.usage?.total_input_tokens;
        if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) {
            return { kind: 'success', http: res.status, ms, noul: p, inputTokens: Number.isFinite(tokens) ? tokens : null };
        }
        if (body?.answers && typeof body.answers === 'object' && (p === undefined || p === null)) {
            return { kind: 'empty', http: res.status, ms, inputTokens: Number.isFinite(tokens) ? tokens : null };
        }
        return { kind: 'invalid', http: res.status, ms };
    } catch (e) {
        const ms = performance.now() - t0;
        if (controller.signal.aborted) return { kind: 'timeout', http: null, ms };
        return { kind: 'network', http: null, ms, error: String(e?.cause?.code ?? e?.name ?? 'error').slice(0, 60) };
    } finally {
        clearTimeout(timer);
    }
}

/** --fake: 15,000 RPM の固定窓を模し、超えたら RetryInfo 付きの 429 を返す。 */
function makeFakeAttempt() {
    let windowStart = Date.now(), used = 0;
    const RPM = Number(process.env.FAKE_RPM) || 15_000; // 429 の経路を試すときに下げる
    return async () => {
        const now = Date.now();
        if (now - windowStart >= 60_000) { windowStart = now; used = 0; }
        const ms = 200 + Math.random() * 200;
        await sleep(ms);
        if (++used > RPM) {
            return { kind: 'http', http: 429, ms, errorStatus: 'RESOURCE_EXHAUSTED', quota: { status: 'RESOURCE_EXHAUSTED',
                retryDelay: `${Math.ceil((60_000 - (Date.now() - windowStart)) / 1000)}s`,
                violations: [{ quotaMetric: 'fake/requests_per_minute', quotaId: 'FakeRPM', quotaValue: String(RPM), quotaDimensions: null }],
                message: 'fake quota' } };
        }
        if (Math.random() < 0.002) return { kind: 'http', http: 503, ms };
        return { kind: 'success', http: 200, ms, noul: Math.random(), inputTokens: 474 };
    };
}

async function run(opts) {
    fs.mkdirSync(RESULTS, { recursive: true });
    const records = loadRecords(opts.dataset);
    let attempt;
    let keyFile = null;
    if (opts.fake) {
        attempt = makeFakeAttempt();
    } else {
        const { key, file } = loadApiKey();
        keyFile = file;
        attempt = record => attemptReal(key, record);
    }
    const { file, rows } = readLedger(opts.stage);
    const pending = [];
    for (let seq = 0; seq < opts.count; seq++) if (!rows.has(seq)) pending.push(seq);
    const runId = randomUUID().slice(0, 8);
    console.log(`stage=${opts.stage} concurrency=${opts.concurrency} count=${opts.count} 記録済み=${opts.count - pending.length} 未処理=${pending.length} runId=${runId}${keyFile ? ` key=${keyFile}` : ' (fake)'}`);
    if (pending.length === 0) { console.log('未処理 0 件。何も送らずに終了。'); return; }

    let cooldownUntil = 0;
    let fatal = null;
    let done = 0;
    const counts = { success: 0, empty: 0, failed: 0, unknown: 0 };
    const runStart = Date.now();
    let lastProgress = Date.now();
    const watchdog = setInterval(() => {
        if (!fatal && Date.now() - lastProgress > STALL_MS) fatal = `${STALL_MS / 1000} 秒間1件も完了しない（停滞。測定を止める）`;
    }, 5_000);

    async function processOne(seq) {
        const record = records[seq % records.length];
        const startedAt = Date.now();
        const attempts = [];
        let final = null;
        let otherFails = 0, throttles = 0;
        while (!fatal) {
            while (!fatal && Date.now() < cooldownUntil) await sleep(Math.min(200, cooldownUntil - Date.now()));
            if (fatal) break;
            const r = await attempt(record);
            attempts.push({ kind: r.kind, http: r.http, ms: Math.round(r.ms), ...(r.quota ? { quota: r.quota } : {}),
                ...(r.errorStatus ? { errorStatus: r.errorStatus } : {}), ...(r.error ? { error: r.error } : {}) });
            final = r;
            if (r.kind === 'success' || r.kind === 'empty') break;
            // 401/403/404 は設定の誤りなので再試行しない（400 は負荷時に一過性で出ることがあるので再試行する）。
            if (r.kind === 'http' && [401, 403, 404].includes(r.http)) {
                if (r.http !== 404) fatal = `HTTP ${r.http}（認証の問題。測定を止める）`;
                break;
            }
            if (!RETRY_ALLOWLIST.has(`POST ${ENDPOINT}`)) break;
            if (r.kind === 'http' && r.http === 429) {
                throttles++;
                if (throttles >= MAX_429_ATTEMPTS) break;
                const hinted = parseDelay(r.quota?.retryDelay);
                if (hinted != null && hinted > MAX_COOLDOWN_MS) {
                    fatal = `429 の RetryInfo が ${r.quota.retryDelay}（分単位の上限ではない。測定を止める）`;
                    break;
                }
                const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(throttles - 1, 5) * (1 + Math.random()));
                cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.max(backoff, hinted ?? 0)); // 全ワーカー共通の待機
                continue;
            }
            otherFails++;
            if (otherFails >= MAX_ATTEMPTS) break;
            await sleep(Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (otherFails - 1) * (1 + Math.random())));
        }
        if (!final) return; // 1回も送らずに止まった（fatal）。台帳に書かず、再開時に流し直す
        lastProgress = Date.now();
        const status = final.kind === 'success' ? 'success'
            : final.kind === 'empty' ? 'empty'
            : final.kind === 'http' ? 'failed'
            : 'unknown'; // timeout / network / invalid が最後まで続いた
        counts[status]++;
        const row = {
            stage: opts.stage, runId, concurrency: opts.concurrency, seq, recordId: record.id ?? null, status,
            attempts: attempts.length, retries: attempts.length - 1, throttles,
            latencyMs: Math.round(final.ms), totalMs: Date.now() - startedAt, startedAt, endedAt: Date.now(),
            inputTokens: final.inputTokens ?? null, noul: final.noul ?? null, fake: opts.fake, attemptLog: attempts,
        };
        fs.appendFileSync(file, JSON.stringify(row) + '\n');
        done++;
        if (done % 100 === 0) console.log(`完了 ${done} / ${pending.length}（成功 ${counts.success}・空 ${counts.empty}・失敗 ${counts.failed}・不明 ${counts.unknown}）`);
    }

    let next = 0;
    async function worker() {
        while (!fatal && next < pending.length) {
            const seq = pending[next++];
            await processOne(seq);
        }
    }
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, worker));
    clearInterval(watchdog);
    const sec = (Date.now() - runStart) / 1000;
    console.log(`終了 ${done} 件 / ${sec.toFixed(1)} 秒 = ${(done / sec).toFixed(1)} 件/秒（成功 ${counts.success}・空 ${counts.empty}・失敗 ${counts.failed}・不明 ${counts.unknown}）`);
    if (fatal) { console.log(`中止: ${fatal}`); process.exitCode = 2; }
    if (done < pending.length) console.log(`未処理 ${pending.length - done} 件が残っている。同じコマンドで再開できる。`);
}

function pct(sorted, q) {
    if (sorted.length === 0) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
}

function summarize() {
    if (!fs.existsSync(RESULTS)) { console.log('results/ がありません'); return; }
    const files = fs.readdirSync(RESULTS).filter(f => f.endsWith('.jsonl')).sort();
    const lines = [];
    // 件/秒: 最初の送信から最後の完了まで。定常: 完了順で10%目〜90%目の区間（立ち上がりと末尾の減速を除く）。
    // 要求/分: 429 や再試行を含めて実際に送った要求の数（公式の RPM と比べる値）。
    lines.push('| stage | 並列 | 件数 | 成功 | 空 | 失敗 | 不明 | 秒 | 件/秒 | 定常 件/秒 | 要求/分 | p50 ms | p95 ms | p95 全体 ms | 429 | 5xx | 400 | 他4xx | timeout | 通信 | 不正本文 | 再試行 | 入力トークン | 費用 $ |');
    lines.push('|' + '---|'.repeat(24));
    const quotaSections = [];
    let totalTokens = 0, totalReal = 0, totalAttempts = 0;
    for (const f of files) {
        const stage = f.replace(/\.jsonl$/, '');
        const { rows } = readLedger(stage);
        const all = [...rows.values()];
        if (all.length === 0) continue;
        const c = { success: 0, empty: 0, failed: 0, unknown: 0 };
        const e = { a429: 0, a5xx: 0, a400: 0, a4xx: 0, timeout: 0, network: 0, invalid: 0 };
        let retries = 0, tokens = 0, attempts = 0;
        const lat = [], tot = [];
        const byRun = new Map();
        const quotaKinds = new Map();
        const quotaSamples = [];
        for (const r of all) {
            c[r.status] = (c[r.status] ?? 0) + 1;
            retries += r.retries;
            attempts += r.attempts;
            if (Number.isFinite(r.inputTokens)) tokens += r.inputTokens;
            if (r.status === 'success') { lat.push(r.latencyMs); tot.push(r.totalMs); }
            for (const at of r.attemptLog) {
                if (at.http === 429) {
                    e.a429++;
                    const key = at.quota ? `status=${at.quota.status} ` + (at.quota.violations.map(v => `${v.quotaMetric} / ${v.quotaId} / value=${v.quotaValue}`).join('; ') || '(QuotaFailure なし)') : '(本文なし)';
                    quotaKinds.set(key, (quotaKinds.get(key) ?? 0) + 1);
                    if (at.quota && quotaSamples.length < 5) quotaSamples.push(`  - seq ${r.seq}: retryDelay=${at.quota.retryDelay}` + (at.quota.message ? ` / "${at.quota.message}"` : ''));
                } else if (at.http >= 500) e.a5xx++;
                else if (at.http === 400) e.a400++;
                else if (at.http >= 400) e.a4xx++;
                if (at.kind === 'timeout') e.timeout++;
                if (at.kind === 'network') e.network++;
                if (at.kind === 'invalid') e.invalid++;
            }
            const g = byRun.get(r.runId) ?? { ends: [], start: Infinity, end: -Infinity };
            g.ends.push(r.endedAt); g.start = Math.min(g.start, r.startedAt); g.end = Math.max(g.end, r.endedAt);
            byRun.set(r.runId, g);
        }
        // 再開で複数回に分かれたときは、各回の件数と所要時間をそれぞれ足して割る。
        let sec = 0, steadyN = 0, steadySec = 0;
        for (const g of byRun.values()) {
            sec += (g.end - g.start) / 1000;
            g.ends.sort((x, y) => x - y);
            const i10 = Math.floor(g.ends.length * 0.1), i90 = Math.floor(g.ends.length * 0.9) - 1;
            if (i90 > i10) { steadyN += i90 - i10; steadySec += (g.ends[i90] - g.ends[i10]) / 1000; }
        }
        lat.sort((x, y) => x - y); tot.sort((x, y) => x - y);
        const rps = sec > 0 ? all.length / sec : 0;
        const steady = steadySec > 0 ? (steadyN / steadySec).toFixed(1) : '-';
        const fake = all.some(r => r.fake);
        if (!fake) { totalTokens += tokens; totalReal += all.length; totalAttempts += attempts; }
        const conc = [...new Set(all.map(r => r.concurrency))].join('/');
        lines.push(`| ${stage} | ${conc} | ${all.length} | ${c.success} | ${c.empty} | ${c.failed} | ${c.unknown} | ${sec.toFixed(1)} | ${rps.toFixed(1)} | ${steady} | ${sec > 0 ? Math.round(attempts / sec * 60) : '-'} | ${pct(lat, 0.5) ?? '-'} | ${pct(lat, 0.95) ?? '-'} | ${pct(tot, 0.95) ?? '-'} | ${e.a429} | ${e.a5xx} | ${e.a400} | ${e.a4xx} | ${e.timeout} | ${e.network} | ${e.invalid} | ${retries} | ${tokens} | ${(tokens * PRICE_INPUT_PER_M / 1e6).toFixed(4)} |`);
        if (quotaKinds.size) {
            quotaSections.push(`- ${stage}: ` + [...quotaKinds].map(([k, n]) => `${n} 回 ${k}`).join(' ／ ') + '\n' + quotaSamples.join('\n'));
        }
    }
    console.log(lines.join('\n'));
    console.log(`\n実 API の合計: ${totalReal} 件（要求 ${totalAttempts} 回）、入力 ${totalTokens} トークン、費用 $${(totalTokens * PRICE_INPUT_PER_M / 1e6).toFixed(4)}`);
    if (quotaSections.length) console.log('\n429 の内訳（段ごと、本文の例は各段5件まで）:\n' + quotaSections.join('\n'));
    else console.log('\n429 は0件。');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.summarize) summarize();
else run(opts).catch(e => { console.error(`エラー: ${e?.message ?? e}`); process.exitCode = 1; });
