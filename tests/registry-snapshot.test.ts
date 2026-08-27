import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractTrialId,
    parseRegistryFieldsFromAbstract,
    buildRegistrySnapshotHtml,
    buildRegistrySnapshotFileName,
} from '../src/lib/registry-record';
import { buildPdfFileName } from '../src/lib/drive-api';

// Issue #118 チャンク2（パスA）: registration行のスナップショット生成に使う純関数の回帰テスト。
// fetch を伴う取得（fetchCtgStudy 等）は tests/fulltext-retriever.test.ts 側で
// リトリーバーの分岐と合わせて検証する。

// ---------------------------------------------------------------------------
// extractTrialId
// ---------------------------------------------------------------------------

test('extractTrialId: NCT番号（NCT+8桁）は kind: nct', () => {
    assert.deepEqual(
        extractTrialId({ pmid: 'NCT12345678', url: undefined, source: undefined }),
        { id: 'NCT12345678', kind: 'nct' }
    );
});

test('extractTrialId: jRCT番号は kind: other', () => {
    assert.deepEqual(
        extractTrialId({ pmid: 'jRCT1031210123', url: undefined, source: undefined }),
        { id: 'jRCT1031210123', kind: 'other' }
    );
});

test('extractTrialId: UMIN番号は kind: other', () => {
    assert.deepEqual(
        extractTrialId({ pmid: 'UMIN000012345', url: undefined, source: undefined }),
        { id: 'UMIN000012345', kind: 'other' }
    );
});

test('extractTrialId: pmid が空/未設定なら null', () => {
    assert.equal(extractTrialId({ pmid: undefined, url: undefined, source: undefined }), null);
    assert.equal(extractTrialId({ pmid: '', url: undefined, source: undefined }), null);
    assert.equal(extractTrialId({ pmid: '   ', url: undefined, source: undefined }), null);
});

test('extractTrialId: NCTに似ているが桁数が違う場合は kind: other（完全一致のみnct）', () => {
    assert.deepEqual(
        extractTrialId({ pmid: 'NCT123456789', url: undefined, source: undefined }),
        { id: 'NCT123456789', kind: 'other' }
    );
    assert.deepEqual(
        extractTrialId({ pmid: 'NCT1234567', url: undefined, source: undefined }),
        { id: 'NCT1234567', kind: 'other' }
    );
});

// ---------------------------------------------------------------------------
// parseRegistryFieldsFromAbstract
// ---------------------------------------------------------------------------

test('parseRegistryFieldsFromAbstract: CTGパーサ形式（" | "連結・"Label: 値"）を逆変換する', () => {
    // src/lib/ctg-parser.ts の csvRowToReference が組み立てる abstract と同じ形。
    const abstract = 'Conditions: Type 2 Diabetes | Interventions: Metformin | Sex: All | Phases: PHASE3';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [
        { label: 'Conditions', value: 'Type 2 Diabetes' },
        { label: 'Interventions', value: 'Metformin' },
        { label: 'Sex', value: 'All' },
        { label: 'Phases', value: 'PHASE3' },
    ]);
});

test('parseRegistryFieldsFromAbstract: ICTRPパーサ形式（" | "連結・"Tag: 値"）を逆変換する', () => {
    // src/lib/ictrp-parser.ts の trialToReference が組み立てる abstract と同じ形。
    const abstract = 'Condition: Hypertension | Intervention: Drug A | Study_design: RCT | Recruitment_Status: Recruiting';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [
        { label: 'Condition', value: 'Hypertension' },
        { label: 'Intervention', value: 'Drug A' },
        { label: 'Study_design', value: 'RCT' },
        { label: 'Recruitment_Status', value: 'Recruiting' },
    ]);
});

test('parseRegistryFieldsFromAbstract: 値にコロンを含む場合は最初のコロンでラベル/値に割る', () => {
    const abstract = 'Date_registration3: 2024-01-01T10:00:00 | Study Design: Allocation: Randomized';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [
        { label: 'Date_registration3', value: '2024-01-01T10:00:00' },
        { label: 'Study Design', value: 'Allocation: Randomized' },
    ]);
});

test('parseRegistryFieldsFromAbstract: 空文字/undefinedは空配列', () => {
    assert.deepEqual(parseRegistryFieldsFromAbstract(''), []);
    assert.deepEqual(parseRegistryFieldsFromAbstract(undefined), []);
});

