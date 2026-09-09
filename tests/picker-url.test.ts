import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPickerUrl,
    buildPdfPickerUrl,
    buildRegrantPickerUrl,
    isExtensionRedirectUri,
    isRegrantFileIdsComplete,
    isSharedDrivesRequested,
    parseRegrantFileIds,
    chunkRegrantFileIdsForUrl,
    REGRANT_PICKER_CHUNK_SIZE,
    REGRANT_PICKER_MAX_URL_LENGTH,
    PICKER_PAGE_URL,
    PICKER_FILE_IDS_PARAM,
    PICKER_FILE_IDS_COUNT_PARAM,
    PICKER_FILE_IDS_END_PARAM,
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

test('buildRegrantPickerUrl adds fileIds, fileIdsCount and fileIdsEnd to the fragment when provided (Issue #203)', () => {
    const url = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: ['a', 'b', 'c'],
        baseUrl: 'https://example.test/picker.html',
    });
    // fileIdsEnd は末尾（番兵）、fileIds はその直前、fileIdsCount はさらにその前
    // （切り詰めが起きたときに失って困る順に前へ置く。email/drives より後ろ、fileIds より前）。
    assert.equal(
        url,
        'https://example.test/picker.html#mode=regrant&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fpicker&folderId=folder_1&email=reviewer%40example.com&drives=1&fileIdsCount=3&fileIds=a%2Cb%2Cc&fileIdsEnd=1'
    );
});

test('buildRegrantPickerUrl puts fileIds after email/drives/fileIdsCount, and fileIdsEnd last of all (right after fileIds)', () => {
    const url = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: ['a', 'b', 'c'],
        baseUrl: 'https://example.test/picker.html',
    });
    const fileIdsIndex = url.indexOf('&fileIds=');
    const fileIdsEndIndex = url.indexOf('&fileIdsEnd=');
    assert.ok(fileIdsIndex > url.indexOf('&email='));
    assert.ok(fileIdsIndex > url.indexOf('&drives='));
    assert.ok(fileIdsIndex > url.indexOf('&fileIdsCount='));
    assert.ok(fileIdsEndIndex > fileIdsIndex);
    // fileIdsEnd が末尾パラメータであること（これより後ろに他のパラメータが続かない
    // ＝最後の "&" が fileIdsEnd の前）。fileIds はもはや最後のパラメータではない
    // （犠牲用の番兵 fileIdsEnd がその後ろに付く）。
    assert.equal(url.lastIndexOf('&'), fileIdsEndIndex);
});

test('buildRegrantPickerUrl sets fileIdsCount to the fileIds length, and omits it when fileIds is absent', () => {
    const withFileIds = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: ['a', 'b', 'c', 'd'],
        baseUrl: 'https://example.test/picker.html',
    });
    const withFileIdsParams = new URLSearchParams(withFileIds.slice(withFileIds.indexOf('#') + 1));
    assert.equal(withFileIdsParams.get(PICKER_FILE_IDS_COUNT_PARAM), '4');

    const withoutFileIds = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(withoutFileIds.includes(PICKER_FILE_IDS_COUNT_PARAM), false);

    const withEmptyFileIds = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: [],
        baseUrl: 'https://example.test/picker.html',
    });
    assert.equal(withEmptyFileIds.includes(PICKER_FILE_IDS_COUNT_PARAM), false);
});

test('buildRegrantPickerUrl omits fileIds when not provided or empty (matches the pre-#203 URL exactly)', () => {
    const withoutOption = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        baseUrl: 'https://example.test/picker.html',
    });
    const withEmptyArray = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: [],
        baseUrl: 'https://example.test/picker.html',
    });
    const expected = 'https://example.test/picker.html#mode=regrant&redirect=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fpicker&folderId=folder_1&email=reviewer%40example.com&drives=1';
    assert.equal(withoutOption, expected);
    assert.equal(withEmptyArray, expected);
    assert.equal(withoutOption.includes('fileIds'), false);
});

