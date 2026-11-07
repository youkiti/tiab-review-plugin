// 日本語・英語の検索、重みと安定した順位を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHelpSections } from '../src/lib/help-consult/search';
import type { HelpSection } from '../src/lib/help-consult/types';

function section(id: string, title = '', when: string[] = [], body = ''): HelpSection {
    return { id, title, when, body, level: 3, sectionId: 'group', sectionTitle: 'グループ' };
}

test('日本語二文字組は部分一致し、こんなとき・見出しを優先する', () => {
    const sections = [section('body', '', [], '判定を保存する'), section('title', '判定の保存'),
        section('when', '', ['判定の保存']), section('tie', '', ['判定の保存'])];
    assert.deepEqual(searchHelpSections(sections, '判定 保存', 4).map(item => item.id), ['when', 'tie', 'title', 'body']);
    assert.deepEqual(searchHelpSections(sections, '判定 保存', 1).map(item => item.id), ['when']);
    assert.deepEqual(searchHelpSections(sections, '不存在', 4), []);
    assert.deepEqual(searchHelpSections(sections, '', 4), []);
    assert.deepEqual(searchHelpSections(sections, '判定', 0), []);
});

test('英語は単語境界と大文字小文字を正規化する', () => {
    const sections = [section('one', 'PDF Upload'), section('two', 'uploads'), section('three', '', [], 'upload')];
    assert.deepEqual(searchHelpSections(sections, 'UPLOAD', 3).map(item => item.id), ['one', 'three']);
    assert.deepEqual(searchHelpSections(sections, '   '), []);
});
