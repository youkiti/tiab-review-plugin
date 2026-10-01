import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOURS, type GuideEventName } from '../src/lib/guide/tours';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../src/lib/guide/tour-progress';
import { GUIDE_TOPICS, type GuideTopic } from '../src/lib/guide/topics';

/**
 * ツアーの定義（src/lib/guide/tours.ts）と、画面（sidepanel.html・TypeScript）・messages.json の照合。
 * UI を変えてもツアーが黙って壊れないよう、対象の要素・文言・イベントの送出元の実在を検査する。
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

const html = read('src', 'sidepanel', 'sidepanel.html');
const tours = Object.values(GUIDE_TOURS);

test('静的な対象は sidepanel.html に data-tour として実在する', () => {
    const present = new Set([...html.matchAll(/\bdata-tour="([^"]+)"/g)].map(m => m[1]));
    for (const tour of tours) {
        for (const step of tour.steps) {
            if (step.dynamicTarget) continue;
            assert.ok(present.has(step.target), `${tour.id}/${step.id} の対象 data-tour="${step.target}" が sidepanel.html に無い`);
        }
    }
});

test('dynamicTarget の対象は、TypeScript に data-tour を付けるコードが実在する', () => {
    const sources = listFiles(join(ROOT, 'src'), ['.ts']).map(file => readFileSync(file, 'utf8'));
    for (const tour of tours) {
        for (const step of tour.steps) {
            if (!step.dynamicTarget) continue;
            const pattern = new RegExp(
                `setAttribute\\(\\s*'data-tour'\\s*,\\s*'${step.target}'\\s*\\)|dataset\\.tour\\s*=\\s*'${step.target}'`,
            );
            assert.ok(
                sources.some(source => pattern.test(source)),
                `${tour.id}/${step.id} の動的な対象 "${step.target}" に data-tour を付けるコードが src に無い`,
            );
        }
    }
});

test('ツアーの見出し・説明・各手順の本文が ja の messages.json にある', () => {
    const ja = JSON.parse(read('src', '_locales', 'ja', 'messages.json')) as Record<string, { message: string }>;
    for (const tour of tours) {
        const keys = [tour.titleKey, tour.descriptionKey, ...tour.steps.map(step => step.textKey)];
        for (const key of keys) {
            assert.ok(ja[key]?.message, `${tour.id} のキー ${key} が ja の messages.json に無い`);
        }
    }
});

test('拡張版でしか出ないツアーのキーは guideExt_、Web 版でも出るツアーは guide_ の接頭辞', () => {
    for (const tour of tours) {
        const webToo = tour.platforms.includes('web');
        const prefix = webToo ? 'guide_' : 'guideExt_';
        const keys = [tour.titleKey, tour.descriptionKey, ...tour.steps.map(step => step.textKey)];
        for (const key of keys) {
            assert.ok(key.startsWith(prefix), `${tour.id} のキー ${key} は ${prefix} で始まるべき`);
        }
    }
});

interface HtmlElementInfo {
    id: string | null;
    dataTour: string | null;
    ancestorIds: string[];
}

/** sidepanel.html の要素を、id・data-tour・祖先の id 付きで並べる（コメントと script/style は除く）。 */
function parseHtmlElements(source: string): HtmlElementInfo[] {
    const cleaned = source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
    const voidTags = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
    const stack: { tag: string; id: string | null }[] = [];
    const elements: HtmlElementInfo[] = [];
    for (const match of cleaned.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
        const [, closing, tagRaw, attributes] = match;
        const tag = tagRaw.toLowerCase();
        if (closing) {
            const index = stack.map(entry => entry.tag).lastIndexOf(tag);
            if (index >= 0) stack.length = index;
            continue;
        }
        const id = /\bid="([^"]+)"/.exec(attributes)?.[1] ?? null;
        const dataTour = /\bdata-tour="([^"]+)"/.exec(attributes)?.[1] ?? null;
        elements.push({ id, dataTour, ancestorIds: stack.map(entry => entry.id).filter((v): v is string => v !== null) });
        if (!voidTags.has(tag) && !attributes.trimEnd().endsWith('/')) stack.push({ tag, id });
    }
    return elements;
}

