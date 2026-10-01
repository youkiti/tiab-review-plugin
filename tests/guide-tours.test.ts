import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOURS, type GuideEventName, type TourDefinition } from '../src/lib/guide/tours';
import { GUIDE_PROGRESS_STORAGE_KEY, availableTours } from '../src/lib/guide/tour-progress';
import { GUIDE_TOPICS, type GuideTopic } from '../src/lib/guide/topics';

/**
 * ツアーの定義（src/lib/guide/tours/）と、画面（sidepanel.html・fulltext.html・TypeScript）・messages.json の照合。
 * UI を変えてもツアーが黙って壊れないよう、対象の要素・文言・イベントの送出元の実在を検査する。
 *
 * draft（まだ中身の無い枠）のツアーは、対象・各手順の文言・イベントの照合から外す（見出しと説明のキーの実在だけは見る）。
 * page が 'fulltext' のツアーの対象は、sidepanel.html ではなく src/fulltext/fulltext.html（と src/fulltext/ の TypeScript）で照合する。
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
const fulltextHtml = read('src', 'fulltext', 'fulltext.html');
/** 全ツアー（draft の枠を含む）。見出し・説明のキーと、draft の性質の検査にだけ使う。 */
const allTours: TourDefinition[] = Object.values(GUIDE_TOURS);
/** 中身のあるツアー。対象・文言・イベントの照合はこちらだけ。 */
const tours: TourDefinition[] = allTours.filter(tour => !tour.draft);
const sidepanelTours = tours.filter(tour => tour.page === 'sidepanel');

/** そのツアーが動く画面の HTML（page 'fulltext' は src/fulltext/fulltext.html）。 */
function htmlOf(tour: TourDefinition): string {
    return tour.page === 'fulltext' ? fulltextHtml : html;
}

/** そのツアーの画面を作る TypeScript のあるディレクトリ。動的な対象を探す範囲。 */
function sourceDirOf(tour: TourDefinition): string {
    return tour.page === 'fulltext' ? join(ROOT, 'src', 'fulltext') : join(ROOT, 'src');
}

test('静的な対象は、そのツアーが動く画面の HTML に data-tour として実在する', () => {
    for (const tour of tours) {
        const present = new Set([...htmlOf(tour).matchAll(/\bdata-tour="([^"]+)"/g)].map(m => m[1]));
        const file = tour.page === 'fulltext' ? 'fulltext.html' : 'sidepanel.html';
        for (const step of tour.steps) {
            if (step.dynamicTarget) continue;
            assert.ok(present.has(step.target), `${tour.id}/${step.id} の対象 data-tour="${step.target}" が ${file} に無い`);
        }
    }
});

test('dynamicTarget の対象は、TypeScript に data-tour を付けるコードが実在する', () => {
    for (const tour of tours) {
        const sources = listFiles(sourceDirOf(tour), ['.ts']).map(file => readFileSync(file, 'utf8'));
        for (const step of tour.steps) {
            if (!step.dynamicTarget) continue;
            const pattern = new RegExp(
                `setAttribute\\(\\s*'data-tour'\\s*,\\s*'${step.target}'\\s*\\)|dataset\\.tour\\s*=\\s*'${step.target}'`,
            );
            assert.ok(
                sources.some(source => pattern.test(source)),
                `${tour.id}/${step.id} の動的な対象 "${step.target}" に data-tour を付けるコードが ${tour.page === 'fulltext' ? 'src/fulltext' : 'src'} に無い`,
            );
        }
    }
});

test('ツアーの見出し・説明（draft を含む）と、draft でないツアーの各手順の本文が ja/en の messages.json にある', () => {
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(read('src', '_locales', lang, 'messages.json')) as Record<string, { message: string }>;
        for (const tour of allTours) {
            const keys = [tour.titleKey, tour.descriptionKey, ...tour.steps.map(step => step.textKey)];
            for (const key of keys) {
                assert.ok(messages[key]?.message, `${tour.id} のキー ${key} が ${lang} の messages.json に無い`);
            }
        }
    }
});

