import test from 'node:test';
import assert from 'node:assert/strict';
import { installDemoFetchMock } from '../src/demo/fetch-mock';
import { resolveDemoPickerRequired } from '../src/demo/profile';
import { isDemoPickerUrl, demoPlatform } from '../src/platform/demo/index';
import { DEMO_SPREADSHEET_ID } from '../src/demo/constants';

// fetch モックはインストール時に ?demoPickerRequired=1 を同期的に読む（モジュール内状態を持つため、
// このファイルではクエリ付きで1回だけインストールし、未許可 → 許可済みの順に検査する）。
// seed.ts は .nbib の raw import でテストから読めないため、シードは行わない（ストアは空）。
// 空ストアでも「許可前は 404、許可後はシート未作成の 400」の違いで切り替えを検査できる。
(globalThis as { location?: unknown }).location = { search: '?demoPickerRequired=1' };

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const headers = { Authorization: 'Bearer demo-token' };

test('?demoPickerRequired=1 をクエリから同期的に解決する', () => {
    assert.equal(resolveDemoPickerRequired(), true);
});

test('Picker のURLだけを許可の対象として判定する', () => {
    assert.equal(isDemoPickerUrl('https://youkiti.github.io/tiab-review-plugin/app/picker.html#fileId=abc&drives=1'), true);
    assert.equal(isDemoPickerUrl('https://drive.google.com/file/d/xyz/view'), false);
    assert.equal(isDemoPickerUrl('https://docs.google.com/spreadsheets/d/abc/edit'), false);
    assert.equal(isDemoPickerUrl('not a url'), false);
});

test('許可前は Sheets API が 404（SheetsAccessDeniedError になる状態コード）、Drive は影響を受けない', async () => {
    installDemoFetchMock();
    assert.equal(globalThis.__tiabDemoNet?.isPickerPending(), true);

    const metadata = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}?fields=properties.title`, { headers });
    assert.equal(metadata.status, 404);
    const body = await metadata.json();
    assert.equal(body.error.message, 'Requested entity was not found.');

    const values = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values/${encodeURIComponent('References!A:AA')}`, { headers });
    assert.equal(values.status, 404);

    const batchGet = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values:batchGet?ranges=${encodeURIComponent('Config!A:B')}`, { headers });
    assert.equal(batchGet.status, 404);

    const append = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values/Decisions:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ values: [['x']] }),
    });
    assert.equal(append.status, 404);

    const driveList = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=15', { headers });
    assert.equal(driveList.status, 200);
});

test('許可の印が立つと同じクエリのままアクセスが通る', async () => {
    globalThis.__tiabDemoPickerGranted = true;
    assert.equal(globalThis.__tiabDemoNet?.isPickerPending(), false);

    const metadata = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}?fields=properties.title`, { headers });
    assert.equal(metadata.status, 200);

    // ストアが空（テストではシードしない）なので、存在しないシートは 404 ではなく 400 "Unable to parse range"
    const values = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values/${encodeURIComponent('References!A:AA')}`, { headers });
    assert.equal(values.status, 400);
});

test('openExternal: クエリ無しでは Picker のURLも通常どおり開き、?demoPickerRequired=1 のときだけ印を立てる', () => {
    const opened: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = { tabs: { create: ({ url }: { url: string }) => { opened.push(url); } } };
    const pickerUrl = 'https://youkiti.github.io/tiab-review-plugin/app/picker.html#fileId=abc&drives=1';
    const loc = globalThis as { location?: unknown };
    const original = loc.location;
    try {
        // クエリ無し: 開く側へ渡り、印は立たない
        loc.location = { search: '' };
        globalThis.__tiabDemoPickerGranted = undefined;
        demoPlatform.openExternal(pickerUrl);
        assert.deepEqual(opened, [pickerUrl]);
        assert.equal(globalThis.__tiabDemoPickerGranted, undefined);

        // クエリ付きでも Picker 以外は開く
        loc.location = { search: '?demoPickerRequired=1' };
        demoPlatform.openExternal('https://drive.google.com/file/d/xyz/view');
        assert.equal(opened.length, 2);
        assert.equal(globalThis.__tiabDemoPickerGranted, undefined);

        // クエリ付きの Picker URL: 開かずに印を立てる
        demoPlatform.openExternal(pickerUrl);
        assert.equal(opened.length, 2);
        assert.equal(globalThis.__tiabDemoPickerGranted, true);
    } finally {
        loc.location = original;
        delete (globalThis as { chrome?: unknown }).chrome;
    }
});