/** bootstrap.ts が capabilities で隠す要素の id（dom.ts の getter を id に引き直す）。 */
function hiddenByCapabilities(): Set<string> {
    const dom = read('src', 'sidepanel', 'dom.ts');
    const idByGetter = new Map<string, string>();
    for (const m of dom.matchAll(/get (\w+)\(\)\s*\{\s*return getElement<[^>]+>\('([^']+)'\)/g)) {
        idByGetter.set(m[1], m[2]);
    }
    const bootstrap = read('src', 'sidepanel', 'bootstrap.ts');
    const hidden = new Set<string>();
    for (const m of bootstrap.matchAll(/dom\.(\w+)\??\.classList\.add\('hidden'\)/g)) {
        const id = idByGetter.get(m[1]);
        assert.ok(id, `bootstrap.ts の dom.${m[1]} を dom.ts の getter から id に引けない（テストの解釈が古い）`);
        hidden.add(id);
    }
    assert.ok(hidden.size > 0, 'bootstrap.ts に capabilities で隠す要素が1つも見つからない（検索が壊れている）');
    return hidden;
}

test('Web 版でも出るツアーの静的な対象は、Web 版で隠される要素（とその中身）に依存しない', () => {
    const hidden = hiddenByCapabilities();
    const elements = parseHtmlElements(html);
    for (const tour of tours) {
        if (!tour.platforms.includes('web')) continue;
        for (const step of tour.steps) {
            if (step.dynamicTarget) continue;
            const targets = elements.filter(element => element.dataTour === step.target);
            assert.ok(targets.length > 0, `${tour.id}/${step.id} の対象 "${step.target}" が見つからない`);
            // 同じ data-tour の要素のうち、1つでも Web 版で隠れない場所にあればよい（ランナーは表示中のものを選ぶ）
            const visibleOnWeb = targets.some(element =>
                !(element.id !== null && hidden.has(element.id))
                && !element.ancestorIds.some(id => hidden.has(id)));
            assert.ok(visibleOnWeb, `${tour.id}/${step.id} の対象 "${step.target}" は Web 版で隠される要素の中にある`);
        }
    }
});

test('topics.ts の tourId はすべて GUIDE_TOURS に実在する', () => {
    let count = 0;
    for (const [topicId, topic] of Object.entries<GuideTopic>(GUIDE_TOPICS)) {
        if (!topic.tourId) continue;
        count++;
        assert.ok(topic.tourId in GUIDE_TOURS, `トピック ${topicId} の tourId "${topic.tourId}" が GUIDE_TOURS に無い`);
    }
    assert.ok(count > 0, 'tourId を持つトピックが1つも無い');
});

test('手順の進め方: events の手順は1つ以上のイベントを持ち、すべてのイベントを画面側のどこかが送る', () => {
    const emitted = new Set<string>();
    for (const file of listFiles(join(ROOT, 'src', 'sidepanel'), ['.ts'])) {
        for (const m of readFileSync(file, 'utf8').matchAll(/emitGuideEvent\('([a-z-]+)'\)/g)) emitted.add(m[1]);
    }
    const used = new Set<GuideEventName>();
    for (const tour of tours) {
        for (const step of tour.steps) {
            if (step.advance.type !== 'events') continue;
            assert.ok(step.advance.events.length > 0, `${tour.id}/${step.id} の events が空`);
            step.advance.events.forEach(event => used.add(event));
        }
    }
    for (const event of used) {
        assert.ok(emitted.has(event), `イベント "${event}" を emitGuideEvent で送るコードが src/sidepanel に無い`);
    }
});

test('初期バンドルの入口 lazy.ts は、ツアーの本体（tours.ts・tour-progress.ts）を値として import しない', () => {
    const lazy = read('src', 'sidepanel', 'features', 'guide', 'lazy.ts');
    for (const m of lazy.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)) {
        assert.doesNotMatch(m[1], /lib\/guide\//, `lazy.ts が ${m[1]} を値として import している（初期バンドルに入る）`);
    }
    // 保存キーの値は lazy.ts が自前で持つので、定数と一致していること
    const key = /const GUIDE_PROGRESS_KEY = '([^']+)'/.exec(lazy)?.[1];
    assert.equal(key, GUIDE_PROGRESS_STORAGE_KEY);
});

test('ツアーの手順 ID はツアー内で重複しない', () => {
    for (const tour of tours) {
        const ids = tour.steps.map(step => step.id);
        assert.equal(new Set(ids).size, ids.length, `${tour.id} に重複した手順 ID がある`);
    }
});
