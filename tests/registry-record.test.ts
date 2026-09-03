import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegistrationRecord, isSafeHttpUrl, extractSecondaryTrialIds } from '../src/lib/registry-record';

// Issue #118 チャンク1: registration 判定の単一情報源（isRegistrationRecord）の回帰テスト。
// フォールバックのヒューリスティックは src/sidepanel/features/screening/render.ts の
// renderTrialRegistryNote() が元々持っていたものと同一でなければならない
// （journal を trim・小文字化した上で 'ictrp' / 'clinicaltrials.gov' と完全一致、
// または source に 'clinicaltrials.gov' を含む）。

test('record_type確定値: registration は journal/source によらず true', () => {
    assert.equal(
        isRegistrationRecord({ record_type: 'registration', journal: 'NEJM', source: 'PubMed' }),
        true
    );
});

test('record_type確定値: article は journal/source がレジストリ風でも false', () => {
    assert.equal(
        isRegistrationRecord({ record_type: 'article', journal: 'ICTRP', source: 'clinicaltrials.gov' }),
        false
    );
});

test('フォールバック: journal が ICTRP（完全一致・大文字小文字を無視）なら true', () => {
    assert.equal(isRegistrationRecord({ journal: 'ICTRP', source: undefined }), true);
    assert.equal(isRegistrationRecord({ journal: 'ictrp', source: undefined }), true);
    assert.equal(isRegistrationRecord({ journal: '  ICTRP  ', source: undefined }), true, '前後の空白はtrimされること');
});

test('フォールバック: journal が ClinicalTrials.gov（完全一致・大文字小文字を無視）なら true', () => {
    assert.equal(isRegistrationRecord({ journal: 'ClinicalTrials.gov', source: undefined }), true);
    assert.equal(isRegistrationRecord({ journal: 'clinicaltrials.gov', source: undefined }), true);
});

test('フォールバック: source に clinicaltrials.gov を含む（大文字小文字を無視）なら true', () => {
    assert.equal(
        isRegistrationRecord({ journal: undefined, source: 'https://ClinicalTrials.gov/study/NCT123' }),
        true
    );
});

test('フォールバック: 通常論文（journal/sourceともにレジストリと無関係）は false', () => {
    assert.equal(
        isRegistrationRecord({ journal: 'The Lancet', source: 'PubMed' }),
        false
    );
});

test('フォールバック: journal が部分一致（前後に文字がある）では true にならない（完全一致のみ）', () => {
    assert.equal(isRegistrationRecord({ journal: 'ICTRP Registry', source: undefined }), false);
});

test('フォールバック: record_type/journal/source すべて未設定なら false', () => {
    assert.equal(isRegistrationRecord({}), false);
});

// --- isSafeHttpUrl(): PR #122 レビュー指摘3で export化。registration行由来のURLを外部へ渡す前の共通ガード ---
// （src/lib/fulltext-retriever.ts の retrieveRegistrationSnapshot() のDrive保存失敗フォールバックが
// このガードを通すようになった。回帰テストは tests/fulltext-retriever-registry.test.ts 側にもある）

test('isSafeHttpUrl: https:// は true', () => {
    assert.equal(isSafeHttpUrl('https://clinicaltrials.gov/study/NCT12345678'), true);
});

test('isSafeHttpUrl: http:// は true', () => {
    assert.equal(isSafeHttpUrl('http://example.com/study'), true);
});

test('isSafeHttpUrl: javascript: は false', () => {
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
});

test('isSafeHttpUrl: data: は false', () => {
    assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('isSafeHttpUrl: 相対URLは false', () => {
    assert.equal(isSafeHttpUrl('/study/NCT123'), false);
});

test('isSafeHttpUrl: 空文字は false', () => {
    assert.equal(isSafeHttpUrl(''), false);
});

test('isSafeHttpUrl: パースできない値は false（例外を投げない）', () => {
    assert.equal(isSafeHttpUrl(':::'), false);
});

// --- extractSecondaryTrialIds(): Issue #134「レジストリ連携: 副登録番号を論文候補探索の
// キーに加える」チャンク1。ラベル名には依存せず値の中身をパターンマッチする（JSDoc参照）。

test('extractSecondaryTrialIds: NCT形式を拾える', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'NCT01234567' }],
        undefined
    );
    assert.deepEqual(result, ['NCT01234567']);
});

