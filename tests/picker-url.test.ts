import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPickerUrl,
    buildPdfPickerUrl,
    buildRegrantPickerUrl,
    isExtensionRedirectUri,
    isSharedDrivesRequested,
    PICKER_PAGE_URL,
} from '../src/lib/picker-url';

test('buildPickerUrl uses URL fragment for fileId and email', () => {
    const url = buildPickerUrl('sheet_123', 'reviewer@example.com', 'https://example.test/picker.html');
    assert.equal(url, 'https://example.test/picker.html#fileId=sheet_123&email=reviewer%40example.com&drives=1');
    assert.equal(url.includes('?'), false);
});

test('buildPickerUrl still passes drives=1 when no other values are provided', () => {
    // Issue #80: drives は拡張機能側の能力表明なので、他のパラメータの有無に関わらず必ず付ける
    assert.equal(buildPickerUrl(undefined, undefined), `${PICKER_PAGE_URL}#drives=1`);
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
        'https://example.test/picker.html#mode=pdf&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fpicker&folderId=folder_1&email=reviewer%40example.com&drives=1'
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
        'https://example.test/picker.html#mode=pdf&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2F&drives=1'
    );
});

test('buildRegrantPickerUrl sets mode=regrant and passes redirect/folderId/email via fragment', () => {
    const url = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(
        url,
        'https://example.test/picker.html#mode=regrant&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fpicker&folderId=folder_1&email=reviewer%40example.com&drives=1'
    );
    assert.equal(url.includes('?'), false);
});

test('buildRegrantPickerUrl omits email when not provided (folderId is always required)', () => {
    const url = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
        folderId: 'folder_2',
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(
        url,
        'https://example.test/picker.html#mode=regrant&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2F&folderId=folder_2&drives=1'
    );
});

test('isSharedDrivesRequested enables shared drives only for the exact flag value', () => {
    assert.equal(isSharedDrivesRequested('1'), true);
});

test('isSharedDrivesRequested falls back to disabled for anything else', () => {
    // 旧バージョンの拡張機能（drives を渡さない）は null になる。ここが true に倒れると
    // GitHub Pages への配信だけで全ユーザーの挙動が変わってしまう（Issue #80 のゲートの要）
    assert.equal(isSharedDrivesRequested(null), false);
    assert.equal(isSharedDrivesRequested(undefined), false);
    assert.equal(isSharedDrivesRequested(''), false);
    assert.equal(isSharedDrivesRequested('0'), false);
    assert.equal(isSharedDrivesRequested('true'), false);
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
