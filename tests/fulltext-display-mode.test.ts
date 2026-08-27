import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFulltextDisplayMode } from '../src/lib/fulltext-display-mode';
import type { Reference } from '../src/lib/types';

// Issue #118「レジストリ連携フェーズ1」チャンク3c: フルテキストビューア（fulltext.ts の
// showPdfForRef()）が使う表示経路の分岐を、UI非依存の純関数として切り出した回帰テスト。
// 既存分岐（cached→PDF.js / retrieved→リンク表示 / unavailable→論文ページ / それ以外→自動検索）
// を壊していないことをここで担保する。

type MinimalRef = Pick<Reference, 'record_type' | 'journal' | 'source' | 'fulltext_status' | 'fulltext_url'>;

function ref(overrides: Partial<MinimalRef> = {}): MinimalRef {
    return {
        record_type: undefined,
        journal: 'Some Journal',
        source: 'PubMed',
        fulltext_status: undefined,
        fulltext_url: undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 新設: registry_snapshot（Issue #118 実装内容10）
// ---------------------------------------------------------------------------

test('registration行 + cached + url → registry_snapshot（record_type確定値）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'registration',
        fulltext_status: 'cached',
        fulltext_url: 'https://drive.google.com/file/d/abc/view',
    }));
    assert.equal(result, 'registry_snapshot');
});

test('registration行 + cached + url → registry_snapshot（record_type未設定・journal/sourceヒューリスティック）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: undefined,
        journal: 'ClinicalTrials.gov',
        source: 'ClinicalTrials.gov',
        fulltext_status: 'cached',
        fulltext_url: 'https://drive.google.com/file/d/abc/view',
    }));
    assert.equal(result, 'registry_snapshot');
});

test('registration行だがcachedでない（unavailable）→ registry_snapshotにはならない', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'registration',
        fulltext_status: 'unavailable',
    }));
    assert.equal(result, 'unavailable');
});

test('registration行だがurlが空 → registry_snapshotにはならない（not_retrieved扱い）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'registration',
        fulltext_status: 'cached',
        fulltext_url: '',
    }));
    assert.equal(result, 'not_retrieved');
});

// ---------------------------------------------------------------------------
// 既存分岐（通常の論文行）が壊れていないことの回帰確認
// ---------------------------------------------------------------------------

test('通常論文 + cached + url → pdf（従来どおりPDF.js経路）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'article',
        fulltext_status: 'cached',
        fulltext_url: 'https://drive.google.com/file/d/xyz/view',
    }));
    assert.equal(result, 'pdf');
});

test('record_type未設定の通常論文 + cached + url → pdf（journal/sourceがレジストリと一致しない）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: undefined,
        journal: 'The Lancet',
        source: 'PubMed',
        fulltext_status: 'cached',
        fulltext_url: 'https://drive.google.com/file/d/xyz/view',
    }));
    assert.equal(result, 'pdf');
});

test('retrieved + url → linked', () => {
    const result = resolveFulltextDisplayMode(ref({
        fulltext_status: 'retrieved',
        fulltext_url: 'https://example.com/article.pdf',
    }));
    assert.equal(result, 'linked');
});

test('retrieved だが url が空 → linked にはならない（not_retrieved扱い）', () => {
    const result = resolveFulltextDisplayMode(ref({
        fulltext_status: 'retrieved',
        fulltext_url: '',
    }));
    assert.equal(result, 'not_retrieved');
});

test('unavailable → unavailable（registration行でなくても同じ）', () => {
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'article',
        fulltext_status: 'unavailable',
    }));
    assert.equal(result, 'unavailable');
});

test('fulltext_status 未設定 → not_retrieved', () => {
    const result = resolveFulltextDisplayMode(ref({ fulltext_status: undefined }));
    assert.equal(result, 'not_retrieved');
});

test('cachedでもurlが無ければ pdf/registry_snapshot どちらにもならず、後続分岐へ流れる', () => {
    // fulltext_status='cached' だが url が空文字の異常系。'retrieved' でも無いので not_retrieved。
    const result = resolveFulltextDisplayMode(ref({
        record_type: 'article',
        fulltext_status: 'cached',
        fulltext_url: '',
    }));
    assert.equal(result, 'not_retrieved');
});
