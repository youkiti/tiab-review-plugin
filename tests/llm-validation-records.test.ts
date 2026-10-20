import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { saveLlmRun, updateLlmRun, getLlmRuns, clearLlmSheetEnsureMemo } from '../src/lib/sheets/llm-history';
import { updateLlmConfig, getLlmConfig } from '../src/lib/sheets/config';
import { LLM_RUNS_HEADERS, LLM_EXECUTIONS_HEADERS } from '../src/lib/sheets/schema';
import type { LlmRun } from '../src/lib/types';

test('検証の末尾7列と Config を保存・更新・読込でき、Run 更新の通信は増えない', async () => {
    const originalFetch = globalThis.fetch;
    setPlatform({ getAuthToken: async () => 'test' } as PlatformAdapter);
    clearLlmSheetEnsureMemo();
    const tables: Record<string, string[][]> = {
        LLM_Runs: [[...LLM_RUNS_HEADERS]], LLM_Executions: [[...LLM_EXECUTIONS_HEADERS]], Config: [],
    };
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const range = decodeURIComponent(url.pathname.split('/values/')[1]).replace(/:append$/, '');
        const [sheet, cells] = range.split('!');
        assert.ok(sheet in tables, '外部の実サービスには接続しない');
        requests.push(`${init?.method || 'GET'} ${range}`);
        const values = init?.body ? JSON.parse(String(init.body)).values as string[][] : [];
        if (init?.method === 'POST') {
            tables[sheet].push(...values);
        } else if (init?.method === 'PUT') {
            if (sheet === 'Config') {
                const index = Number(cells.slice(1)) - 1;
                tables[sheet][index][1] = values[0][0];
            } else {
                const index = Number(cells.match(/\d+/)?.[0]) - 1;
                tables[sheet][index] = values[0];
            }
        }
        return new Response(JSON.stringify({ values: cells === '1:1' ? [tables[sheet][0]] : tables[sheet] }));
    };
    try {
        const run: LlmRun = {
            run_id: 'run', config_hash: 'hash', created_at: '2026-10-20T00:00:00Z', model: 'model',
            criteria_snapshot: null, screening_prompt: '', include_threshold: 0.3, status: 'pending', is_active: false,
        };
        await saveLlmRun('offline', run);
        assert.equal(tables.LLM_Runs[1].length, LLM_RUNS_HEADERS.length);
        assert.deepEqual(tables.LLM_Runs[1].slice(-7), Array(7).fill(''));
        const validation = {
            validation_compared: 10, validation_human_includes: 5, validation_missed: 0,
            validation_false_includes: 1, validation_max_miss_rate: 0,
            validation_criterion_set_at: '2026-10-19T00:00:00Z', validation_evaluated_at: '2026-10-20T01:00:00Z',
        };
        const before = requests.length;
        await updateLlmRun('offline', run.run_id, { ...validation, status: 'confirmed', is_active: true });
        assert.equal(requests.length - before, 2, '既存の1回の行取得と1回の行更新だけ');
        const [loaded] = await getLlmRuns('offline');
        for (const [key, value] of Object.entries(validation)) {
            assert.equal(loaded[key as keyof LlmRun], value);
        }
        assert.equal(loaded.status, 'confirmed');
        assert.equal(loaded.is_active, true);
        await updateLlmConfig('offline', {
            llm_validation_max_miss_rate: 0.05, llm_validation_criterion_set_at: validation.validation_criterion_set_at,
        });
        await updateLlmConfig('offline', { llm_validation_max_miss_rate: 0 });
        const config = await getLlmConfig('offline');
        assert.equal(config.llm_validation_max_miss_rate, 0);
        assert.equal(config.llm_validation_criterion_set_at, validation.validation_criterion_set_at);
    } finally {
        globalThis.fetch = originalFetch;
        clearLlmSheetEnsureMemo();
    }
});
