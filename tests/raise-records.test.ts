import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AVAILABLE_MODELS, getModelConfig, buildGeminiScreeningPrompt } from '../src/lib/gemini-api';
import { MODEL_GENERATION_SETTINGS, getModelGenerationSettings, sentGenerationSettings } from '../src/lib/model-generation-settings';
import { buildTiabPromptTemplate, recordPromptTemplate } from '../src/lib/llm-prompt-record';
import { buildFulltextPrompt, FULLTEXT_PROMPT_VERSION } from '../src/lib/gemini-fulltext';
import { DEFAULT_SCREENING_PROMPT, PROMPT_VERSION } from '../src/lib/prompt-templates';
import { buildManuscriptAiSentence } from '../src/lib/manuscript-ai';
import { parseLlmConfig } from '../src/lib/sheets/config-schema';
import { modelMigrationNoticeKey } from '../src/sidepanel/features/llm/model-migration-notice';
import { buildBatchExecutionRecord } from '../src/sidepanel/features/llm/batch/execution-record';
import { processBatch } from '../src/lib/llm-processor';
import { LLM_EXECUTIONS_HEADERS } from '../src/lib/sheets/schema';
import type { Decision, Reference } from '../src/lib/types';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { saveLlmExecution, getLlmExecutions, clearLlmSheetEnsureMemo } from '../src/lib/sheets/llm-history';

function decision(ref: string, model: string, extra: Partial<Decision> = {}): Decision {
    return { decision_id: ref, ref_id: ref, reviewer_id: `llm:${model}@2026-10-20T00:00:00.000Z`,
        decision: 'include', screening_phase: 'tiab', note: '', decided_at: '', client_version: '', ...extra };
}

test('論文用AI文は実送信の設定と判定済み文献数・版だけを書く', () => {
    const text = buildManuscriptAiSentence([
        decision('a', 'gemini-3-flash-preview', { note: JSON.stringify({ type: 'llm', model_version: 'api-v1', prompt_version: 'v1.0.0' }) }),
        decision('a', 'gemini-3-flash-preview', { note: JSON.stringify({ type: 'llm', model_version: 'api-v2' }) }),
        decision('b', 'gpt-5.6-luna'), decision('c', 'claude-sonnet-5-5'), decision('d', 'jev-1.14.0'),
        decision('e', 'custom/model'), decision('f', 'gpt-5.6-terra', { decision: 'pending' }),
        decision('g', 'gpt-5.6-terra', { screening_phase: 'fulltext' }),
    ], 8, 0.3);
    assert.match(text, /screened 5 of the 8 records/);
    assert.match(text, /temperature 1, top-p 0.95, thinking level low/);
    assert.match(text, /gpt-5.6-luna \(reasoning effort low\)/);
    assert.match(text, /claude-sonnet-5-5 \(effort low\)/);
    assert.match(text, /jev-1.14.0\) screened/);
    assert.match(text, /custom\/model \(temperature 0\)/);
    assert.match(text, /api-v1, api-v2/);
    assert.match(text, /screening prompt version v1.0.0/);
    assert.doesNotMatch(text, /gpt-5.6-terra/);
    assert.match(buildManuscriptAiSentence([decision('a', 'jev-1.14.0')], 1, 0.3), /screened all records/);
    assert.equal(buildManuscriptAiSentence([], 10, 0.3), '');
});

test('モデルの設定表と一覧が一致し、未送信のパラメータは履歴に残さない', () => {
    assert.deepEqual(Object.keys(MODEL_GENERATION_SETTINGS).sort(), AVAILABLE_MODELS.map(m => m.id).sort());
    for (const model of AVAILABLE_MODELS) {
        const settings = getModelGenerationSettings(model.id);
        assert.equal(settings.provider, model.provider);
        const { provider: _provider, ...config } = settings;
        assert.deepEqual(model.config, { temperature: 0, ...config });
    }
    for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'claude-haiku-5-5']) {
        const sent = sentGenerationSettings(id, getModelConfig(id));
        assert.equal(sent.reasoning_effort, 'low');
        assert.equal(sent.temperature, undefined);
        assert.equal(sent.topP, undefined);
    }
    for (const id of ['jev-1.14.0', 'typesafe/jev-1.14', '~typesafe/custom']) {
        const sent = sentGenerationSettings(id, { temperature: 0 });
        assert.equal(sent.temperature, undefined);
        assert.equal(sent.reasoning_effort, undefined);
    }
    assert.equal(sentGenerationSettings('custom/model', { temperature: 0 }).temperature, 0);
});