test('messages.json は、ツアーごとに title → desc → 手順の本文の順で1つの連続した区画になり、区画は重ならない', () => {
    for (const lang of ['ja', 'en']) {
        const keys = Object.keys(JSON.parse(read('src', '_locales', lang, 'messages.json')) as Record<string, unknown>);
        const ranges: { id: string; first: number; last: number }[] = [];
        for (const tour of allTours) {
            const own = [tour.titleKey, tour.descriptionKey, ...tour.steps.map(step => step.textKey)];
            const positions = own.map(key => keys.indexOf(key));
            assert.ok(positions.every(position => position >= 0), `${lang}: ${tour.id} のキーが messages.json に無い`);
            const first = Math.min(...positions);
            const last = Math.max(...positions);
            assert.equal(last - first + 1, own.length, `${lang}: ${tour.id} のキーが連続していない`);
            assert.equal(keys[first], tour.titleKey, `${lang}: ${tour.id} の区画は title から始まる`);
            assert.equal(keys[first + 1], tour.descriptionKey, `${lang}: ${tour.id} の title の次は desc`);
            ranges.push({ id: tour.id, first, last });
        }
        ranges.sort((a, b) => a.first - b.first);
        for (let i = 1; i < ranges.length; i += 1) {
            assert.ok(ranges[i - 1].last < ranges[i].first, `${lang}: ${ranges[i - 1].id} と ${ranges[i].id} の区画が重なっている`);
        }
    }
});

