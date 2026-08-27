import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegistrationRecord, isSafeHttpUrl } from '../src/lib/registry-record';

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
