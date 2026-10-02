import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    GUIDE_TOPICS,
    GUIDE_VIDEO_ID,
    GUIDE_VIDEO_CHAPTERS,
    HELP_PAGE_URL,
    buildHelpUrl,
    buildVideoUrl,
    guideTopicTitleKey,
    isGuideTopicId,
    type GuideTopic,
    type GuideTopicId,
} from '../src/lib/guide/topics';

/**
 * アプリ内ヘルプ（「?」ボタン）の対応表と docs/help.html・sidepanel.html・messages.json の照合。
 * ヘルプ側の見出しの id を変えたり、カードを足して data-help を付け忘れたりすると、
 * ここで落ちる。
 *
 * テストは .tmp/tests/ 配下にコンパイルされて実行されるため、__dirname ではなく
 * リポジトリルート（npm test の cwd）基準でファイルを解決する。
 */
const ROOT = process.cwd();

function read(...segments: string[]): string {
    return readFileSync(join(ROOT, ...segments), 'utf8');
}

function listFiles(dir: string, extensions: string[]): string[] {
    const result: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            result.push(...listFiles(full, extensions));
        } else if (extensions.some(ext => name.endsWith(ext))) {
            result.push(full);
        }
    }
    return result;
}

const helpHtml = read('docs', 'help.html');
const helpIds = new Set([...helpHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

type Messages = Record<string, { message: string }>;
const jaMessages = JSON.parse(read('src', '_locales', 'ja', 'messages.json')) as Messages;
const enMessages = JSON.parse(read('src', '_locales', 'en', 'messages.json')) as Messages;

test('video を持つトピックは、長編の ID と章の開始秒を指す', () => {
    const starts = new Set<number>(Object.values(GUIDE_VIDEO_CHAPTERS));
    for (const [topicId, topic] of Object.entries<GuideTopic>(GUIDE_TOPICS)) {
        if (!topic.video) continue;
        assert.equal(topic.video.youtubeId, GUIDE_VIDEO_ID, topicId);
        assert.ok(starts.has(topic.video.startSec), topicId);
    }
});

test('トピックと章の対応', () => {
    const expected = {
        'overview': 'intro',
        'login': 'login',
        'project-create': 'login',
        'project-connect': 'login',
        'screening-toolbar': 'manual',
        'screening-filters': 'manual',
        'screening-decisions': 'manual',
        'highlight': 'manual',
        'notes': 'manual',
        'ml': 'ml',
        'ai-model': 'ai',
        'ai-keys': 'ai',
        'ai-criteria': 'ai',
        'ai-batch': 'ai',
        'ai-threshold': 'ai',
        'fulltext-views': 'fulltext',
        'fulltext-candidates': 'fulltext',
        'fulltext-setup': 'fulltext',
        'fulltext-pdf': 'fulltext',
        'fulltext-results': 'fulltext',
        'share': 'sharing',
        'blind': 'sharing',
        'team-progress': 'sharing',
        'consensus': 'sharing',
        'web-app': 'web',
        'settings': 'settings',
    } as const satisfies Partial<Record<GuideTopicId, keyof typeof GUIDE_VIDEO_CHAPTERS>>;
    const videos = Object.entries<GuideTopic>(GUIDE_TOPICS).filter(([, topic]) => topic.video);
    assert.deepEqual(videos.map(([id]) => id).sort(), Object.keys(expected).sort());
    for (const [topicId, topic] of Object.entries<GuideTopic>(GUIDE_TOPICS)) {
        if (Object.prototype.hasOwnProperty.call(expected, topicId)) {
            const chapter = expected[topicId as keyof typeof expected];
            assert.equal(topic.video?.startSec, GUIDE_VIDEO_CHAPTERS[chapter], topicId);
        } else {
            assert.equal(topic.video, undefined, topicId);
        }
    }
});

test('サイトの埋め込みは GUIDE_VIDEO_ID を指す', () => {
    for (const file of ['help.html', 'index.html']) {
        const html = read('docs', file);
        assert.ok(html.includes('https://www.youtube.com/embed/' + GUIDE_VIDEO_ID), file);
        assert.ok(html.includes('https://youtu.be/' + GUIDE_VIDEO_ID), file);
    }
});

test('ヘルプのツアー一覧は、ツアーごとに動画へのリンクを1つ持つ', () => {
    const start = helpHtml.indexOf('<h3 id="getting-started-tours">');
    assert.ok(start >= 0, 'ツアー一覧の見出しが無い');
    const end = helpHtml.indexOf('</ul>', start);
    assert.ok(end > start, 'ツアー一覧の終端が無い');
    const section = helpHtml.slice(start, end + '</ul>'.length);
    const items = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)];
    assert.equal(items.length, 11);
    const ids = items.map(([, item]) => {
        const links = [...item.matchAll(/<a\b[^>]*\bhref="https:\/\/youtu\.be\/([^"]+)"/g)];
        assert.equal(links.length, 1, item);
        assert.notEqual(links[0][1], GUIDE_VIDEO_ID);
        return links[0][1];
    });
    assert.equal(new Set(ids).size, 11);
});

test('GUIDE_TOPICS の helpAnchor はすべて docs/help.html に id として実在する', () => {
    for (const [topicId, topic] of Object.entries(GUIDE_TOPICS)) {
        assert.ok(helpIds.has(topic.helpAnchor), `${topicId} の helpAnchor "${topic.helpAnchor}" が help.html に無い`);
    }
});