test('拡張版でしか出ないツアーのキーは guideExt_、Web 版でも出るツアーは guide_ の接頭辞', () => {
    for (const tour of allTours) {
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
    for (const tour of sidepanelTours) {
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

test('サイドパネルのトピックの tourId は page が sidepanel のツアーだけ。draft のツアーの開始ボタンは吹き出しに出ない', () => {
    const usable = new Set(availableTours({ platform: 'extension', capabilities: { createProject: true } }).map(tour => tour.id));
    for (const [topicId, topic] of Object.entries<GuideTopic>(GUIDE_TOPICS)) {
        if (!topic.tourId) continue;
        const tour = GUIDE_TOURS[topic.tourId];
        assert.equal(tour.page, 'sidepanel', `トピック ${topicId} の tourId "${topic.tourId}" は全文の判定ページのツアー`);
        // 吹き出しの開始ボタンは features/guide/index.ts が availableTours に含まれるときだけ出す
        if (tour.draft) assert.equal(usable.has(tour.id), false, `${tour.id} は draft なのに使えるツアーに入っている`);
    }
    const guideIndex = read('src', 'sidepanel', 'features', 'guide', 'index.ts');
    assert.match(guideIndex, /tourId && availableTours\(currentGuidePlatform\(\)\)\.some\(tour => tour\.id === tourId\)/);
});

test('lazy.ts の SUGGEST_TOUR_BY_EVENT は、ツアー定義の suggestOn（draft を含む）と一致する', () => {
    const lazy = read('src', 'sidepanel', 'features', 'guide', 'lazy.ts');
    const block = /const SUGGEST_TOUR_BY_EVENT[^=]*=\s*\{([\s\S]*?)\};/.exec(lazy)?.[1];
    assert.ok(block, 'lazy.ts に SUGGEST_TOUR_BY_EVENT が見つからない');
    const table = new Map<string, string>();
    for (const m of block.matchAll(/'(tab-opened-[a-z]+)':\s*'([a-z-]+)'/g)) table.set(m[1], m[2]);
    const defined = new Map<string, string>();
    for (const tour of allTours) {
        if (!tour.suggestOn) continue;
        assert.equal(defined.has(tour.suggestOn), false, `${tour.suggestOn} を suggestOn に持つツアーが複数ある（lazy.ts の対応表は1対1）`);
        defined.set(tour.suggestOn, tour.id);
    }
    assert.deepEqual([...table].sort(), [...defined].sort(), 'lazy.ts の対応表とツアー定義の suggestOn が食い違っている');
    assert.ok(table.size > 0);
});

/** dir 配下の TypeScript が emitGuideEvent('<名前>') で送るイベント名。 */
function emittedEventsIn(dir: string): Set<string> {
    const emitted = new Set<string>();
    for (const file of listFiles(dir, ['.ts'])) {
        for (const m of readFileSync(file, 'utf8').matchAll(/emitGuideEvent\('([a-z-]+)'\)/g)) emitted.add(m[1]);
    }
    return emitted;
}

test('手順の進め方・提案: events の手順は1つ以上のイベントを持ち、使うイベント（suggestOn を含む）はすべて画面側のどこかが送る', () => {
    const emittedBySidepanel = emittedEventsIn(join(ROOT, 'src', 'sidepanel'));
    // 全文の判定ページのツアーは、全文の判定ページ側かサイドパネル側のどちらかが送ればよい
    const emittedByFulltext = new Set([...emittedBySidepanel, ...emittedEventsIn(join(ROOT, 'src', 'fulltext'))]);
    for (const tour of tours) {
        const emitted = tour.page === 'fulltext' ? emittedByFulltext : emittedBySidepanel;
        const used = new Set<GuideEventName>();
        if (tour.suggestOn) used.add(tour.suggestOn);
        for (const step of tour.steps) {
            if (step.advance.type !== 'events') continue;
            assert.ok(step.advance.events.length > 0, `${tour.id}/${step.id} の events が空`);
            step.advance.events.forEach(event => used.add(event));
        }
        for (const event of used) {
            assert.ok(emitted.has(event), `${tour.id}: イベント "${event}" を emitGuideEvent で送るコードが無い`);
        }
    }
});

test('タブを開いたイベント（tab-opened-*）は、サイドパネル側が送る', () => {
    const emitted = emittedEventsIn(join(ROOT, 'src', 'sidepanel'));
    for (const event of ['tab-opened-screening', 'tab-opened-ml', 'tab-opened-llm', 'tab-opened-fulltext']) {
        assert.ok(emitted.has(event), `イベント "${event}" を emitGuideEvent で送るコードが src/sidepanel に無い`);
    }
});

test('draft のツアーには手順が無く、draft でないツアーには手順が1つ以上ある', () => {
    for (const tour of allTours) {
        if (tour.draft) {
            assert.equal(tour.steps.length, 0, `${tour.id} は draft なのに手順がある（手順を書いたら draft を外す）`);
        } else {
            assert.ok(tour.steps.length >= 1, `${tour.id} は draft でないのに手順が無い`);
        }
    }
    assert.ok(tours.length >= 2, 'draft でないツアーが2本未満（検査が空振りしている）');
});

test('page が fulltext のツアーは拡張版だけ。suggestOn はタブを開いたイベントで、サイドパネルのツアーにだけ付く', () => {
    for (const tour of allTours) {
        if (tour.page === 'fulltext') {
            assert.deepEqual([...tour.platforms], ['extension'], `${tour.id}: 全文の判定ページは拡張版だけ`);
        }
        if (tour.suggestOn === undefined) continue;
        assert.ok(tour.suggestOn.startsWith('tab-opened-'), `${tour.id}: suggestOn は今のところタブを開いたイベントだけ（提案の帯の出し先がタブごとに決まっている）`);
        assert.equal(tour.page, 'sidepanel', `${tour.id}: suggestOn はサイドパネルのツアーだけ`);
    }
});

test('初期バンドルの入口 lazy.ts は、ツアーの本体（tours/・tour-progress.ts）を値として import しない', () => {
    const lazy = read('src', 'sidepanel', 'features', 'guide', 'lazy.ts');
    for (const m of lazy.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)) {
        assert.doesNotMatch(m[1], /lib\/guide\//, `lazy.ts が ${m[1]} を値として import している（初期バンドルに入る）`);
    }
    // 保存キーの値は lazy.ts が自前で持つので、定数と一致していること
    const key = /const GUIDE_PROGRESS_KEY = '([^']+)'/.exec(lazy)?.[1];
    assert.equal(key, GUIDE_PROGRESS_STORAGE_KEY);
});

test('ツアーの手順 ID はツアー内で重複しない', () => {
    for (const tour of allTours) {
        const ids = tour.steps.map(step => step.id);
        assert.equal(new Set(ids).size, ids.length, `${tour.id} に重複した手順 ID がある`);
    }
});

test('data-tour="tour-list" は ❓ の「?」吹き出しボタン（data-help 付き）にだけ付き、画面上部に 🧭 のボタンを置かない', () => {
    const buttons = [...html.matchAll(/<button\b[^>]*\bdata-tour="tour-list"[^>]*>[^<]*<\/button>/g)].map(m => m[0]);
    assert.ok(buttons.length >= 2, 'ツアー一覧の入口の ❓ が2つ（プロジェクト選択画面・ツールバー）無い');
    for (const button of buttons) {
        const helpId = /\bdata-help="([^"]+)"/.exec(button)?.[1];
        assert.ok(helpId, `data-tour="tour-list" の要素が data-help を持たない: ${button}`);
        const topic: GuideTopic | undefined = (GUIDE_TOPICS as Record<string, GuideTopic>)[helpId];
        assert.equal(topic?.tourList, true, `トピック "${helpId}" に tourList: true が無い`);
        assert.doesNotMatch(button, /🧭/, '🧭 を画面のボタンにしてはいけない');
    }
    // data-tour="tour-list" を持つ要素は、ボタン以外（リンク等）では書かない
    assert.equal([...html.matchAll(/\bdata-tour="tour-list"/g)].length, buttons.length);
    assert.doesNotMatch(html, /🧭/);
});

