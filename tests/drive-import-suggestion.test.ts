import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMappingSuggestion } from '../src/lib/drive-import-suggestion';
import type { MappingSuggestionTarget } from '../src/lib/drive-import-suggestion';

// --- 本丸: cached済み文献が最良マッチのとき、劣った非cached文献を既定値にしない ---

test('resolveMappingSuggestion: cached済み文献にファイル名が一致 -> likely-imported（現行の誤対応付けを再現し、起きないことを確認）', () => {
    // 「本来の対応付け先」はcached済みで候補から外れている文献。
    // 現行実装（cachedを除外してfindBestMatchへ渡す）だと、これより一致率の劣る
    // 別の似たタイトルの非cached文献がスコア0.6以上で拾われ、既定値としてプリセットされてしまう。
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'cached-correct',
            title: 'Effects of Remote Ischemic Conditioning on Stroke Outcomes',
            isCached: true,
            isMappable: false,
        },
        {
            ref_id: 'other-similar',
            title: 'Effects of Remote Monitoring on Stroke',
            isCached: false,
            isMappable: true,
        },
    ];
    const result = resolveMappingSuggestion('Effects_of_Remote_Ischemic_Conditioning_on_Stroke_Outcomes.pdf', targets);
    assert.deepEqual(result, { kind: 'likely-imported', refId: 'cached-correct', title: 'Effects of Remote Ischemic Conditioning on Stroke Outcomes' });
});

// --- 従来どおりの既定値プリセット ---

test('resolveMappingSuggestion: 非cachedの担当内文献に一致 -> suggest（従来どおり既定値にする）', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'mappable-1',
            title: 'A Randomized Trial of Aspirin for Cardiovascular Prevention',
            isCached: false,
            isMappable: true,
        },
    ];
    const result = resolveMappingSuggestion('A_Randomized_Trial_of_Aspirin_for_Cardiovascular_Prevention.pdf', targets);
    assert.deepEqual(result, { kind: 'suggest', refId: 'mappable-1' });
});

// --- マッチ無し ---

test('resolveMappingSuggestion: どれにも一致しない（スコアが閾値未満）-> none', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'unrelated',
            title: 'Completely Different Topic About Nutrition',
            isCached: false,
            isMappable: true,
        },
    ];
    const result = resolveMappingSuggestion('random_file_xyz123.pdf', targets);
    assert.deepEqual(result, { kind: 'none' });
});

// --- 担当外の非cached文献 ---

test('resolveMappingSuggestion: 担当外の非cached文献が最良マッチ -> none（選択できないので既定値を出さない）', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'out-of-assignment',
            title: 'Long Term Outcomes After Cardiac Surgery',
            isCached: false,
            isMappable: false,
        },
    ];
    const result = resolveMappingSuggestion('Long_Term_Outcomes_After_Cardiac_Surgery.pdf', targets);
    assert.deepEqual(result, { kind: 'none' });
});

// --- DOI一致 ---

test('resolveMappingSuggestion: cached文献にDOIで一致 -> likely-imported（findBestMatchはDOI一致を最優先する）', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'cached-doi',
            title: 'Totally Unrelated Title',
            doi: '10.1234/example.doi',
            isCached: true,
            isMappable: false,
        },
        {
            ref_id: 'mappable-other',
            title: 'Another Unrelated Title',
            isCached: false,
            isMappable: true,
        },
    ];
    const result = resolveMappingSuggestion('paper-10.1234/example.doi.pdf', targets);
    assert.deepEqual(result, { kind: 'likely-imported', refId: 'cached-doi', title: 'Totally Unrelated Title' });
});

// --- titleが空のcached文献 ---

test('resolveMappingSuggestion: titleが空のcached文献に一致 -> titleにref_idが入る', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'cached-no-title',
            doi: '10.5555/no-title-example',
            isCached: true,
            isMappable: false,
        },
    ];
    const result = resolveMappingSuggestion('paper-10.5555/no-title-example.pdf', targets);
    assert.deepEqual(result, { kind: 'likely-imported', refId: 'cached-no-title', title: 'cached-no-title' });
});

// --- 空配列 ---

test('resolveMappingSuggestion: targetsが空配列 -> none', () => {
    const result = resolveMappingSuggestion('anything.pdf', []);
    assert.deepEqual(result, { kind: 'none' });
});

// --- 同一タイトルの重複文献（cached / 非cached）が同スコアで並ぶとき、行順によらずcachedが勝つ ---

test('resolveMappingSuggestion: 同一タイトルの重複文献2行（非cachedが配列の先頭）-> likely-imported（cached側のref_id）', () => {
    // findBestMatchは同スコアなら配列で先に来た方を返すため、非cachedを先頭に置いても
    // シートの行順に引きずられず cached 側が既定値の提案先になることを確認する（指摘1の本丸）。
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'noncached-dup',
            title: 'Duplicate Title Here For Match Test',
            isCached: false,
            isMappable: true,
        },
        {
            ref_id: 'cached-dup',
            title: 'Duplicate Title Here For Match Test',
            isCached: true,
            isMappable: false,
        },
    ];
    const result = resolveMappingSuggestion('Duplicate_Title_Here_For_Match_Test.pdf', targets);
    assert.deepEqual(result, { kind: 'likely-imported', refId: 'cached-dup', title: 'Duplicate Title Here For Match Test' });
});

test('resolveMappingSuggestion: 同一タイトルの重複文献2行（cachedが配列の先頭）-> likely-imported（cached側のref_id、逆順でも同じ結果）', () => {
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'cached-dup',
            title: 'Duplicate Title Here For Match Test',
            isCached: true,
            isMappable: false,
        },
        {
            ref_id: 'noncached-dup',
            title: 'Duplicate Title Here For Match Test',
            isCached: false,
            isMappable: true,
        },
    ];
    const result = resolveMappingSuggestion('Duplicate_Title_Here_For_Match_Test.pdf', targets);
    assert.deepEqual(result, { kind: 'likely-imported', refId: 'cached-dup', title: 'Duplicate Title Here For Match Test' });
});

test('resolveMappingSuggestion: 全体最良マッチがmappableのDOI一致、cached側がタイトル一致でscore=1 -> suggest（DOI一致が勝つ）', () => {
    // cached側は「10.9999/doimatch」というDOI文字列を含むファイル名からもタイトルが完全一致
    // (score=1)するが、matchedByDoiがfalseのため、DOI一致（matchedByDoi=true）のmappable側と
    // 同格とはみなされず suggest が返る。
    const targets: MappingSuggestionTarget[] = [
        {
            ref_id: 'mappable-doi',
            title: 'Some Unrelated Title A',
            doi: '10.9999/doimatch',
            isCached: false,
            isMappable: true,
        },
        {
            ref_id: 'cached-title',
            title: 'Effects of Combined Therapy on Recovery',
            isCached: true,
            isMappable: false,
        },
    ];
    const result = resolveMappingSuggestion(
        '10.9999/doimatch Effects_of_Combined_Therapy_on_Recovery.pdf',
        targets
    );
    assert.deepEqual(result, { kind: 'suggest', refId: 'mappable-doi' });
});
