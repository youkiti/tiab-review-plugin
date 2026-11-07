// 選択・回答の送信範囲と、返された ID の検証を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerPrompt, buildSelectionPrompt, validateSelectedIds } from '../src/lib/help-consult/prompt';
import type { HelpSection } from '../src/lib/help-consult/types';

const sections: HelpSection[] = ['a', 'b', 'c', 'd'].map(id => ({
    id, title: `見出し${id}`, body: `本文${id}`, when: ['困ったとき'], level: 3, sectionId: 'group', sectionTitle: '章',
}));

test('選択は本文を送らず、回答は選んだ見出しと本文だけを渡して言語を指定する', () => {
    const selection = buildSelectionPrompt(sections, '質問');
    assert.doesNotMatch(selection.prompt, /本文a/);
    assert.match(selection.prompt, /最大3つ/);
    assert.match(selection.prompt, /空配列/);
    assert.match(selection.prompt, /一覧に無い ID/);
    assert.doesNotMatch(selection.prompt, /Blind|他者の判定は非表示|キー開封/);
    assert.deepEqual(selection.jsonSchema.required, ['sectionIds']);
    for (const lang of ['ja', 'en'] as const) {
        const answer = buildAnswerPrompt([sections[0]], '質問', lang);
        assert.match(answer, /本文a/);
        assert.doesNotMatch(answer, /本文b/);
        const dataStart = answer.lastIndexOf('\n');
        const instructions = answer.slice(0, dataStart);
        assert.doesNotMatch(instructions, /Blind|他者の判定は非表示|キー開封|http/);
        assert.ok(instructions.includes(lang === 'ja' ? '日本語で答えてください' : "Answer the user's question in English"));
        assert.ok(!instructions.endsWith('\n'));
        const data = JSON.parse(answer.slice(dataStart + 1));
        assert.deepEqual(data, { question: '質問', sections: [{ title: sections[0].title, body: sections[0].body }] });
        assert.ok(data.sections.every((section: Record<string, unknown>) => !('url' in section)));
    }
});

test('未知 ID・重複を落とし、最大三つにする', () => {
    assert.deepEqual(validateSelectedIds('{"sectionIds":["unknown","b","b","a","c","d"]}', sections),
        { status: 'success', sectionIds: ['b', 'a', 'c'] });
    assert.deepEqual(validateSelectedIds({ sectionIds: [] }, sections), { status: 'success', sectionIds: [] });
    for (const raw of ['not JSON', 'null', '{}', '{"sectionIds":"a"}', { sectionIds: [1] }]) {
        assert.deepEqual(validateSelectedIds(raw, sections), { status: 'failure', kind: 'invalid_response' });
    }
});