test('parseRegistryFieldsFromAbstract: ラベルや値が空の要素（コロンあり）は捨てる', () => {
    const abstract = ': empty-label | EmptyValue: | Conditions: Asthma';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [{ label: 'Conditions', value: 'Asthma' }]);
});

test('parseRegistryFieldsFromAbstract: 値そのものに " | " を含むフィールドは分割されず直前フィールドへ復元される（データを落とさない）', () => {
    // Brief Summary 等の自由記述に ' | ' が入ると、分割後にコロンを含まない断片が生まれる。
    // その断片は捨てず、直前フィールドの値へ ' | ' を挟んで連結し、分割前の原文に戻す。
    const abstract = 'Brief Summary: This is a summary | with a pipe | inside it | Conditions: Asthma';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [
        { label: 'Brief Summary', value: 'This is a summary | with a pipe | inside it' },
        { label: 'Conditions', value: 'Asthma' },
    ]);
});

test('parseRegistryFieldsFromAbstract: 先頭要素がコロンを含まない断片の場合は捨てず空ラベルで積む', () => {
    const abstract = 'leading fragment without a colon | Conditions: Asthma';
    const fields = parseRegistryFieldsFromAbstract(abstract);
    assert.deepEqual(fields, [
        { label: '', value: 'leading fragment without a colon' },
        { label: 'Conditions', value: 'Asthma' },
    ]);
});

// ---------------------------------------------------------------------------
// buildRegistrySnapshotHtml
// ---------------------------------------------------------------------------

test('buildRegistrySnapshotHtml: HTMLエスケープ（<script>やクォートを含む値が無害化される）', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000001',
        title: '<script>alert(1)</script>',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'https://clinicaltrials.gov/study/NCT00000001',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [{ label: 'Conditions', value: '"XSS" & <b>bold</b>' }],
    });

    assert.ok(!html.includes('<script>alert(1)</script>'), '生の<script>タグが残っていないこと');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'タイトルがエスケープされて出力されること');
    assert.ok(html.includes('&quot;XSS&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'), 'フィールド値がエスケープされて出力されること');
});

test('buildRegistrySnapshotHtml: ヘッダーに取得日時・原簿URL・試験IDが入る', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000002',
        title: 'Sample Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'https://clinicaltrials.gov/study/NCT00000002',
        retrievedAt: '2026-08-27T12:34:56.000Z',
        fields: [],
    });

    assert.ok(html.includes('NCT00000002'));
    assert.ok(html.includes('2026-08-27T12:34:56.000Z'));
    assert.ok(html.includes('https://clinicaltrials.gov/study/NCT00000002'));
});

test('buildRegistrySnapshotHtml: 原簿URLが無い場合は「不明」等の代替表示になる（空リンクを出さない）', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000003',
        title: 'No URL Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: undefined,
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(!/<a href="">/i.test(html), '空のhref属性を出力しないこと');
});

test('buildRegistrySnapshotHtml: フィールドが順序どおり出力される', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000004',
        title: 'Order Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'https://clinicaltrials.gov/study/NCT00000004',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [
            { label: 'Conditions', value: 'A' },
            { label: 'Interventions', value: 'B' },
            { label: 'Status', value: 'C' },
        ],
    });
    const idxA = html.indexOf('Conditions');
    const idxB = html.indexOf('Interventions');
    const idxC = html.indexOf('Status');
    assert.ok(idxA >= 0 && idxB > idxA && idxC > idxB, 'フィールドが入力順に出力されること');
});

test('buildRegistrySnapshotHtml: 外部リソース参照が無い（原簿リンク以外にhttpで始まるsrc/href属性が無い）', () => {
    const sourceUrl = 'https://clinicaltrials.gov/study/NCT00000005';
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000005',
        title: 'External Resource Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl,
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [{ label: 'Conditions', value: 'X' }],
    });

    const attrMatches = html.match(/\b(?:src|href)\s*=\s*"https?:\/\/[^"]*"/gi) ?? [];
    for (const attr of attrMatches) {
        assert.ok(attr.includes(sourceUrl), `原簿リンク以外の外部URL参照が見つかった: ${attr}`);
    }
    // <link>/<script src>のような外部リソースタグ自体が無いこと
    assert.ok(!/<link\b/i.test(html));
    assert.ok(!/<script\b[^>]*\ssrc=/i.test(html));
    assert.ok(!/<img\b/i.test(html));
});