test('buildRegrantPickerUrl fileIds round-trip through the fragment via parseRegrantFileIds (Issue #203)', () => {
    // src/webapp/picker.ts の start() が本番でやっている経路（URLのフラグメント部分を
    // new URLSearchParams() でパースし、PICKER_FILE_IDS_PARAM を取り出す）をそのままたどる。
    // buildRegrantPickerUrl 側と parseRegrantFileIds 側が別々に固定されているだけでは、
    // 区切り文字やエンコードの流儀が片方だけずれても両テストが緑のまま通ってしまうため、
    // 「書いた側が読み側で正しく復元できる」ことをここで直接確認する。
    const originalFileIds = ['1AbC_dEf-23', 'zYx9876_wv-U', 'file-id_3'];
    const url = buildRegrantPickerUrl({
        email: 'reviewer@example.com',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds: originalFileIds,
        baseUrl: 'https://example.test/picker.html',
    });
    const fragment = url.slice(url.indexOf('#') + 1);
    const params = new URLSearchParams(fragment);
    const roundTrippedFileIds = parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM));
    assert.deepEqual(roundTrippedFileIds, originalFileIds);
});

test('a URL truncated near the end is still flagged via the sentinel, even though parseRegrantFileIds still returns all fileIds (reported reproduction)', () => {
    // レビューで報告された再現手順: 33文字前後のDrive風fileIdを2件渡してURLを組み立て、
    // 末尾から10文字削る。fileIdsEnd（13文字の "&fileIdsEnd=1"）を追加した後は、
    // この程度の切り詰めは番兵のほうが先に（かつ丸ごと）失われ、fileIds 自体は無事残る。
    // 件数比較だけでは「2件のまま」で食い違いが起きないため検知できないが、番兵が
    // 欠けていることから切り詰めを検知できることを確認する。
    const fileIds = [`1${'B'.repeat(32)}`, `1${'C'.repeat(32)}`];
    const fullUrl = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: `1${'A'.repeat(32)}`,
        email: 'someone@example.com',
        fileIds,
        baseUrl: 'https://youkiti.github.io/tiab-review-plugin/app/picker.html',
    });
    const truncatedUrl = fullUrl.slice(0, fullUrl.length - 10);
    const fragment = truncatedUrl.slice(truncatedUrl.indexOf('#') + 1);
    const params = new URLSearchParams(fragment);

    const parsedFileIds = parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM));
    assert.equal(parsedFileIds.length, 2); // (b) 件数だけ見ると切り詰めが起きたようには見えない
    assert.equal(isRegrantFileIdsComplete(params.get(PICKER_FILE_IDS_END_PARAM)), false); // (a) 番兵は欠けている
});

test('a truncation that eats the sentinel and bites into the last fileId is still flagged via the sentinel, even though the count alone would not catch it', () => {
    // 上のテスト（番兵だけが失われるケース）との違い: あちらは番兵（13文字の "&fileIdsEnd=1"）
    // の内側に収まる軽い切り詰めで、fileIds 本体（末尾のID）は無傷のまま残る。
    // こちらは番兵を丸ごと食い切って、さらに fileIds 本体（末尾のID）にも食い込む、
    // より深い切り詰めのケース。レビュー指摘が突いていたのはまさにこちら側:
    // 切れた断片が Drive のファイルID相当の文字種（英数字・`_`・`-`）にたまたまマッチすれば、
    // parseRegrantFileIds は「2件」を返してしまい、件数比較だけでは検知できない
    // （壊れた2件目が文字種の検証をそのまま通過するため）。番兵の欠落だけが、この
    // ケースを確実に検知できる手段になる。
    const fileIds = [`1${'B'.repeat(32)}`, `1${'C'.repeat(32)}`];
    const fullUrl = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: `1${'A'.repeat(32)}`,
        email: 'someone@example.com',
        fileIds,
        baseUrl: 'https://youkiti.github.io/tiab-review-plugin/app/picker.html',
    });
    // 番兵（"&" + PICKER_FILE_IDS_END_PARAM + "=1"）を丸ごと食い切って、さらに12文字だけ
    // 本体（末尾のfileId）にも食い込む長さを削る。パラメータ名が変わってもテストが
    // 追随するよう、削る文字数はハードコードせず定数から計算する。
    const cutLength = `&${PICKER_FILE_IDS_END_PARAM}=1`.length + 12;
    const truncatedUrl = fullUrl.slice(0, fullUrl.length - cutLength);
    const fragment = truncatedUrl.slice(truncatedUrl.indexOf('#') + 1);
    const params = new URLSearchParams(fragment);

    const parsedFileIds = parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM));
    assert.equal(parsedFileIds.length, 2); // 件数だけ見ると2件のままで、異常には見えない
    assert.notEqual(parsedFileIds[1], fileIds[1]); // 2件目は元のIDと一致しない（途中で切れて壊れている）
    assert.ok(parsedFileIds[1].length < fileIds[1].length); // 元より短い（壊れた断片が「有効」として数えられている）
    assert.equal(isRegrantFileIdsComplete(params.get(PICKER_FILE_IDS_END_PARAM)), false); // 番兵なら検知できる
});

