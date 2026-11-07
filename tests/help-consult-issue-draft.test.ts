// 公開下書きの伏せ字・URL 許可範囲・長さとエンコードを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssueDraft, sanitizeForIssue } from '../src/lib/help-consult/issue-draft';

const environment = {
    version: '0.56.0', platform: 'extension' as const, uiLang: 'ja', screen: 'help', provider: 'gemini',
    model: 'gemini-3.1-flash-lite', configuredProviders: ['gemini'], errorText: '連絡先 user@example.org',
};

test('メール・外部 URL・長いキー断片を伏せ、正規のリポジトリ URL は残す', () => {
    for (const value of ['user+test@example.org', 'https://example.org/sheet?id=abc', 'http://localhost:123/a',
        'Abcdef1234567890_-ABC', 'https://github.com/youkiti/tiab-review-plugin-fake/a',
        'https://youkiti.github.io.evil/tiab-review-plugin/help', 'https://github.com/other/repo']) {
        assert.equal(sanitizeForIssue(value), '[REDACTED]', value);
    }
    for (const value of ['https://github.com/youkiti/tiab-review-plugin/issues/1',
        'https://youkiti.github.io/tiab-review-plugin/help.html?lang=ja#screening']) {
        assert.equal(sanitizeForIssue(value), value);
    }
    assert.equal(sanitizeForIssue('short-id 123'), 'short-id 123');
});

test('長い小節 ID を含むヘルプリンクを残し、隣のキー断片は伏せる', () => {
    const link = 'https://youkiti.github.io/tiab-review-plugin/help.html?lang=ja#getting-started-reference-files';
    assert.equal(sanitizeForIssue(`見て ${link} と sk-abcdefghijklmnopqrstuvwxyz`), `見て ${link} と [REDACTED]`);
});

test('全入力を伏せてコピー文面と URL を一致させる', () => {
    const draft = createIssueDraft({ question: '質問 & # ? user@example.org', answer: 'https://private.test/data', environment });
    const parsed = new URL(draft.url);
    assert.equal(parsed.searchParams.get('title'), draft.title);
    assert.equal(parsed.searchParams.get('body'), draft.body);
    assert.doesNotMatch(draft.body + draft.title, /user@example|private.test/);
    assert.match(draft.body, /公開の Issue/);
    assert.match(draft.body, /public Issue/);
    assert.match(draft.body, /0.56.0/);
    assert.ok(draft.url.includes('%26'));
});

test('日本語と絵文字の長い入力でも URL は上限内で、短縮を明示する', () => {
    const draft = createIssueDraft({ question: '困りました😀'.repeat(20000), answer: '回答'.repeat(20000), environment });
    assert.ok(draft.url.length <= 8000);
    assert.match(draft.body, /省略しました/);
    assert.equal(new URL(draft.url).searchParams.get('body'), draft.body);
    assert.ok(createIssueDraft({ question: '短い質問', environment }).url.length <= 8000);
});