test('tourList: true のトピックは、プロジェクト選択画面とツールバーの ❓ に使われ、吹き出しのボタンの文言が ja/en にある', () => {
    const topicIds = Object.entries<GuideTopic>(GUIDE_TOPICS).filter(([, topic]) => topic.tourList).map(([id]) => id);
    assert.deepEqual(topicIds.sort(), ['overview', 'screening-toolbar']);
    for (const id of topicIds) {
        assert.match(html, new RegExp(`data-help="${id}"[^>]*data-tour="tour-list"`), `${id} の ❓ に data-tour="tour-list" が無い`);
    }
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(read('src', '_locales', lang, 'messages.json')) as Record<string, { message: string }>;
        assert.ok(messages.guide_tourListAction?.message, `${lang} に guide_tourListAction が無い`);
    }
});

test('入口の文言（押さずに次へ・タブの提案の帯・全文タブの案内）が ja/en にある', () => {
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(read('src', '_locales', lang, 'messages.json')) as Record<string, { message: string }>;
        for (const key of ['guide_tourSkip', 'guide_tabSuggestStart', 'guide_tabSuggestDismiss', 'guideExt_tourOpenFulltextHint']) {
            assert.ok(messages[key]?.message, `${lang} に ${key} が無い`);
        }
    }
});

test('join-project は decide の前に、文献カードを「次へ」で読ませる read 手順を持つ', () => {
    for (const tourId of ['first-project', 'join-project'] as const) {
        const steps = GUIDE_TOURS[tourId].steps;
        const read = steps.findIndex(step => step.id === 'read');
        const decide = steps.findIndex(step => step.id === 'decide');
        assert.ok(read >= 0 && read < decide, `${tourId}: read が decide の前に無い`);
        assert.equal(steps[read].target, 'reference-card');
        assert.equal(steps[read].advance.type, 'next');
        assert.equal(steps[read].scroll, 'start', `${tourId}/read は文献カードの先頭へスクロールする`);
        assert.equal(steps[decide].scroll, 'if-hidden', `${tourId}/decide は判定ボタンが見えているならスクロールしない`);
    }
});
