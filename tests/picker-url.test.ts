import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPickerUrl, buildPdfPickerUrl, isExtensionRedirectUri, PICKER_PAGE_URL } from '../src/lib/picker-url';

test('buildPickerUrl uses URL fragment for fileId and email', () => {
    const url = buildPickerUrl('sheet_123', 'reviewer@example.com', 'https://example.test/picker.html');
    assert.equal(url, 'https://example.test/picker.html#fileId=sheet_123&email=reviewer%40example.com');
    assert.equal(url.includes('?'), false);
});

test('buildPickerUrl omits empty fragment when no values are provided', () => {
    assert.equal(buildPickerUrl(undefined, undefined), PICKER_PAGE_URL);
});

test('buildPdfPickerUrl sets mode=pdf and passes redirect/folderId/email via fragment', () => {
    const url = buildPdfPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(
        url,
        'https://example.test/picker.html#mode=pdf&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fpicker&folderId=folder_1&email=reviewer%40example.com'
    );
    assert.equal(url.includes('?'), false);
});

test('buildPdfPickerUrl omits folderId/email when not provided', () => {
    const url = buildPdfPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(
        url,
        'https://example.test/picker.html#mode=pdf&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2F'
    );
});

test('isExtensionRedirectUri accepts valid 32-char chromiumapp.org redirect URIs', () => {
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/'), true);
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker'), true);
});

test('isExtensionRedirectUri rejects non-extension redirect URIs (open redirect protection)', () => {
    assert.equal(isExtensionRedirectUri('https://evil.example.com/'), false);
    assert.equal(isExtensionRedirectUri('http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/'), false); // http でない
    // ドメイン境界の偽装（*.chromiumapp.org の後に別ドメインを続ける手口）を拒否できるか
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.com/'), false);
    // 32文字ちょうどでない拡張機能ID風文字列を拒否できるか（文字種はa-pのみで有効、長さのみ不正）
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnopa.chromiumapp.org/'), false); // 33文字
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmn.chromiumapp.org/'), false); // 30文字
    // a-p 以外の文字（拡張機能IDに使われない）を拒否できるか
    assert.equal(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnoz.chromiumapp.org/'), false);
});
