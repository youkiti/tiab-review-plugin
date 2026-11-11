import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientSemver, compareSemver, collectVersionRange, formatToolVersionClause } from '../src/lib/manuscript-version';
import type { Decision } from '../src/lib/types';

function decision(clientVersion: string | undefined, decisionValue: Decision['decision'] = 'include'): Decision {
    return {
        decision_id: `d-${Math.random()}`, ref_id: 'r1', reviewer_id: 'a@example.com',
        decision: decisionValue, decided_at: '2026-11-01T00:00:00Z', client_version: clientVersion,
    };
}

test('parseClientSemver: 拡張・Web・コマンドラインの形式から x.y.z を取り出す', () => {
    assert.equal(parseClientSemver('0.57.2-human'), '0.57.2');
    assert.equal(parseClientSemver('web-0.57.2-human'), '0.57.2');
    assert.equal(parseClientSemver('web-0.57.2+abc1234-human'), '0.57.2');
    assert.equal(parseClientSemver('web-0.57.2+abc1234def-llm'), '0.57.2');
    assert.equal(parseClientSemver('web-0.57.2+abc1234-human-consensus'), '0.57.2');
    assert.equal(parseClientSemver('cli-0.57.2-human'), '0.57.2');
    assert.equal(parseClientSemver('0.7.0-ml'), '0.7.0');
    assert.equal(parseClientSemver('0.1.0'), '0.1.0');
});

test('parseClientSemver: 読めない形式は null', () => {
    for (const value of ['llm-processor-v1', 'unknown-llm', 'unknown-human', 'test', '', undefined]) {
        assert.equal(parseClientSemver(value), null, String(value));
    }
});

test('compareSemver: 数値として比べる', () => {
    assert.ok(compareSemver('0.9.0', '0.10.0') < 0);
    assert.ok(compareSemver('0.57.2', '0.57.1') > 0);
    assert.equal(compareSemver('0.57.2', '0.57.2'), 0);
});

test('collectVersionRange: 最小と最大を返し、pending の行も含み、読めない行は無視する', () => {
    const range = collectVersionRange([
        decision('0.57.2-human'), decision('web-0.52.0-human'), decision('0.9.0-ml'), decision('0.10.0-llm'),
        decision('llm-processor-v1'), decision(undefined), decision('0.60.1-human', 'pending'),
    ]);
    assert.deepEqual(range, { min: '0.9.0', max: '0.60.1' });
});

test('collectVersionRange: 1件も読めなければ null', () => {
    assert.equal(collectVersionRange([]), null);
    assert.equal(collectVersionRange([decision('llm-processor-v1'), decision(undefined), decision('test')]), null);
});

test('formatToolVersionClause: 範囲なしは現在の版、同一は単一の版、違えば範囲、DOI があれば続ける', () => {
    assert.equal(formatToolVersionClause(null, '0.57.2', null), 'version 0.57.2');
    assert.equal(formatToolVersionClause(null, 'unknown', null), 'version [version]');
    assert.equal(formatToolVersionClause({ min: '0.57.2', max: '0.57.2' }, '0.60.0', null), 'version 0.57.2');
    assert.equal(formatToolVersionClause({ min: '0.52.0', max: '0.57.2' }, '0.60.0', null), 'versions 0.52.0 to 0.57.2');
    assert.equal(
        formatToolVersionClause({ min: '0.52.0', max: '0.57.2' }, '0.60.0', 'https://doi.org/10.5281/zenodo.1234567'),
        'versions 0.52.0 to 0.57.2; https://doi.org/10.5281/zenodo.1234567',
    );
    assert.equal(formatToolVersionClause({ min: '0.57.2', max: '0.57.2' }, '0.60.0', 'https://doi.org/10.5281/zenodo.1'), 'version 0.57.2; https://doi.org/10.5281/zenodo.1');
});