test('a truncation that drops fileIds entirely (fileIdsCount survives) is also flagged via the sentinel', () => {
    // fileIdsCount は残るが fileIds 自体（とそれより後ろの fileIdsEnd）が丸ごと失われる
    // 位置まで切り詰めた場合の再現。fileIds が空になったからといって「fileIds指定なしの
    // 従来経路」と即断してはならないことの確認（fileIdsCount が残っている＝本来は
    // fileIds が送られたはずのケースであり、番兵の欠落から切り詰めを検知できる）。
    const fileIds = ['a', 'b'];
    const fullUrl = buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: 'folder_1',
        fileIds,
        baseUrl: 'https://example.test/picker.html',
    });
    const cutIndex = fullUrl.indexOf('&fileIds=');
    assert.ok(cutIndex > 0);
    const truncatedUrl = fullUrl.slice(0, cutIndex);
    const fragment = truncatedUrl.slice(truncatedUrl.indexOf('#') + 1);
    const params = new URLSearchParams(fragment);

    assert.equal(params.get(PICKER_FILE_IDS_COUNT_PARAM), '2'); // 送信件数は残っている
    assert.deepEqual(parseRegrantFileIds(params.get(PICKER_FILE_IDS_PARAM)), []); // fileIds は空
    assert.equal(isRegrantFileIdsComplete(params.get(PICKER_FILE_IDS_END_PARAM)), false);
});

