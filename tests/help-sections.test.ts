// 手書き HTML と実物で言語別の小節抽出を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HelpSection } from '../src/lib/help-consult/types';

const loadModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const modulePromise = loadModule(pathToFileURL(path.resolve('scripts/webpack/help-sections.cjs')).href);
const html = `<section id="group" class="help-section">
<h2><span class="ja">大見出し</span><span class="en">Group</span></h2>
<h3 id="first"><span class="ja">親<span class="x">の</span>見出し</span><span class="en">Parent</span></h3>
<div class="help-when"><ul><li><span class="ja">困った<span>とき</span></span><span class="en">When stuck</span></li></ul></div>
<p><span class="ja">日本<span class="x">語</span>の本文</span><span class="lang-sep"> / </span>
<span class="en">English <span>body</span> only</span> &amp; &#65; &#x42;</p>
<table><tr><td>shared</td><td><code>code</code></td></tr></table><script>secret</script><style>hidden</style>
<h4 id="child"><span class="ja">子</span><span class="en">Child</span></h4>
<p><a href="https://example.com">link</a></p>
<h3 id="last">Shared title</h3><p>last body</p></section>`;

test('入れ子の言語 span・囲み・表・h4・実体参照を抽出する', async () => {
    const { parseHelpSections, default: loader } = await modulePromise;
    const ja: HelpSection[] = parseHelpSections(html, 'ja');
    const en: HelpSection[] = parseHelpSections(html, 'en');
    assert.deepEqual(ja.map(section => section.id), ['first', 'child', 'last']);
    assert.equal(ja[0].title, '親の見出し');
    assert.equal(ja[0].sectionTitle, '大見出し');
    assert.equal(ja[0].sectionId, 'group');
    assert.deepEqual(ja[0].when, ['困ったとき']);
    assert.deepEqual(en[0].when, ['When stuck']);
    assert.equal(ja[0].body, '日本語の本文 & A B shared code');
    assert.equal(en[0].body, 'English body only & A B shared code');
    assert.equal(ja[1].level, 4);
    assert.equal(ja[1].body, 'link');
    assert.deepEqual(ja[1].when, []);
    assert.deepEqual(JSON.parse(loader.call({ resourceQuery: '?help-sections&lang=ja' }, html).slice('module.exports = '.length, -1)), ja);
    assert.throws(() => parseHelpSections(html, 'fr'));
});

test('実物の全小節と「こんなとき」の件数・本文を両言語で検証する', async () => {
    const { parseHelpSections } = await modulePromise;
    const source = readFileSync('docs/help.html', 'utf8');
    const ids = [...source.matchAll(/<h[34] id="([^"]+)"/g)].map(match => match[1]);
    const whenCount = [...source.matchAll(/<div class="help-when">/g)].length;
    assert.equal(ids.length, 65);
    assert.equal(whenCount, 52);
    for (const lang of ['ja', 'en']) {
        const sections: HelpSection[] = parseHelpSections(source, lang);
        assert.deepEqual(sections.map(section => section.id), ids);
        assert.equal(sections.filter(section => section.when.length > 0).length, whenCount);
        for (const section of sections) {
            assert.ok(section.title.trim(), `${lang}: ${section.id} の見出し`);
            assert.ok(section.body.trim(), `${lang}: ${section.id} の本文`);
            // 元の実体参照が表す文字は本文に残し、HTML タグの取り残しだけを検査する。
            const literalAngles = [...source.matchAll(/&lt;([^&]*?)&gt;/g)].map(match => `<${match[1]}>`);
            let withoutLiterals = section.body;
            for (const literal of literalAngles) {
                withoutLiterals = withoutLiterals.split(literal).join('');
            }
            assert.doesNotMatch(withoutLiterals, /<|help-when/);
        }
        if (lang === 'ja') {
            assert.doesNotMatch(sections.find(section => section.id === 'screening-toolbar')!.body, /Toolbar/);
        }
    }
});