test('sidepanel.html の data-help は GUIDE_TOPICS のキーで、GUIDE_TOPICS の全キーが使われている', () => {
    const html = read('src', 'sidepanel', 'sidepanel.html');
    const used = new Set([...html.matchAll(/\bdata-help="([^"]+)"/g)].map(m => m[1]));
    for (const id of used) {
        assert.ok(isGuideTopicId(id), `sidepanel.html の data-help="${id}" が GUIDE_TOPICS に無い`);
    }
    // 実行時に生成する「?」（重複の確認・チーム進捗パネルなど）は TypeScript 側の createGuideHelpButton('<ID>') か dataset.help で指定する
    const dynamicUsed = new Set<string>();
    for (const file of listFiles(join(ROOT, 'src', 'sidepanel'), ['.ts'])) {
        const source = readFileSync(file, 'utf8');
        for (const m of source.matchAll(/\bdataset\.help\s*=\s*'([^']+)'/g)) {
            dynamicUsed.add(m[1]);
        }
        for (const m of source.matchAll(/\bcreateGuideHelpButton\('([^']+)'\)/g)) {
            dynamicUsed.add(m[1]);
        }
    }
    for (const id of dynamicUsed) {
        assert.ok(isGuideTopicId(id), `dataset.help = '${id}' が GUIDE_TOPICS に無い`);
    }
    for (const id of Object.keys(GUIDE_TOPICS)) {
        assert.ok(used.has(id) || dynamicUsed.has(id), `GUIDE_TOPICS の "${id}" を使う data-help が無い`);
    }
});

test('src 配下の help.html#<id> リンクの id はすべて help.html に実在する', () => {
    const files = listFiles(join(ROOT, 'src'), ['.html', '.ts']);
    let found = 0;
    for (const file of files) {
        for (const m of readFileSync(file, 'utf8').matchAll(/help\.html#([A-Za-z0-9_-]+)/g)) {
            found++;
            assert.ok(helpIds.has(m[1]), `${file} の help.html#${m[1]} が help.html に無い`);
        }
    }
    assert.ok(found > 0, 'help.html#<id> のリンクが1件も見つからない（検索が壊れている）');
});

test('help.html の id 付き h2/h3/h4 は日本語・英語の両方の span を持つ', () => {
    const headings = [...helpHtml.matchAll(/<h([234])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)];
    assert.ok(headings.length > 50, `id 付きの見出しが ${headings.length} 件しか見つからない`);
    for (const [, , id, inner] of headings) {
        assert.match(inner, /class="ja"/, `#${id} に class="ja" の span が無い`);
        assert.match(inner, /class="en"/, `#${id} に class="en" の span が無い`);
    }
});

/** `$1` 形式と `$NAME$` 形式のプレースホルダを集める */
function placeholdersOf(message: string): string[] {
    const found = new Set<string>();
    for (const m of message.matchAll(/\$(\d+)|\$([A-Za-z_@][A-Za-z0-9_@]*)\$/g)) {
        found.add(m[1] !== undefined ? `$${m[1]}` : `$${m[2].toUpperCase()}$`);
    }
    return [...found].sort();
}

test('ja と en の messages.json はキー集合とプレースホルダ集合が一致する', () => {
    const jaKeys = Object.keys(jaMessages).sort();
    const enKeys = Object.keys(enMessages).sort();
    assert.deepEqual(
        jaKeys.filter(key => !(key in enMessages)),
        [],
        'ja にあって en に無いキー',
    );
    assert.deepEqual(
        enKeys.filter(key => !(key in jaMessages)),
        [],
        'en にあって ja に無いキー',
    );
    for (const key of jaKeys) {
        assert.deepEqual(
            placeholdersOf(jaMessages[key].message),
            placeholdersOf(enMessages[key].message),
            `${key} のプレースホルダが ja と en で異なる`,
        );
    }
});

test('拡張専用トピックは guideExt_topic_*、それ以外は guide_topic_* の見出しが ja/en の両方にある', () => {
    let extensionOnlyCount = 0;
    for (const [topicId, topic] of Object.entries<GuideTopic>(GUIDE_TOPICS)) {
        const suffix = topicId.replace(/-/g, '_');
        const [expected, other] = topic.extensionOnly
            ? [`guideExt_topic_${suffix}`, `guide_topic_${suffix}`]
            : [`guide_topic_${suffix}`, `guideExt_topic_${suffix}`];
        if (topic.extensionOnly) extensionOnlyCount++;
        for (const [lang, messages] of [['ja', jaMessages], ['en', enMessages]] as const) {
            assert.ok(messages[expected]?.message, `${lang} に ${expected} が無い`);
            assert.ok(!(other in messages), `${lang} に余分な ${other} がある`);
        }
        assert.equal(guideTopicTitleKey(topicId as GuideTopicId), expected);
    }
    assert.ok(extensionOnlyCount > 0, 'extensionOnly のトピックが1件も無い');
});

test('buildHelpUrl / buildVideoUrl は期待する URL を返す', () => {
    assert.equal(HELP_PAGE_URL, 'https://youkiti.github.io/tiab-review-plugin/help.html');
    assert.equal(
        buildHelpUrl('screening-filters', 'ja'),
        'https://youkiti.github.io/tiab-review-plugin/help.html?lang=ja#screening-filters',
    );
    assert.equal(
        buildHelpUrl('project-create', 'en'),
        'https://youkiti.github.io/tiab-review-plugin/help.html?lang=en#login-create-project',
    );
    assert.equal(buildVideoUrl({ youtubeId: 'abc123', startSec: 95 }), 'https://youtu.be/abc123?t=95');
    assert.equal(isGuideTopicId('login'), true);
    assert.equal(isGuideTopicId('toString'), false);
    assert.equal(isGuideTopicId('no-such-topic'), false);
});
