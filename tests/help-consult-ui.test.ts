/// <reference path="../src/types/help-sections.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consultDisabledReason, failureMessageKey, buildConsultEnvironment, initialHelpSection, sectionTourIds } from '../src/sidepanel/features/guide/consult/helpers';
import { GUIDE_TOPICS, type GuideTourId } from '../src/lib/guide/topics';
import type { ConsultFailureKind } from '../src/lib/help-consult/types';
import { buildDemoConsultResponse } from '../src/demo/help-consult-fixtures';
import { buildSelectionPrompt, buildAnswerPrompt } from '../src/lib/help-consult/prompt';

test('送信可能条件と無効理由を切り分ける', () => {
    const ready = { loaded: true, provider: 'gemini' as const, batchRunning: false, question: '質問', running: false };
    assert.equal(consultDisabledReason(ready), null);
    for (const [change, reason] of [
        [{ loaded: false }, 'loadFailed'], [{ running: true }, 'running'], [{ provider: null }, 'no_key'],
        [{ batchRunning: true }, 'batchRunning'], [{ question: ' \n ' }, 'empty'],
    ] as const) {
        assert.equal(consultDisabledReason({ ...ready, ...change }), `guideExt_consult_${reason}`);
    }
    assert.equal(consultDisabledReason({ ...ready, provider: null, question: '' }), 'guideExt_consult_no_key');
    assert.equal(consultDisabledReason({ ...ready, batchRunning: true, question: '' }), 'guideExt_consult_batchRunning');
});

test('すべての失敗分類に日英の文言があり、公開用の文言に禁止語を使わない', () => {
    const kinds: ConsultFailureKind[] = ['no_key', 'unsupported_provider', 'rate_limited', 'auth', 'timeout',
        'network', 'invalid_response', 'unknown', 'aborted'];
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(readFileSync(`src/_locales/${lang}/messages.json`, 'utf8'));
        for (const kind of kinds) assert.ok(messages[failureMessageKey(kind)].message);
        for (const [key, value] of Object.entries(messages)) {
            if (key.startsWith('guideExt_consult_')) assert.doesNotMatch((value as { message: string }).message, /Blind|\?{2}/);
        }
    }
});

test('環境情報は指定項目だけを含み、キー値やレビュー情報を取り込まない', () => {
    const base = { version: '0.56.0', uiLang: 'ja', tab: 'llm', topicId: 'ai-model',
        provider: 'openai' as const, configuredProviders: ['openai' as const], errorText: 'auth' as const };
    assert.deepEqual(buildConsultEnvironment(base), {
        version: '0.56.0', platform: 'extension', uiLang: 'ja', screen: 'llm / ai-model', provider: 'openai',
        model: 'gpt-5.6-luna', configuredProviders: ['openai'], errorText: 'auth',
    });
    const none = buildConsultEnvironment({ ...base, provider: null, configuredProviders: [] });
    assert.equal(none.provider, 'none');
    assert.equal(none.model, 'none');
});

test('小節に対応し、現在利用できるツアーだけを重複なく返す', () => {
    const available: GuideTourId[] = ['first-project', 'join-project', 'ai-first-run', 'fulltext-results'];
    for (const topic of Object.values(GUIDE_TOPICS)) {
        const expected = [...new Set(Object.values(GUIDE_TOPICS).flatMap(candidate =>
            candidate.helpAnchor === topic.helpAnchor && 'tourId' in candidate && available.includes(candidate.tourId)
                ? [candidate.tourId] : []))];
        assert.deepEqual(sectionTourIds(topic.helpAnchor, available), expected);
        assert.deepEqual(sectionTourIds(topic.helpAnchor, []), []);
    }
    assert.deepEqual(sectionTourIds('unknown', available), []);
});

const sections = [
    { id: 'pdf', level: 3 as const, sectionId: 'fulltext', sectionTitle: 'Full text', title: 'PDF upload', when: ['Upload a PDF'], body: 'Upload it.' },
    { id: 'share', level: 3 as const, sectionId: 'project', sectionTitle: 'Project', title: 'Share project', when: ['Share with reviewers'], body: 'Share it.' },
    { id: 'annotate', level: 3 as const, sectionId: 'fulltext', sectionTitle: 'Full text', title: 'PDF annotations', when: ['Read a PDF'], body: 'Read it.' },
];

test('最初のヘルプは小節または章の見出しへ正確にリンクする', () => {
    assert.equal(initialHelpSection(sections, 'pdf'), sections[0]);
    const chapter = initialHelpSection(sections, 'fulltext');
    assert.equal(chapter?.id, 'fulltext');
    assert.equal(chapter?.title, 'Full text');
    assert.deepEqual(chapter?.when, []);
    assert.equal(initialHelpSection(sections, 'unknown'), undefined);
});

function responseText(prompt: string, schema?: unknown): string {
    const response = buildDemoConsultResponse({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseSchema: schema } });
    assert.equal(response.candidates[0].finishReason, 'STOP');
    return response.candidates[0].content.parts[0].text;
}

test('デモの小節選択は実際のプロンプトから関連上位最大2件を返す', () => {
    const selection = buildSelectionPrompt(sections, 'PDF upload');
    assert.deepEqual(JSON.parse(responseText(selection.prompt, selection.jsonSchema)), { sectionIds: ['pdf', 'annotate'] });
    const absent = buildSelectionPrompt(sections, 'xyz');
    assert.deepEqual(JSON.parse(responseText(absent.prompt, absent.jsonSchema)), { sectionIds: [] });
    assert.deepEqual(JSON.parse(responseText('invalid', {})), { sectionIds: [] });
    const japanese = buildSelectionPrompt([{ ...sections[0], title: '文献の取り込み', when: ['文献を追加したい'] }], '文献');
    assert.deepEqual(JSON.parse(responseText(japanese.prompt, japanese.jsonSchema)), { sectionIds: ['pdf'] });
});

test('デモの回答は渡された見出しを使い、UI言語に従う', () => {
    assert.match(responseText(buildAnswerPrompt(sections.slice(0, 1), '方法', 'ja')), /「PDF upload」のヘルプ/);
    assert.match(responseText(buildAnswerPrompt(sections.slice(1, 2), 'How?', 'en')), /Open the help sections “Share project”/);
    assert.doesNotMatch(responseText(buildAnswerPrompt(sections.slice(1, 2), 'How?', 'en')), /PDF upload/);
});

test('ヘルプの改行はCRLFに統一されている', () => {
    const source = readFileSync('docs/help.html', 'utf8');
    assert.ok(source.includes('\r\n'));
    assert.doesNotMatch(source.split('\r\n').join(''), /\n/);
});