test('buildRegistrySnapshotHtml: 値中の改行はbrに変換せずpre-wrapで扱う', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000006',
        title: 'Multiline Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: undefined,
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [{ label: 'Brief Summary', value: 'line1\nline2' }],
    });
    assert.ok(!html.includes('<br>') && !html.includes('<br/>') && !html.includes('<br />'), '<br>への変換をしないこと');
    assert.ok(html.includes('line1\nline2'), '改行文字自体はそのまま保持されること');
    assert.ok(/white-space:\s*pre-wrap/.test(html), 'white-space: pre-wrap を指定していること');
});

test('buildRegistrySnapshotHtml: javascript: スキームの原簿URLはリンクにせずテキストとして表示する', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000008',
        title: 'XSS URL Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'javascript:alert(1)',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(!html.includes('<a href="javascript:'), 'javascript: スキームがhref属性として出力されないこと');
    assert.ok(!/href\s*=\s*"javascript:/i.test(html), 'href属性としてjavascript:が出力されないこと');
    assert.ok(html.includes('javascript:alert(1)'), '値自体はテキストとして残ること（情報を落とさない）');
});

test('buildRegistrySnapshotHtml: data: スキームの原簿URLはリンクにせずテキストとして表示する', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000009',
        title: 'Data URL Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'data:text/html,<script>alert(1)</script>',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(!/href\s*=\s*"data:/i.test(html), 'href属性としてdata:が出力されないこと');
    assert.ok(html.includes('data:text/html,'), '値自体はエスケープ済みテキストとして残ること');
});

test('buildRegistrySnapshotHtml: http/https の原簿URLはこれまでどおりリンクになる', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000010',
        title: 'Normal URL Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: 'https://clinicaltrials.gov/study/NCT00000010',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(html.includes('<a href="https://clinicaltrials.gov/study/NCT00000010">'));
});

test('buildRegistrySnapshotHtml: 相対URL・不正な値もリンクにせずテキストとして表示する（例外を投げない）', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000011',
        title: 'Relative URL Study',
        registryName: 'ClinicalTrials.gov',
        sourceUrl: '/relative/path',
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(!/<a href=/i.test(html), '相対URLはリンクにしないこと');
    assert.ok(html.includes('/relative/path'), '値自体はテキストとして残ること');
});

test('buildRegistrySnapshotHtml: trialIdが無ければ「(不明)」を表示する（ref_idを誤って試験IDとして出さない）', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: undefined,
        title: 'No Trial ID Study',
        registryName: 'UMIN-CTR',
        sourceUrl: undefined,
        retrievedAt: '2026-08-27T00:00:00.000Z',
        fields: [],
    });
    assert.ok(html.includes('(不明)'));
});

test('buildRegistrySnapshotHtml: charset=utf-8とlang=jaを持つ', () => {
    const html = buildRegistrySnapshotHtml({
        trialId: 'NCT00000007', title: 'T', registryName: 'R',
        sourceUrl: undefined, retrievedAt: '2026-08-27T00:00:00.000Z', fields: [],
    });
    assert.ok(/<meta charset="utf-8">/i.test(html));
    assert.ok(/<html lang="ja">/i.test(html));
    assert.ok(/@media print/.test(html), '印刷用スタイルを含むこと');
});

// ---------------------------------------------------------------------------
// buildRegistrySnapshotFileName
// ---------------------------------------------------------------------------

test('buildRegistrySnapshotFileName: buildPdfFileNameと同じ命名規約で拡張子だけ.htmlになる', () => {
    const ref = { ref_id: '12345678-abcd-efgh-ijkl-000000000000', title: 'A/B: Study "Name" <Test>' };
    const pdfName = buildPdfFileName(ref);
    const htmlName = buildRegistrySnapshotFileName(ref);

    assert.equal(htmlName, pdfName.replace(/\.pdf$/, '.html'));
    assert.ok(htmlName.endsWith('.html'));
});

test('buildRegistrySnapshotFileName: titleが無ければref_idを使う', () => {
    const ref = { ref_id: 'abcdefgh-0000-0000-0000-000000000000' };
    const name = buildRegistrySnapshotFileName(ref);
    assert.ok(name.startsWith('abcdefgh-0000-0000-0000-000000000000'));
    assert.ok(name.endsWith('[abcdefgh].html'));
});