test('extractSecondaryTrialIds: ISRCTN形式を拾える', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'ISRCTN12345678' }],
        undefined
    );
    assert.deepEqual(result, ['ISRCTN12345678']);
});

test('extractSecondaryTrialIds: UMIN形式を拾える', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'UMIN000012345' }],
        undefined
    );
    assert.deepEqual(result, ['UMIN000012345']);
});

test('extractSecondaryTrialIds: JapicCTI形式を拾える（ハイフン有無どちらも）', () => {
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'JapicCTI-142150' }], undefined),
        ['JapicCTI-142150']
    );
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'JapicCTI142150' }], undefined),
        ['JapicCTI142150']
    );
});

test('extractSecondaryTrialIds: jRCT形式（種別文字あり・数字9桁）を拾える（実データ43件の実例。jRCTsは特定臨床研究＝本命の種別）', () => {
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'jRCTs011180014' }], undefined),
        ['jRCTs011180014']
    );
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'jRCTs031180397' }], undefined),
        ['jRCTs031180397']
    );
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'jRCTc030190219' }], undefined),
        ['jRCTc030190219']
    );
});

test('extractSecondaryTrialIds: jRCT形式（種別文字なし・数字10桁）を拾える（実データ43件の実例）', () => {
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'jRCT2080223886' }], undefined),
        ['jRCT2080223886']
    );
    assert.deepEqual(
        extractSecondaryTrialIds([{ label: 'Secondary ID', value: 'jRCT1030210638' }], undefined),
        ['jRCT1030210638']
    );
});

test('extractSecondaryTrialIds: パターンは大文字小文字を区別しない', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'nct01234567' }],
        undefined
    );
    assert.deepEqual(result, ['nct01234567']);
});

test('extractSecondaryTrialIds: ownTrialIdと（大文字小文字を無視して）一致するものは除外する', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'jrct1031210123' }],
        'JRCT1031210123'
    );
    assert.deepEqual(result, [], '自分自身の試験IDを引き直しても意味が無いため除外されること');
});

test('extractSecondaryTrialIds: 重複は排除し出現順を保つ', () => {
    const result = extractSecondaryTrialIds(
        [
            { label: 'Secondary ID 1', value: 'NCT01234567' },
            { label: 'Secondary ID 2', value: 'UMIN000012345' },
            { label: 'Secondary ID 3', value: 'nct01234567' }, // 大文字小文字違いの重複
        ],
        undefined
    );
    assert.deepEqual(result, ['NCT01234567', 'UMIN000012345'], '大文字小文字を無視して重複排除しつつ出現順を保つこと');
});

test('extractSecondaryTrialIds: maxCount（既定3）で打ち切る', () => {
    const result = extractSecondaryTrialIds(
        [
            { label: 'a', value: 'NCT01111111' },
            { label: 'b', value: 'NCT02222222' },
            { label: 'c', value: 'NCT03333333' },
            { label: 'd', value: 'NCT04444444' },
        ],
        undefined
    );
    assert.equal(result.length, 3, '既定のmaxCount=3件で打ち切られること');
    assert.deepEqual(result, ['NCT01111111', 'NCT02222222', 'NCT03333333']);
});

test('extractSecondaryTrialIds: maxCountを明示的に指定できる', () => {
    const result = extractSecondaryTrialIds(
        [
            { label: 'a', value: 'NCT01111111' },
            { label: 'b', value: 'NCT02222222' },
        ],
        undefined,
        1
    );
    assert.deepEqual(result, ['NCT01111111']);
});

test('extractSecondaryTrialIds: C\\d{9}形式（UMIN-CTRの旧採番）は拾わない', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Secondary ID', value: 'C000000123' }],
        undefined
    );
    assert.deepEqual(result, [], 'C\\d{9}は誤マッチのリスクが高いため意図的に対象外（JSDoc参照）');
});

test('extractSecondaryTrialIds: 該当なしなら空配列', () => {
    const result = extractSecondaryTrialIds(
        [{ label: 'Brief Summary', value: 'This is a plain summary with no registry IDs.' }],
        undefined
    );
    assert.deepEqual(result, []);
});

test('extractSecondaryTrialIds: フィールドが空配列でも例外を投げず空配列を返す', () => {
    assert.deepEqual(extractSecondaryTrialIds([], undefined), []);
});