test('parseRegrantFileIds splits on comma, trims whitespace, and drops entries with invalid characters', () => {
    assert.deepEqual(parseRegrantFileIds('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseRegrantFileIds(' a , b ,c '), ['a', 'b', 'c']);
    assert.deepEqual(parseRegrantFileIds('valid_id-1,invalid id,also/bad,ok2'), ['valid_id-1', 'ok2']);
});

test('parseRegrantFileIds returns an empty array for null/undefined/empty string', () => {
    assert.deepEqual(parseRegrantFileIds(null), []);
    assert.deepEqual(parseRegrantFileIds(undefined), []);
    assert.deepEqual(parseRegrantFileIds(''), []);
});

test('chunkRegrantFileIdsForUrl returns an empty array for empty input (Picker never opens)', () => {
    assert.deepEqual(chunkRegrantFileIdsForUrl([], (ids) => ids.join(',')), []);
});

test('chunkRegrantFileIdsForUrl keeps every fileId exactly once, in order, split by URL length', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const buildUrl = (chunk: string[]): string => chunk.join(',');
    // 3文字（"a,b"）までは許容、4文字目（"a,b,c"→5文字）で次のチャンクへ、というmaxUrlLength=5。
    const chunks = chunkRegrantFileIdsForUrl(ids, buildUrl, 5, 1000);
    assert.deepEqual(chunks, [['a', 'b', 'c'], ['d', 'e', 'f']]);
    assert.deepEqual(chunks.flat(), ids);
    for (const chunk of chunks) {
        assert.ok(buildUrl(chunk).length <= 5);
    }
});

test('chunkRegrantFileIdsForUrl never drops a single fileId even if it alone exceeds maxUrlLength (no infinite loop)', () => {
    const ids = ['toolong', 'x', 'y'];
    const buildUrl = (chunk: string[]): string => chunk.join(',');
    const chunks = chunkRegrantFileIdsForUrl(ids, buildUrl, 1, 1000);
    // 'toolong' 単独で既に上限(1文字)を超えるが、捨てられず単独チャンクになる
    assert.deepEqual(chunks, [['toolong'], ['x'], ['y']]);
    assert.deepEqual(chunks.flat(), ids);
});

test('chunkRegrantFileIdsForUrl closes a chunk at maxCount even when the URL length has headroom', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const buildUrl = (chunk: string[]): string => chunk.join(',');
    // maxUrlLengthは十分大きく、maxCount=2 が分割の決め手になる
    const chunks = chunkRegrantFileIdsForUrl(ids, buildUrl, 1000, 2);
    assert.deepEqual(chunks, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('chunkRegrantFileIdsForUrl treats a maxCount below 1 as 1, never as an infinite loop', () => {
    const ids = ['a', 'b', 'c'];
    const buildUrl = (chunk: string[]): string => chunk.join(',');
    assert.deepEqual(chunkRegrantFileIdsForUrl(ids, buildUrl, 1000, 0), [['a'], ['b'], ['c']]);
    assert.deepEqual(chunkRegrantFileIdsForUrl(ids, buildUrl, 1000, -5), [['a'], ['b'], ['c']]);
});

test('chunkRegrantFileIdsForUrl defaults to REGRANT_PICKER_MAX_URL_LENGTH / REGRANT_PICKER_CHUNK_SIZE and stays within the real buildRegrantPickerUrl budget for realistic Drive file ids', () => {
    // 33文字前後のDrive風fileIdを多数渡し、既定値のまま実際のbuildRegrantPickerUrlで分割する
    // （Issue #203の報告: 実運用で約50件で頭打ちになる事象の再現条件に近い状況）。
    // ここでは「51件」のような具体的な閾値には合わせ込まず、一般的な性質だけを検証する。
    const fileIds = Array.from({ length: 300 }, (_, i) => `1${String(i).padStart(31, 'B')}`);
    const buildUrl = (ids: string[]): string => buildRegrantPickerUrl({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker',
        folderId: `1${'A'.repeat(32)}`,
        email: 'someone@example.com',
        fileIds: ids,
        baseUrl: 'https://youkiti.github.io/tiab-review-plugin/app/picker.html',
    });
    const chunks = chunkRegrantFileIdsForUrl(fileIds, buildUrl);
    assert.deepEqual(chunks.flat(), fileIds);
    for (const chunk of chunks) {
        assert.ok(chunk.length > 0);
        assert.ok(buildUrl(chunk).length <= REGRANT_PICKER_MAX_URL_LENGTH);
    }
    // 1,800文字のURL長上限が効いて、REGRANT_PICKER_CHUNK_SIZE（100件）よりずっと小さい
    // 単位で分割されること（件数固定の分割だけでは防げなかった問題の再発防止）
    assert.ok(chunks.every((chunk) => chunk.length < REGRANT_PICKER_CHUNK_SIZE));
});

test('isRegrantFileIdsComplete treats only the exact sentinel value as complete', () => {
    assert.equal(isRegrantFileIdsComplete('1'), true);
});

test('isRegrantFileIdsComplete falls back to incomplete (truncated) for anything else', () => {
    // 番兵が欠けている・改変されている場合はすべて「切り詰めあり」に倒す
    // （isSharedDrivesRequested と同じイディオム。異常なしと誤答するより安全側に倒す）
    assert.equal(isRegrantFileIdsComplete(null), false);
    assert.equal(isRegrantFileIdsComplete(undefined), false);
    assert.equal(isRegrantFileIdsComplete(''), false);
    assert.equal(isRegrantFileIdsComplete('0'), false);
    assert.equal(isRegrantFileIdsComplete('x'), false);
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
