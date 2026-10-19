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
import { buildBatchExecutionRecord, resolveBatchRetry, countExecutionReferences } from '../src/sidepanel/features/llm/batch/execution-record';
import { buildReviewerDecisionMap } from '../src/lib/decision-summary';
import { initializeStore } from '../src/sidepanel/store';
import { state } from '../src/sidepanel/state';
import { setFailedRefIds, clearFailedRefIds } from '../src/sidepanel/store/compat';
import { processBatch } from '../src/lib/llm-processor';
import { LLM_EXECUTIONS_HEADERS } from '../src/lib/sheets/schema';
import type { Decision, Reference, ReferenceWithStatus, LlmExecution } from '../src/lib/types';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { saveLlmExecution, getLlmExecutions, clearLlmSheetEnsureMemo } from '../src/lib/sheets/llm-history';

function decision(ref: string, model: string, extra: Partial<Decision> = {}): Decision {
    return { decision_id: ref, ref_id: ref, reviewer_id: `llm:${model}@2026-10-20T00:00:00.000Z`,
        decision: 'include', screening_phase: 'tiab', note: '', decided_at: '', client_version: '', ...extra };
}

function execution(model: string, extra: Partial<LlmExecution> = {}): LlmExecution {
    return { execution_id: decision('a', model).reviewer_id, execution_type: 'batch_screening',
        timestamp: '2026-10-20T00:00:00.000Z', model, criteria_snapshot: null,
        screening_prompt: DEFAULT_SCREENING_PROMPT, include_threshold: 0.3,
        target_count: 1, include_count: 0, exclude_count: 0, status: 'pending', is_active: false, ...extra };
}

test('論文用AI文は履歴の新旧形式・未記録・設定違いとプロンプト版を区別する', () => {
    const model = 'gemini-3-flash-preview';
    const second = 'llm:gemini-3-flash-preview@2026-10-20T01:00:00.000Z';
    const text = buildManuscriptAiSentence([
        decision('a', model, { note: JSON.stringify({ type: 'llm', model_version: 'api-v1', prompt_version: 'note-version' }) }),
        decision('b', model, { reviewer_id: second }),
        decision('c', 'gpt-5.6-luna'), decision('d', 'custom/model'),
        decision('e', model, { decision: 'pending' }), decision('f', model, { screening_phase: 'fulltext' }),
    ], 8, 0.3, [
        execution(model, { prompt_sha256: 'hash', temperature: 1, topP: 0.95, thinkingLevel: 'LOW', prompt_version: 'ignored' }),
        execution(model, { execution_id: second, temperature: 0, prompt_version: 'row-version' }),
        execution('gpt-5.6-luna', { temperature: 0, reasoning_effort: 'high' }),
    ]);
    assert.match(text, /screened 4 of the 8 records/);
    assert.match(text, /temperature 0; temperature 1, top-p 0.95, thinking level low/);
    assert.match(text, /gpt-5.6-luna \(reasoning effort low\)/);
    assert.match(text, /custom\/model \(generation settings not recorded\)/);
    assert.match(text, /api-v1/);
    assert.match(text, /note-version, row-version/);
    assert.doesNotMatch(text, /ignored/);
    assert.equal(buildManuscriptAiSentence([], 10, 0.3, []), '');
    const modern = buildManuscriptAiSentence([decision('a', 'gpt-5.6-luna')], 1, 0.3,
        [execution('gpt-5.6-luna', { prompt_sha256: 'hash', reasoning_effort: 'high' })]);
    assert.match(modern, /reasoning effort high/);
    assert.doesNotMatch(modern, /temperature/);
    assert.match(buildManuscriptAiSentence([decision('a', model)], 1, 0.3,
        [execution(model, { prompt_sha256: 'hash' })]), /no generation parameters sent/);
    for (const typesafe of ['jev-1.14.0', 'typesafe/jev-1.14', '~typesafe/custom']) {
        assert.match(buildManuscriptAiSentence([decision('a', typesafe)], 1, 0.3,
            [execution(typesafe, { temperature: 0 })]), /no generation parameters sent/);
    }
    assert.match(buildManuscriptAiSentence([decision('a', 'claude-sonnet-5-5')], 1, 0.3,
        [execution('claude-sonnet-5-5', { temperature: 0 })]), /effort low/);
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

test('リトライは失敗元を保持し、同じ実行IDの新しい票が仮の票を置き換える', async () => {
    initializeStore();
    const original = await buildBatchExecutionRecord({
        modelConfig: { ...getModelConfig('gemini-3-flash-preview'), temperature: 0, reasoningEffort: 'high', maxOutputTokens: 4096 },
        criteria: null, screeningPrompt: DEFAULT_SCREENING_PROMPT, outputLanguage: 'ja',
        runId: 'same-run', executedBy: 'test@example.test', targetCount: 1, targetMeta: { mode: 'all' },
        timestamp: new Date('2026-10-20T00:00:00Z'),
    });
    setFailedRefIds(['a'], original.executionId);
    state.setCurrentExecutionId('another-execution');
    const timestamp = new Date('2026-10-20T00:00:01Z');
    const retry = resolveBatchRetry(state, [original.execution], timestamp);
    assert.ok(!('error' in retry));
    assert.equal(retry.executionId, original.executionId);
    assert.equal(retry.modelConfig.temperature, 0);
    assert.equal(retry.modelConfig.maxOutputTokens, 4096);
    const savedVotes: Decision[] = [];
    await processBatch([{ ref_id: 'a', title: '題', abstract: '抄録' } as Reference], {
        ...retry.modelConfig, batchSize: 1, screeningPrompt: original.execution.screening_prompt, outputLanguage: 'ja',
        executionId: retry.executionId, timestamp: retry.timestamp, applyThreshold: 0.3,
        rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
        onSaveBatch: async votes => {
            savedVotes.push(...votes);
        },
        screenFn: async (_provider, params) => {
            assert.equal(params.temperature, 0);
            assert.equal(params.maxOutputTokens, 4096);
            return { output: { include_probability: 0.1, reasons: [], evidence: [] }, usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 }, responseMetadata: {} };
        },
    });
    const vote = savedVotes[0];
    assert.equal(vote.reviewer_id, original.executionId);
    assert.equal(vote.decided_at, timestamp.toISOString());
    assert.equal(vote.decision, 'exclude');
    const fallback = decision('a', original.execution.model, { reviewer_id: original.executionId,
        decided_at: original.timestamp.toISOString(), decision: 'include', note: JSON.stringify({ type: 'llm', parse_error: true, include_probability: 1 }) });
    const decisions = [fallback, vote];
    const map = buildReviewerDecisionMap({ allDecisions: decisions } as ReferenceWithStatus, new Set([original.executionId]), false);
    assert.deepEqual([...map.values()], [vote]);
    assert.equal(countExecutionReferences(decisions, original.executionId), 1);
    setFailedRefIds(['a'], retry.executionId);
    assert.equal(state.failedSourceExecutionId, original.executionId);
    clearFailedRefIds();
    assert.equal(state.failedSourceExecutionId, null);
    assert.deepEqual(state.failedRefIds, []);
    assert.deepEqual(resolveBatchRetry(state, [original.execution]), { error: 'llm_retryMissingExecution' });
    setFailedRefIds(['a'], original.executionId);
    assert.deepEqual(resolveBatchRetry(state, [{ ...original.execution, model: 'removed-model', requested_model: 'removed-model' }]),
        { error: 'llm_retryUnavailableModel' });
    setFailedRefIds([], original.executionId);
    assert.equal(state.failedSourceExecutionId, null);
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
