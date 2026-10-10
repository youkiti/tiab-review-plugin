// 文献単位の再開、並列呼び出し、再試行と全体停止を調整する。
import { buildScreeningPrompt, SCREENING_SCHEMA, sha256Hex } from './prompt.mjs';
import { buildCliArgs, classifyCliResult } from './cli.mjs';
import { appendJsonl, readJsonl, compactByRefId } from './ledger.mjs';

export async function runCondition({ records, condition, config, paths, invoke, sleep, now, log }) {
    const existing = readJsonl(paths.items);
    const done = new Set(compactByRefId(existing).map((row) => row.ref_id));
    const pending = records.filter((record) => !done.has(record.id));
    const counts = {
        target: records.length, alreadyDone: records.length - pending.length,
        succeeded: 0, failedRecords: 0, failedAttempts: 0, aborted: false, abortReason: null,
    };
    let cursor = 0;
    let consecutiveFailures = 0;
    const timestamp = () => new Date(now()).toISOString();
    const progress = () => {
        const completed = counts.alreadyDone + counts.succeeded;
        log(`${condition.id}: ${completed}/${counts.target} 件完了（失敗 ${counts.failedRecords}）`);
    };
    const abort = (reason) => {
        if (!counts.aborted) {
            counts.aborted = true;
            counts.abortReason = reason;
            log(`停止: ${reason}`);
        }
    };
    if (existing.skippedPartialLines) {
        log(`台帳の部分行を ${existing.skippedPartialLines} 行読み飛ばしました`);
    }
    const args = buildCliArgs(condition, SCREENING_SCHEMA);
    async function processRecord(record) {
        const prompt = buildScreeningPrompt({ ...config, criteria: config.dataset.criteria }, {
            title: record.title, abstract: record.abstract,
        });
        for (let attempt = 1; attempt <= config.retry.maxAttempts && !counts.aborted; attempt++) {
            const startedAt = timestamp();
            const raw = await invoke({
                bin: config.cli.bin, args, prompt, timeoutMs: config.cli.timeoutMs, cwd: paths.cwd,
            });
            const finishedAt = timestamp();
            const result = classifyCliResult(raw, condition.model);
            // 成否を問わず全文を保存し、失敗台帳の短縮表示からも調査できるようにする。
            appendJsonl(paths.raw, {
                ref_id: record.id, attempt, kind: result.kind, started_at: startedAt, finished_at: finishedAt,
                ...raw,
            });
            if (result.kind === 'ok') {
                consecutiveFailures = 0;
                const parsed = result.parsed;
                const usage = parsed.usage ?? {};
                appendJsonl(paths.items, {
                    ledger_version: config.ledgerVersion, ref_id: record.id, condition: condition.id,
                    model_requested: condition.model, models_reported: Object.keys(parsed.modelUsage), effort: condition.effort,
                    ...result.output,
                    usage: {
                        input_tokens: usage.input_tokens ?? 0,
                        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                        output_tokens: usage.output_tokens ?? 0,
                        thinking_tokens: usage.output_tokens_details?.thinking_tokens ?? 0,
                    },
                    total_cost_usd: parsed.total_cost_usd ?? null,
                    duration_ms: parsed.duration_ms ?? null, duration_api_ms: parsed.duration_api_ms ?? null,
                    num_turns: parsed.num_turns ?? null, stop_reason: parsed.stop_reason ?? null,
                    session_id: parsed.session_id ?? null, attempt, started_at: startedAt, finished_at: finishedAt,
                    prompt_sha256: sha256Hex(prompt), cli_version: config.cliVersion,
                });
                counts.succeeded++;
                progress();
                return;
            }
            counts.failedAttempts++;
            consecutiveFailures++;
            appendJsonl(paths.failures, {
                ref_id: record.id, attempt, kind: result.kind, detail: result.detail, exitCode: raw.exitCode,
                stdout: raw.stdout.slice(0, 2000), stderr: raw.stderr.slice(0, 2000),
                started_at: startedAt, finished_at: finishedAt,
            });
            if (result.kind === 'model_mismatch') {
                abort('要求モデルと報告モデルが一致しません');
            } else if (consecutiveFailures >= config.abortAfterConsecutiveFailures) {
                abort(`連続失敗が ${consecutiveFailures} 回に達しました`);
            }
            if (!counts.aborted && attempt < config.retry.maxAttempts) {
                await sleep(Math.min(config.retry.baseDelayMs * 2 ** (attempt - 1), config.retry.maxDelayMs));
            }
        }
        counts.failedRecords++;
        progress();
    }
    async function worker() {
        while (!counts.aborted && cursor < pending.length) {
            const record = pending[cursor++];
            try {
                await processRecord(record);
            } catch (error) {
                abort(`処理または台帳保存に失敗: ${error.message}`);
                counts.failedRecords++;
            }
        }
    }
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
    progress();
    return counts;
}
