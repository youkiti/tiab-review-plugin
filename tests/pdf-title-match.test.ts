import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeForMatch,
    extractDoiFromFilename,
    titleSimilarityScore,
    findBestMatch,
    MATCH_SCORE_THRESHOLD,
} from '../src/lib/pdf-title-match';

test('normalizeForMatch: NFKC正規化・小文字化・記号除去・空白圧縮を行う', () => {
    // 全角英数字（NFKC正規化で半角化される）
    assert.equal(normalizeForMatch('ＡＢＣ　１２３'), 'abc 123');
    // 記号除去 + 連続空白の圧縮
    assert.equal(normalizeForMatch('COVID-19: A Randomized  Trial (RCT)'), 'covid 19 a randomized trial rct');
    // 前後の空白はtrimされる
    assert.equal(normalizeForMatch('  Hello World  '), 'hello world');
});

test('extractDoiFromFilename: ファイル名からDOIを抽出する', () => {
    assert.equal(extractDoiFromFilename('10.1001/jama.2020.1585.pdf'), '10.1001/jama.2020.1585');
    assert.equal(
        extractDoiFromFilename('Smith et al 2020 - 10.1056/NEJMoa2001017 - Full text.pdf'),
        '10.1056/NEJMoa2001017'
    );
    // 末尾に付きがちな括弧・句読点は削る
    assert.equal(extractDoiFromFilename('(10.1234/abcd.5678).pdf'), '10.1234/abcd.5678');
});

test('extractDoiFromFilename: DOIが含まれない場合はnull', () => {
    assert.equal(extractDoiFromFilename('random-file-name.pdf'), null);
    assert.equal(extractDoiFromFilename('report_v2_final.pdf'), null);
});

test('titleSimilarityScore: タイトルのトークン重複率をタイトル側分母で計算する', () => {
    const title = 'Randomized controlled trial of aspirin for prevention';
    // ファイル名側に識別子（著者名・年）が前後に付いていても、タイトル語が全て含まれていればスコア1
    const score = titleSimilarityScore('Smith2020_Randomized_controlled_trial_of_aspirin_for_prevention.pdf', title);
    assert.equal(score, 1);
});

test('titleSimilarityScore: 一致するトークンがなければ0', () => {
    const score = titleSimilarityScore('completely-unrelated-file.pdf', 'A totally different study about diabetes');
    assert.equal(score, 0);
});

test('titleSimilarityScore: 空文字列は0を返す（0除算を起こさない）', () => {
    assert.equal(titleSimilarityScore('', 'Some title'), 0);
    assert.equal(titleSimilarityScore('file.pdf', ''), 0);
});

test('findBestMatch: ファイル名中のDOIが候補のdoiと一致すれば最優先（score=1）で採用する', () => {
    const result = findBestMatch('random_name_10.1001/jama.2020.1585.pdf', [
        { ref_id: 'a', title: '全く関係のないタイトル', doi: '10.1001/jama.2020.1585' },
        { ref_id: 'b', title: 'Randomized controlled trial of aspirin', doi: '10.9999/other' },
    ]);
    assert.deepEqual(result, { ref_id: 'a', score: 1, matchedByDoi: true });
});

test('findBestMatch: DOI付きのdoi.org URL表記でも比較できる', () => {
    const result = findBestMatch('paper-10.1001/jama.2020.1585.pdf', [
        { ref_id: 'a', title: 'x', doi: 'https://doi.org/10.1001/jama.2020.1585' },
    ]);
    assert.equal(result?.ref_id, 'a');
    assert.equal(result?.matchedByDoi, true);
});

test('findBestMatch: DOI不一致時はタイトルのトークン一致で最良の候補を選ぶ', () => {
    const result = findBestMatch('Randomized_controlled_trial_of_aspirin_for_prevention.pdf', [
        { ref_id: 'a', title: 'A totally unrelated diabetes study' },
        { ref_id: 'b', title: 'Randomized controlled trial of aspirin for prevention' },
    ]);
    assert.equal(result?.ref_id, 'b');
    assert.equal(result?.matchedByDoi, false);
    assert.ok((result?.score ?? 0) >= MATCH_SCORE_THRESHOLD);
});

test('findBestMatch: 閾値未満のスコアしかない場合はnull（未選択）を返す', () => {
    const result = findBestMatch('xyz.pdf', [
        { ref_id: 'a', title: 'Randomized controlled trial of aspirin for prevention of stroke' },
    ]);
    assert.equal(result, null);
});

test('findBestMatch: 候補が空なら常にnull', () => {
    assert.equal(findBestMatch('anything.pdf', []), null);
});
