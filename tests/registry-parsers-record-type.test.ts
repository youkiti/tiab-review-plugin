import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCTG } from '../src/lib/ctg-parser';
import { parseICTRP } from '../src/lib/ictrp-parser';

// Issue #118 チャンク1: CTG/ICTRP パーサが record_type: 'registration' を確定で書き込むことの回帰テスト。
// 他のパーサ（RIS/EndNote等）は対象外（未設定 = article 相当のフォールバックで動く。変更しない）。

test('parseCTG: 生成する Reference に record_type: registration が確定で入る', () => {
    const csv = [
        'NCT Number,Study Title,Study URL,Start Date',
        '"NCT00000001","A Sample Trial","https://clinicaltrials.gov/study/NCT00000001","2024-01-01"',
    ].join('\n');

    const refs = parseCTG(csv, 'ctg-sample.csv');

    assert.equal(refs.length, 1);
    assert.equal(refs[0].record_type, 'registration');
    assert.equal(refs[0].journal, 'ClinicalTrials.gov');
});

test('parseCTG: タイトルが無い行はそもそも Reference を生成しない（従来挙動）', () => {
    const csv = [
        'NCT Number,Study Title,Study URL,Start Date',
        '"NCT00000002","","",""',
    ].join('\n');

    const refs = parseCTG(csv, 'ctg-sample.csv');

    assert.equal(refs.length, 0);
});

// ---------------------------------------------------------------------------
// parseICTRP は DOMParser（ブラウザAPI）に依存するため、node --test 実行環境向けに
// このテストファイル内だけで有効な最小限のフェイク DOMParser を用意する。
// ICTRP XML はフラットな子要素のみ（ネストなし）という実際の輸出フォーマットの前提に限定した
// 簡易実装であり、本番コード（src/lib/ictrp-parser.ts）は一切変更していない。
// ---------------------------------------------------------------------------

interface FakeElement {
    tagName: string;
    textContent: string;
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

class FakeTrialElement {
    constructor(private readonly elements: FakeElement[]) {}
    get children(): FakeElement[] {
        return this.elements;
    }
    querySelector(tag: string): FakeElement | null {
        return this.elements.find((el) => el.tagName === tag) ?? null;
    }
}

class FakeDocument {
    constructor(private readonly trials: FakeTrialElement[]) {}
    querySelector(_selector: string): null {
        return null; // parsererror は常に無し（テストデータは常に整形式のため）
    }
    querySelectorAll(selector: string): FakeTrialElement[] {
        return selector === 'Trial' ? this.trials : [];
    }
}

class FakeDOMParser {
    parseFromString(content: string): FakeDocument {
        const trialBlocks = [...content.matchAll(/<Trial>([\s\S]*?)<\/Trial>/g)].map((m) => m[1]);
        const trials = trialBlocks.map((block) => {
            const tagMatches = [...block.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)];
            const elements = tagMatches.map(([, tagName, text]) => ({
                tagName,
                textContent: decodeXmlEntities(text.trim()),
            }));
            return new FakeTrialElement(elements);
        });
        return new FakeDocument(trials);
    }
}

test('parseICTRP: 生成する Reference に record_type: registration が確定で入る', () => {
    const originalDOMParser = (globalThis as { DOMParser?: unknown }).DOMParser;
    (globalThis as { DOMParser?: unknown }).DOMParser = FakeDOMParser;
    try {
        const xml = [
            '<Trials>',
            '<Trial>',
            '<TrialID>ICTRP-000001</TrialID>',
            '<Scientific_title>A Sample Registered Trial</Scientific_title>',
            '<web_address>https://ictrp.example/ICTRP-000001</web_address>',
            '<Date_registration>29/12/2025</Date_registration>',
            '<Source_Register>JPRN</Source_Register>',
            '</Trial>',
            '</Trials>',
        ].join('');

        const refs = parseICTRP(xml, 'ictrp-sample.xml');

        assert.equal(refs.length, 1);
        assert.equal(refs[0].record_type, 'registration');
        assert.equal(refs[0].journal, 'ICTRP');
        assert.equal(refs[0].source, 'JPRN');
    } finally {
        (globalThis as { DOMParser?: unknown }).DOMParser = originalDOMParser;
    }
});
