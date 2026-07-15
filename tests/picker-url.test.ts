import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPickerUrl, PICKER_PAGE_URL } from '../src/lib/picker-url';

test('buildPickerUrl uses URL fragment for fileId and email', () => {
    const url = buildPickerUrl('sheet_123', 'reviewer@example.com', 'https://example.test/picker.html');
    assert.equal(url, 'https://example.test/picker.html#fileId=sheet_123&email=reviewer%40example.com');
    assert.equal(url.includes('?'), false);
});

test('buildPickerUrl omits empty fragment when no values are provided', () => {
    assert.equal(buildPickerUrl(undefined, undefined), PICKER_PAGE_URL);
});
