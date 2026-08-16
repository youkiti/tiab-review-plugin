import test from 'node:test';
import assert from 'node:assert/strict';
import { isFulltextClaimValid } from '../src/lib/drive-import-claim';
import type { FulltextClaimState } from '../src/lib/drive-import-claim';

// Issue #73 Phase 2: クレームの有効条件（純関数）のテスト。
// 有効条件は次の3つすべて: 1. status==='cached' 2. url が非空 3. extractDriveFileId(url)===copyFileId

const VALID: FulltextClaimState = {
    status: 'cached',
    url: 'https://drive.google.com/file/d/copy-1/view',
    copyFileId: 'copy-1',
};

test('isFulltextClaimValid: 3条件すべて一致 -> true', () => {
    assert.equal(isFulltextClaimValid(VALID), true);
});

test('isFulltextClaimValid: status !== cached -> false', () => {
    assert.equal(isFulltextClaimValid({ ...VALID, status: 'retrieved' }), false);
    assert.equal(isFulltextClaimValid({ ...VALID, status: 'not_retrieved' }), false);
    assert.equal(isFulltextClaimValid({ ...VALID, status: 'unavailable' }), false);
});

test('isFulltextClaimValid: url が空 -> false', () => {
    assert.equal(isFulltextClaimValid({ ...VALID, url: '' }), false);
});

test('isFulltextClaimValid: copyIdがURL由来のファイルIDと食い違う（旧版クライアントがT:Uだけ書いたstaleクレーム）-> false', () => {
    // 旧版がURL(fulltext_url)だけ別PDFへ差し替え、W:X（copyFileId）をクリアしなかったケースを模す
    assert.equal(isFulltextClaimValid({ ...VALID, copyFileId: 'copy-2' }), false);
});

test('isFulltextClaimValid: urlがDriveリンクとして解釈できない場合もfalse（extractDriveFileIdがnullを返す）', () => {
    assert.equal(isFulltextClaimValid({ ...VALID, url: 'not-a-drive-url' }), false);
});

test('isFulltextClaimValid: open?id= 形式のURLでも一致すればtrue（extractDriveFileIdの別形式サポートを踏襲）', () => {
    assert.equal(
        isFulltextClaimValid({ status: 'cached', url: 'https://drive.google.com/open?id=copy-9', copyFileId: 'copy-9' }),
        true
    );
});