test('通常実行とリトライの履歴は同じRunと実行者を保持し、設定を判定まで渡す', async () => {
    const modelConfig = { ...getModelConfig('gpt-5.6-luna'), reasoningEffort: 'high' as const, maxOutputTokens: 4096 };
    const base = { modelConfig, criteria: null, screeningPrompt: DEFAULT_SCREENING_PROMPT, outputLanguage: 'ja',
        runId: 'same-run', executedBy: 'test@example.test', targetCount: 1, targetMeta: { mode: 'all' as const } };
    const original = await buildBatchExecutionRecord({ ...base, timestamp: new Date('2026-10-20T00:00:00Z') });
    const retry = await buildBatchExecutionRecord({ ...base, timestamp: new Date('2026-10-20T00:00:01Z') });
    assert.notEqual(original.executionId, retry.executionId);
    for (const record of [original, retry]) {
        assert.equal(record.execution.run_id, 'same-run');
        assert.equal(record.execution.executed_by, base.executedBy);
        assert.equal(record.execution.reasoning_effort, 'high');
        assert.equal(record.execution.max_output_tokens, 4096);
        assert.equal(record.execution.temperature, undefined);
        assert.equal(record.execution.prompt_version, PROMPT_VERSION);
        const result = await processBatch([{ ref_id: 'a', title: '題', abstract: '抄録' } as Reference], {
            ...modelConfig, batchSize: 1, screeningPrompt: base.screeningPrompt, outputLanguage: 'ja',
            executionId: record.executionId, timestamp: record.timestamp, applyThreshold: 0.3,
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            screenFn: async (_provider, params) => {
                assert.equal(params.reasoningEffort, 'high');
                assert.equal(params.maxOutputTokens, 4096);
                return { output: { include_probability: 0.8, reasons: [], evidence: [] }, usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 }, responseMetadata: {} };
            },
        });
        assert.equal(result.executionId, record.execution.execution_id);
        assert.equal(result.decisions[0].reviewer_id, record.execution.execution_id);
        assert.equal(JSON.parse(result.decisions[0].note ?? '').prompt_version, PROMPT_VERSION);
    }
    const source = readFileSync('src/sidepanel/features/llm/batch/run.ts', 'utf8');
    const retrySource = source.slice(source.indexOf('export async function handleRetryFailed'));
    assert.ok(retrySource.indexOf('await saveLlmExecution') < retrySource.indexOf('await processBatch'));
    assert.match(retrySource, /runId: run.run_id/);
    assert.match(retrySource, /await finalizeBatchExecution/);
});

test('既定の送信全文と版のハッシュを固定する', async () => {
    const templates = {
        gemini: buildTiabPromptTemplate('gemini-3.1-flash-lite', DEFAULT_SCREENING_PROMPT, 'ja'),
        openrouter: buildTiabPromptTemplate('custom/model', DEFAULT_SCREENING_PROMPT, 'ja'),
        structured: buildTiabPromptTemplate('gpt-5.6-luna', DEFAULT_SCREENING_PROMPT, 'ja'),
        typesafe: buildTiabPromptTemplate('jev-1.14.0', DEFAULT_SCREENING_PROMPT, 'ja'),
        fulltext: buildFulltextPrompt(DEFAULT_SCREENING_PROMPT),
    };
    const expected: Record<string, string> = {
        gemini: '251df3814404', openrouter: 'f040bcc36b02', structured: 'bff263217364',
        typesafe: '3945a6413efc', fulltext: '0fc39788a3e1',
    };
    const actual: Record<string, string> = {};
    for (const [key, template] of Object.entries(templates)) {
        actual[key] = (await recordPromptTemplate(template)).prompt_sha256;
    }
    assert.deepEqual(actual, expected, 'プロンプトの文面を変えたら版の定数を上げ、この期待値を更新すること');
    assert.equal(PROMPT_VERSION, 'v1.0.0');
    assert.equal(FULLTEXT_PROMPT_VERSION, 'fulltext-v2.0.0');
    assert.equal(templates.gemini, buildGeminiScreeningPrompt('{{TITLE}}', '{{ABSTRACT}}', DEFAULT_SCREENING_PROMPT, 'ja'));
});

