import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoDecisionsResponse, buildStreamGenerateContentResponseText } from '../src/demo/gemini-fixtures';
import { installDemoFetchMock } from '../src/demo/fetch-mock';

const questions = {
    include: { type: 'noul', instructions: 'Include this reference?' },
    criterion_0: { type: 'noul', instructions: 'Population matches?' },
    criterion_1: { type: 'noul', instructions: 'Intervention matches?' },
};

for (const [title, abstract, included] of [
    ['Randomized trial', 'Adults receiving exercise therapy.', true],
    ['Exercise therapy', 'A meta-analysis of trials.', true],
    ['Case report', 'One patient receiving exercise therapy.', false],
    ['Exercise therapy', 'A study protocol.', false],
] as const) {
    test(`デモのDecisions応答が文献の傾向と要素の確率を返す: ${title} / ${abstract}`, () => {
        const body = { input: `Title: ${title}\n\nAbstract: ${abstract}`, questions };
        const result = buildDemoDecisionsResponse(body);
        assert.ok(included ? result.answers.include.noul > 0.8 : result.answers.include.noul < 0.2);
        assert.deepEqual(Object.keys(result.answers), Object.keys(questions));
        for (const answer of Object.values(result.answers)) {
            assert.equal(answer.type, 'noul');
            assert.ok(answer.noul >= 0.01 && answer.noul <= 0.99);
            assert.equal(answer.confidence, Math.max(answer.noul, 1 - answer.noul));
            assert.ok(Math.abs(answer.noul - result.answers.include.noul) <= 0.031);
        }
        assert.notEqual(result.answers.criterion_0.noul, result.answers.criterion_1.noul);
        assert.deepEqual(buildDemoDecisionsResponse(body), result);
        const tokens = Math.ceil((body.input.length + Object.values(questions).reduce(
            (length, question) => length + question.instructions.length, 0,
        )) / 4);
        assert.deepEqual(result.usage, {
            total_tokens: tokens,
            total_input_tokens: tokens,
            input_tokens_by_modality: [{ modality: 'text', tokens }],
            total_output_tokens: 0,
        });
        const generated = JSON.parse(buildStreamGenerateContentResponseText({ contents: [{ parts: [{
            text: `**タイトル:**\n${title}\n\n**抄録:**\n${abstract}\n\n## 出力指示`,
        }] }] }, 'demo'));
        const judgement = JSON.parse(generated[0].candidates[0].content.parts[0].text);
        assert.equal(result.answers.include.noul, judgement.include_probability);
    });
}

test('デモのPOST /v1beta/decisionsが通信せず成功し、計測ラベルに記録される', async () => {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as typeof globalThis & { __WEB_BUILD__?: boolean };
    const originalWebBuild = globals.__WEB_BUILD__;
    const originalNet = globalThis.__tiabDemoNet;
    globals.__WEB_BUILD__ = false;
    globalThis.fetch = async () => { throw new Error('実通信は禁止'); };
    try {
        installDemoFetchMock();
        const body = { input: 'Title: Randomized trial\n\nAbstract: Exercise therapy.', questions };
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), buildDemoDecisionsResponse(body));
        const snapshot = globalThis.__tiabDemoNet!.snapshot();
        assert.equal(snapshot.byEndpoint['POST gemini.decisions'].count, 1);
        assert.ok(snapshot.byEndpoint['POST gemini.decisions'].bytes > 0);
    } finally {
        globalThis.fetch = originalFetch;
        globals.__WEB_BUILD__ = originalWebBuild;
        globalThis.__tiabDemoNet = originalNet;
    }
});
