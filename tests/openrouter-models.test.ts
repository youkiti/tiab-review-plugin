import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenRouterModels } from '../src/lib/openrouter-models';
import { buildModelGroups, filterModelGroups, resolveModelEntry } from '../src/lib/llm-model-options';
import type { ModelOption } from '../src/lib/gemini-api';

function mockFetch(data: unknown[]): typeof fetch {
    return async (url, init) => {
        assert.equal(url, 'https://openrouter.ai/api/v1/models');
        assert.equal(init, undefined);
        return new Response(JSON.stringify({ data }));
    };
}

test('公開一覧は認証なしで取得し、単価を100万トークン単位へ丸める', async () => {
    const models = await fetchOpenRouterModels(mockFetch([
        { id: 'vendor/paid', name: '有料モデル', pricing: { prompt: '0.00000007', completion: '0.00000123456789' } },
        { id: 'vendor/free', pricing: { prompt: '0', completion: '0' } },
    ]));
    assert.deepEqual(models, [
        { id: 'vendor/paid', name: '有料モデル', inputPerMillion: 0.07, outputPerMillion: 1.234568 },
        { id: 'vendor/free', name: undefined, inputPerMillion: 0, outputPerMillion: 0 },
    ]);
});

test('空・非数値・欠損の単価は未設定としてモデルを残す', async () => {
    const models = await fetchOpenRouterModels(mockFetch([
        { id: 'v/blank', pricing: { prompt: '', completion: '  ' } },
        { id: 'v/invalid', pricing: { prompt: 'abc', completion: 'Infinity' } },
        { id: 'v/missing', name: 123 },
    ]));
    assert.equal(models.length, 3);
    for (const model of models) {
        assert.equal(model.inputPerMillion, undefined);
        assert.equal(model.outputPerMillion, undefined);
        assert.equal(model.name, undefined);
    }
});

test('入出力いずれかの負の単価と、明示的にテキスト非対応のモデルだけを除く', async () => {
    const models = await fetchOpenRouterModels(mockFetch([
        { id: 'v/auto', pricing: { prompt: '-1', completion: '0' } },
        { id: 'v/auto-output', pricing: { completion: '-0.1' } },
        { id: 'v/image-in', architecture: { input_modalities: ['image'], output_modalities: ['text'] } },
        { id: 'v/image-out', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        { id: 'v/empty', architecture: { output_modalities: [] } },
        { id: 'v/text', architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] }, supported_parameters: [] },
        { id: 'v/unknown', architecture: { input_modalities: 'image', output_modalities: null } },
        { id: 'v/missing' },
        { id: 123 },
        null,
    ]));
    assert.deepEqual(models.map(model => model.id), ['v/text', 'v/unknown', 'v/missing']);
});

test('HTTPエラーと不正な応答は例外にする', async () => {
    await assert.rejects(fetchOpenRouterModels(async () => new Response('', { status: 503 })), /503/);
    await assert.rejects(fetchOpenRouterModels(async () => new Response('{}')), /形式/);
    await assert.rejects(fetchOpenRouterModels(async () => {
        throw new Error('通信失敗');
    }), /通信失敗/);
});

function model(id: string, provider: ModelOption['provider'], custom = false): ModelOption {
    return { id, name: `表示名 ${id}`, provider, config: { temperature: 0 }, custom };
}

for (const explicit of [true, false]) {
    const operation = explicit ? 'Enter' : '欄から離れる';
    test(`${operation}: 候補IDとの完全一致は前後空白を除いて確定する`, () => {
        for (const id of ['candidate', 'deepseek/model']) {
            assert.deepEqual(resolveModelEntry(`  ${id}  `, ['candidate', 'deepseek/model'], explicit), { accept: id });
        }
    });

    test(`${operation}: スラッシュを含む非候補は明示的な入力だけ確定する`, () => {
        for (const id of ['deepseek/', 'vendor/unlisted']) {
            assert.deepEqual(resolveModelEntry(` ${id} `, ['deepseek/model'], explicit),
                explicit ? { accept: id } : { revert: true, warn: false });
        }
    });

    test(`${operation}: 未知の入力は戻し、明示的な確定時だけ警告する`, () => {
        for (const value of ['unknown', 'CANDIDATE', 'candid']) {
            assert.deepEqual(resolveModelEntry(value, ['candidate'], explicit), { revert: true, warn: explicit });
        }
    });

    test(`${operation}: 空欄と空白だけの入力は警告せず戻す`, () => {
        for (const value of ['', '   ']) {
            assert.deepEqual(resolveModelEntry(value, ['candidate'], explicit), { revert: true, warn: false });
        }
    });
}

test('グループ順を保ち、組み込みとカスタムのIDを取得側から除く', () => {
    const builtIn = [
        model('typesafe/jev-1.14', 'typesafe'),
        model('claude', 'anthropic'),
        model('gpt', 'openai'),
        model('v/built-in', 'openrouter'),
        model('gemini', 'gemini'),
    ];
    const custom = [model('v/custom', 'openrouter', true), model('typesafe/jev-1.14', 'openrouter', true)];
    const fetched = ['typesafe/jev-1.14', 'v/custom', 'v/built-in', 'v/fetched', 'v/fetched'].map(id => ({ id }));
    const snapshot = JSON.stringify({ builtIn, custom, fetched });
    const groups = buildModelGroups(builtIn, custom, fetched);
    assert.deepEqual(groups.map(group => group.labelKey || group.label), [
        'Gemini', 'OpenRouter', 'llm_fetchedModels', 'OpenAI', 'Anthropic', 'TypeSafe',
    ]);
    assert.deepEqual(groups[1].models.map(item => item.id), ['v/built-in', 'v/custom']);
    assert.deepEqual(groups[2].models.map(item => item.id), ['v/fetched']);
    assert.equal(groups[5].models[0].provider, 'typesafe');
    assert.equal(JSON.stringify({ builtIn, custom, fetched }), snapshot);
});

test('表示名とIDを大文字小文字・前後空白を無視して検索する', () => {
    const builtIn = [{ ...model('gemini-one', 'gemini'), name: 'Flash', nameKey: 'translated' }];
    const groups = buildModelGroups(builtIn, [], [{ id: 'vendor/other', name: 'Other' }]);
    const snapshot = JSON.stringify(groups);
    assert.deepEqual(filterModelGroups(groups, '   '), groups);
    assert.equal(filterModelGroups(groups, ' fLaSh ')[0].models[0].id, 'gemini-one');
    assert.equal(filterModelGroups(groups, ' VENDOR/ ')[0].models[0].id, 'vendor/other');
    assert.equal(filterModelGroups(groups, '翻訳名', item => item.nameKey ? '翻訳名' : item.name)[0].models[0].id, 'gemini-one');
    assert.deepEqual(filterModelGroups(groups, '該当なし'), []);
    assert.equal(JSON.stringify(groups), snapshot);
});
