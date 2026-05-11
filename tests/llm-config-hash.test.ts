import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canonicalJson,
    computeConfigHash,
    isHashable,
    legacyHash,
    type LlmHashableConfig,
} from '../src/lib/llm-config-hash';

const baseConfig: LlmHashableConfig = {
    model: 'gemini-2.5-flash',
    temperature: 0.0,
    topP: 0.95,
    thinkingLevel: 'low',
    criteria_snapshot: {
        template: 'pico',
        fields: { population: 'adults', intervention: 'drug', comparison: 'placebo', outcome: 'mortality' },
    },
    screening_prompt: 'Decide include or exclude based on PICO.',
};

test('canonicalJson sorts object keys recursively', () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalJson({ a: { x: 1, y: 2 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"x":1,"y":2},"b":1}');
});

test('canonicalJson drops undefined fields but keeps null', () => {
    const out = canonicalJson({ a: undefined, b: null, c: 1 });
    assert.equal(out, '{"b":null,"c":1}');
});

test('canonicalJson normalizes CRLF and CR to LF', () => {
    const out = canonicalJson({ p: 'a\r\nb\rc\nd' });
    assert.equal(out, '{"p":"a\\nb\\nc\\nd"}');
});

test('canonicalJson preserves whitespace and indentation in strings', () => {
    const out = canonicalJson({ p: '  leading\n\ttab  trailing  ' });
    assert.equal(out, '{"p":"  leading\\n\\ttab  trailing  "}');
});

test('canonicalJson handles arrays recursively', () => {
    const out = canonicalJson({ list: [{ b: 1, a: 2 }, { a: 3 }] });
    assert.equal(out, '{"list":[{"a":2,"b":1},{"a":3}]}');
});

test('computeConfigHash is deterministic and prefixed v1:', async () => {
    const h1 = await computeConfigHash(baseConfig);
    const h2 = await computeConfigHash(baseConfig);
    assert.equal(h1, h2);
    assert.match(h1, /^v1:[0-9a-f]{64}$/);
});

test('computeConfigHash ignores include_threshold (not part of input)', async () => {
    // include_threshold is intentionally not part of LlmHashableConfig
    // so two runs differing only in threshold map to the same hash.
    const h = await computeConfigHash(baseConfig);
    const same = await computeConfigHash({ ...baseConfig });
    assert.equal(h, same);
});

test('computeConfigHash differs when model changes', async () => {
    const h1 = await computeConfigHash(baseConfig);
    const h2 = await computeConfigHash({ ...baseConfig, model: 'gemini-2.5-pro' });
    assert.notEqual(h1, h2);
});

test('computeConfigHash differs when prompt whitespace changes', async () => {
    const h1 = await computeConfigHash(baseConfig);
    const h2 = await computeConfigHash({ ...baseConfig, screening_prompt: baseConfig.screening_prompt + ' ' });
    assert.notEqual(h1, h2);
});

test('computeConfigHash treats CRLF and LF prompts as equal', async () => {
    const h1 = await computeConfigHash({ ...baseConfig, screening_prompt: 'line1\r\nline2' });
    const h2 = await computeConfigHash({ ...baseConfig, screening_prompt: 'line1\nline2' });
    assert.equal(h1, h2);
});

test('computeConfigHash differs when criteria changes', async () => {
    const h1 = await computeConfigHash(baseConfig);
    const h2 = await computeConfigHash({
        ...baseConfig,
        criteria_snapshot: {
            template: 'pico',
            fields: { ...baseConfig.criteria_snapshot!.fields, population: 'children' },
        },
    });
    assert.notEqual(h1, h2);
});

test('computeConfigHash treats undefined and absent fields the same', async () => {
    const withUndef = await computeConfigHash({ ...baseConfig, temperature: undefined });
    const withoutKey: LlmHashableConfig = {
        model: baseConfig.model,
        topP: baseConfig.topP,
        thinkingLevel: baseConfig.thinkingLevel,
        criteria_snapshot: baseConfig.criteria_snapshot,
        screening_prompt: baseConfig.screening_prompt,
    };
    const without = await computeConfigHash(withoutKey);
    assert.equal(withUndef, without);
});

test('isHashable returns true for valid config', () => {
    assert.equal(isHashable(baseConfig), true);
});

test('isHashable returns false for missing model', () => {
    assert.equal(isHashable({ ...baseConfig, model: '' }), false);
});

test('isHashable returns false for empty prompt', () => {
    assert.equal(isHashable({ ...baseConfig, screening_prompt: '' }), false);
});

test('isHashable allows criteria_snapshot=null but rejects undefined', () => {
    assert.equal(isHashable({ ...baseConfig, criteria_snapshot: null }), true);
    const noCriteria: Partial<LlmHashableConfig> = {
        model: baseConfig.model,
        screening_prompt: baseConfig.screening_prompt,
    };
    assert.equal(isHashable(noCriteria), false);
});

test('legacyHash isolates by execution_id', () => {
    assert.equal(legacyHash('llm:foo@2026'), 'legacy:llm:foo@2026');
    assert.notEqual(legacyHash('a'), legacyHash('b'));
});