test('雛形は切り詰め前の全文をハッシュし、セル上限未満に切る', async () => {
    const template = 'あ'.repeat(45_001);
    const record = await recordPromptTemplate(template, FULLTEXT_PROMPT_VERSION);
    assert.equal(record.full_prompt_template, template.slice(0, 45_000) + '…[truncated]');
    assert.equal(record.prompt_version, FULLTEXT_PROMPT_VERSION);
    assert.notEqual(record.prompt_sha256, (await recordPromptTemplate(record.full_prompt_template)).prompt_sha256);
    assert.equal((await recordPromptTemplate('a'.repeat(45_000))).full_prompt_template.length, 45_000);
});

test('追加列は末尾でseedのミラーも一致する', () => {
    assert.deepEqual(LLM_EXECUTIONS_HEADERS.slice(-5), ['reasoning_effort', 'max_output_tokens', 'prompt_version', 'prompt_sha256', 'full_prompt_template']);
    const source = readFileSync('src/demo/seed.ts', 'utf8');
    const block = source.slice(source.indexOf('const LLM_EXECUTIONS_HEADERS = ['));
    const headers = [...block.slice(0, block.indexOf('];')).matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(headers, LLM_EXECUTIONS_HEADERS);
});

test('移行があるときだけ旧モデルと新モデルを注記の判定に使う', () => {
    const migrated = parseLlmConfig([['llm_model', 'jev-1.13.0']]);
    assert.equal(migrated.llm_model_migrated_from, 'jev-1.13.0');
    assert.equal(migrated.llm_model, 'jev-1.14.0');
    assert.equal(modelMigrationNoticeKey('project', migrated), JSON.stringify(['project', 'jev-1.13.0', 'jev-1.14.0']));
    assert.equal(modelMigrationNoticeKey('project', parseLlmConfig([['llm_model', 'jev-1.14.0']])), null);
});

test('追加した記録列を保存・読み込みでき、未送信のtemperatureは空欄になる', async () => {
    const originalFetch = globalThis.fetch;
    setPlatform({ getAuthToken: async () => 'テスト用の認証値' } as PlatformAdapter);
    clearLlmSheetEnsureMemo();
    const rows: string[][] = [LLM_EXECUTIONS_HEADERS];
    let requests = 0;
    globalThis.fetch = async (input, init) => {
        requests++;
        const url = String(input);
        if (init?.method === 'POST') {
            assert.match(url, /:append/);
            rows.push(...JSON.parse(String(init.body)).values);
        }
        return new Response(JSON.stringify({ values: rows }), { status: 200 });
    };
    try {
        const { execution } = await buildBatchExecutionRecord({
            modelConfig: { ...getModelConfig('gpt-5.6-luna'), maxOutputTokens: 2048 }, criteria: null,
            screeningPrompt: DEFAULT_SCREENING_PROMPT, outputLanguage: 'ja', runId: 'run',
            executedBy: 'test@example.test', targetCount: 1, targetMeta: { mode: 'all' },
        });
        await saveLlmExecution('offline-project', execution);
        assert.equal(rows[1][LLM_EXECUTIONS_HEADERS.indexOf('temperature')], '');
        assert.equal(rows[1].length, LLM_EXECUTIONS_HEADERS.length);
        const [loaded] = await getLlmExecutions('offline-project');
        assert.equal(loaded.reasoning_effort, 'low');
        assert.equal(loaded.max_output_tokens, 2048);
        assert.equal(loaded.prompt_version, execution.prompt_version);
        assert.equal(loaded.prompt_sha256, execution.prompt_sha256);
        assert.equal(loaded.full_prompt_template, execution.full_prompt_template);
        assert.equal(loaded.executed_by, execution.executed_by);
        assert.equal(requests, 3);
    } finally {
        globalThis.fetch = originalFetch;
        clearLlmSheetEnsureMemo();
    }
});
