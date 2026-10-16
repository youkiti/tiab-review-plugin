import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBatchCost, estimateInputTokens, estimateOutputTokens, resolveModelPricing } from '../src/lib/llm-pricing';

test('組み込み単価は取得済み一覧より優先する', () => {
    const prices = [
        ['gemini-3.1-flash-lite', 0.25, 1.5],
        ['gemini-3-flash-preview', 0.5, 3],
        ['claude-sonnet-5-5', 2, 10],
        ['claude-haiku-5-5', 0.1, 0.5],
        ['gpt-5.6-terra', 2, 12],
        ['gpt-5.6-luna', 0.2, 1.2],
    ] as const;
    for (const [id, inputPerMillion, outputPerMillion] of prices) {
        assert.deepEqual(resolveModelPricing(id, [{ id, inputPerMillion: 99, outputPerMillion: 99 }]), {
            inputPerMillion,
            outputPerMillion,
        });
    }
});

test('OpenRouterの組み込みモデルも取得済み単価を使い、無料単価も認める', () => {
    for (const id of ['qwen/qwen3-235b-a22b-2507', 'deepseek/deepseek-v4-flash', 'typesafe/jev-1.14', 'vendor/custom']) {
        assert.equal(resolveModelPricing(id, []), null);
        assert.deepEqual(resolveModelPricing(id, [{ id, inputPerMillion: 0.3, outputPerMillion: 1.2 }]), {
            inputPerMillion: 0.3,
            outputPerMillion: 1.2,
        });
    }
    assert.deepEqual(resolveModelPricing('vendor/free', [{ id: 'vendor/free', inputPerMillion: 0, outputPerMillion: 0 }]), {
        inputPerMillion: 0,
        outputPerMillion: 0,
    });
});

test('単価なし・片方だけ・別IDは概算不可とする', () => {
    assert.equal(resolveModelPricing('jev-1.14.0', []), null);
    assert.equal(resolveModelPricing('unknown', []), null);
    assert.equal(resolveModelPricing('vendor/model', [{ id: 'vendor/model', inputPerMillion: 2 }]), null);
    assert.equal(resolveModelPricing('vendor/model', [{ id: 'vendor/model', outputPerMillion: 3 }]), null);
    assert.equal(resolveModelPricing('vendor/model', [{ id: 'vendor/other', inputPerMillion: 2, outputPerMillion: 3 }]), null);
});

test('入力は各文献の文字数を切り上げて固定分を加える', () => {
    assert.equal(estimateInputTokens('abcd', { title: 'ef', abstract: 'ghi' }), 403);
    assert.equal(estimateInputTokens('', { title: '' }), 400);
    assert.equal(estimateInputTokens('日本語', { title: '題名', abstract: '' }), 402);
});

test('出力は思考なし・思考あり・不明の設定から見積もる', () => {
    assert.equal(estimateOutputTokens('gemini-3.1-flash-lite'), 160);
    assert.equal(estimateOutputTokens('qwen/qwen3-235b-a22b-2507'), 160);
    assert.equal(estimateOutputTokens('jev-1.14.0'), 160);
    assert.equal(estimateOutputTokens('gemini-3-flash-preview'), 600);
    assert.equal(estimateOutputTokens('gpt-5.6-terra'), 600);
    assert.equal(estimateOutputTokens('claude-haiku-5-5'), 600);
    assert.equal(estimateOutputTokens('vendor/fetched'), 600);
    assert.equal(estimateOutputTokens('vendor/custom'), 600);
});

test('概算費用は文献ごとに切り上げた入力と出力の手計算に一致する', () => {
    const refs = [{ title: 'a', abstract: 'b' }, { title: 'abcde' }];
    const pricing = { inputPerMillion: 2, outputPerMillion: 10 };
    // プロンプト4文字を含め、入力は402 + 403、出力は160 × 2。
    assert.equal(estimateBatchCost(refs, 'test', 'gemini-3.1-flash-lite', pricing), 0.00481);
    // 思考するモデル・不明なモデルは出力600 × 2。
    assert.equal(estimateBatchCost(refs, 'test', 'gpt-5.6-terra', pricing), 0.01361);
    assert.equal(estimateBatchCost(refs, 'test', 'vendor/custom', pricing), 0.01361);
    assert.equal(estimateBatchCost([], 'test', 'vendor/custom', pricing), 0);
    assert.equal(estimateBatchCost(refs, 'test', 'jev-1.14.0', null), null);
});
