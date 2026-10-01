import test from 'node:test';
import assert from 'node:assert/strict';
import { installDemoFetchMock } from '../src/demo/fetch-mock';
import { DEMO_SPREADSHEET_ID } from '../src/demo/constants';

// seed.ts は .nbib の raw import でテストから読めないためシードは行わない。
// POST /v4/spreadsheets（createSpreadsheet）→ 続くヘッダー追記 → 読み取りの経路だけを検査する。
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const headers = { Authorization: 'Bearer demo-token', 'Content-Type': 'application/json' };

test('新規作成に応答し、要求したシートだけが空で作られ、ヘッダー追記と読み取りが通る', async () => {
    installDemoFetchMock();

    const created = await fetch(SHEETS, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            properties: { title: '新しいプロジェクト' },
            sheets: [{ properties: { title: 'References' } }, { properties: { title: 'Decisions' } }, { properties: { title: 'Config' } }],
        }),
    });
    assert.equal(created.status, 200);
    const data = await created.json();
    assert.equal(data.spreadsheetId, DEMO_SPREADSHEET_ID);
    assert.equal(data.properties.title, '新しいプロジェクト');

    const meta = await (await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}?fields=sheets.properties`, { headers })).json();
    assert.deepEqual(meta.sheets.map((s: { properties: { title: string } }) => s.properties.title), ['References', 'Decisions', 'Config']);

    // createSpreadsheet() と同じ形のヘッダー追記
    const append = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values/References:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ values: [['ref_id', 'title']] }),
    });
    assert.equal(append.status, 200);
    assert.equal((await append.json()).updates.updatedRange.startsWith('References!A1'), true);

    // 本体3タブの batchGet（loadProjectSnapshot と同じ形）。文献0件・判定0件・Config空
    const batch = await fetch(
        `${SHEETS}/${DEMO_SPREADSHEET_ID}/values:batchGet?ranges=${['References!A:AA', 'Decisions!A:K', 'Config!A:B'].map(encodeURIComponent).join('&ranges=')}`,
        { headers }
    );
    assert.equal(batch.status, 200);
    const ranges = (await batch.json()).valueRanges;
    assert.deepEqual(ranges[0].values, [['ref_id', 'title']]);
    assert.deepEqual(ranges[1].values, []);
    assert.deepEqual(ranges[2].values, []);

    // 未作成のタブ（LLM_Executions 等）は本物と同じく「Unable to parse range」で、addSheet 後に使える
    const missing = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}/values/${encodeURIComponent('LLM_Executions!1:1')}`, { headers });
    assert.equal(missing.status, 400);
    const add = await fetch(`${SHEETS}/${DEMO_SPREADSHEET_ID}:batchUpdate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'LLM_Executions' } } }] }),
    });
    assert.equal(add.status, 200);
});
