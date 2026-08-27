import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { retrieveAndCacheFulltext } from '../src/lib/fulltext-retriever';

// Issue #118 チャンク2（パスA）: retrieveAndCacheFulltext() の registration行分岐の回帰テスト。
// - registration行はOAウォーターフォール（PMC OA/Europe PMC/Unpaywall/OpenAlex等）へのfetchを
//   一切発生させず、CTG API または保存済みフィールドからスナップショットを組み立ててDrive保存する
// - 通常論文（record_type未設定/'article'）は従来どおりOAウォーターフォールが走る（リグレッション防止）
// - Drive保存に失敗しても例外を投げず、原簿URLの有無で linked/none にフォールバックする

const mockPlatform: PlatformAdapter = {
    getAuthToken: async () => 'test-token',
    forceReauth: async () => 'test-token',
    clearAuth: async () => {},
    storageGet: async () => ({}),
    storageSet: async () => {},
    storageRemove: async () => {},
    storageClear: async () => {},
    onMessage: () => {},
    emitMessage: () => {},
    getMessage: (key: string) => key,
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
setPlatform(mockPlatform);

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** 呼ばれたURLを記録しつつ、登録済みハンドラで応答するfetchスタブ。未一致URLは404を返す。 */
function stubFetch(handlers: Array<{ match: (url: string) => boolean; respond: () => Response }>) {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        calledUrls.push(url);
        const handler = handlers.find(h => h.match(url));
        if (handler) return handler.respond();
        return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return calledUrls;
}

const DRIVE_UPLOAD_MATCH = (url: string) => url.includes('www.googleapis.com/upload/drive/v3');
const OA_ENDPOINT_MATCHERS = [
    (url: string) => url.includes('pmc.ncbi.nlm.nih.gov/tools/idconv'),
    (url: string) => url.includes('ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi'),
    (url: string) => url.includes('ebi.ac.uk/europepmc'),
    (url: string) => url.includes('api.unpaywall.org'),
    (url: string) => url.includes('api.openalex.org'),
    (url: string) => url.includes('doi.org'),
];

// ---------------------------------------------------------------------------
// (a) registration行: OA系エンドポイントへのfetchが1回も発生せずcachedが返る（NCTあり・CTG API成功）
// ---------------------------------------------------------------------------

test('registration行(NCT): CTG APIを使い、OA系エンドポイントへのfetchは一切発生させずcachedを返す', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('clinicaltrials.gov/api/v2/studies/NCT12345678'),
            respond: () => new Response(JSON.stringify({
                protocolSection: {
                    identificationModule: { officialTitle: 'A Randomized Trial of X' },
                    conditionsModule: { conditions: ['Type 2 Diabetes'] },
                    statusModule: { overallStatus: 'RECRUITING' },
                    // referencesModule 由来PMID。パスB（Issue #118 チャンク2）が
                    // outcome.registryPmids としてそのまま使い回すことをここで確認する。
                    referencesModule: { references: [{ pmid: '87654321' }] },
                },
            }), { status: 200 }),
        },
        {
            match: DRIVE_UPLOAD_MATCH,
            respond: () => new Response(JSON.stringify({ id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' }), { status: 200 }),
        },
    ]);

    const ref = {
        ref_id: 'ref-nct-1',
        title: 'A Randomized Trial of X',
        pmid: 'NCT12345678',
        journal: 'ClinicalTrials.gov',
        source: 'ClinicalTrials.gov',
        record_type: 'registration' as const,
        url: 'https://clinicaltrials.gov/study/NCT12345678',
    };

    const outcome = await retrieveAndCacheFulltext(ref, 'test@example.com', async () => 'folder-1');

    assert.deepEqual(outcome, {
        kind: 'cached', url: 'https://drive.google.com/file/d/file-1/view', source: 'registry',
        // CTGov referencesModule 由来PMID。パスB（論文候補探索）がこれをそのまま使い、
        // CTG APIを2回叩かない配線になっていることの回帰テスト（Issue #118 チャンク2）。
        registryPmids: ['87654321'],
    });
    for (const isOa of OA_ENDPOINT_MATCHERS) {
        assert.ok(!calledUrls.some(isOa), `OA系エンドポイントへfetchが発生した: ${calledUrls.filter(isOa).join(', ')}`);
    }
    assert.ok(calledUrls.some(u => u.includes('clinicaltrials.gov/api/v2/studies/NCT12345678')), 'CTG APIが呼ばれること');
});

test('registration行(NCT以外/jRCT): CTG APIすら呼ばず、保存済みフィールドのみでcachedを返す（ネットワーク不要経路）', async () => {
    const calledUrls = stubFetch([
        {
            match: DRIVE_UPLOAD_MATCH,
            respond: () => new Response(JSON.stringify({ id: 'file-2', webViewLink: 'https://drive.google.com/file/d/file-2/view' }), { status: 200 }),
        },
    ]);

    const ref = {
        ref_id: 'ref-jrct-1',
        title: 'jRCT試験タイトル',
        pmid: 'jRCT1031210123',
        journal: 'ICTRP',
        source: 'jRCT',
        record_type: 'registration' as const,
        url: 'https://jrct.niph.go.jp/latest-detail/jRCT1031210123',
        abstract: 'Condition: 高血圧 | Intervention: 薬剤A',
        year: 2024,
    };

    const outcome = await retrieveAndCacheFulltext(ref, 'test@example.com', async () => 'folder-1');

    assert.deepEqual(outcome, { kind: 'cached', url: 'https://drive.google.com/file/d/file-2/view', source: 'registry', registryPmids: undefined });
    assert.ok(!calledUrls.some(u => u.includes('clinicaltrials.gov')), 'NCT以外はCTG APIを呼ばないこと');
    for (const isOa of OA_ENDPOINT_MATCHERS) {
        assert.ok(!calledUrls.some(isOa), `OA系エンドポイントへfetchが発生した: ${calledUrls.filter(isOa).join(', ')}`);
    }
});

// ---------------------------------------------------------------------------
// (b) 通常論文: 従来どおりOAウォーターフォールが走る（リグレッション防止）
// ---------------------------------------------------------------------------

test('通常論文（record_type未設定）: OAウォーターフォールが従来どおり実行される', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('pmc.ncbi.nlm.nih.gov/tools/idconv'),
            respond: () => new Response(JSON.stringify({ records: [{ status: 'error' }] }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('api.unpaywall.org'),
            respond: () => new Response(JSON.stringify({}), { status: 200 }),
        },
        {
            match: (url) => url.includes('api.openalex.org'),
            respond: () => new Response(JSON.stringify({}), { status: 200 }),
        },
        {
            match: (url) => url.includes('doi.org'),
            respond: () => new Response('not found', { status: 404 }),
        },
    ]);

    const ref = {
        ref_id: 'ref-article-1',
        title: 'Some Regular Article',
        doi: '10.9999/example.doi',
        pmid: '99999999',
        journal: 'The Lancet',
        source: 'PubMed',
    };

    const outcome = await retrieveAndCacheFulltext(ref, 'test@example.com', async () => 'folder-1');

    assert.deepEqual(outcome, { kind: 'none' }, 'どのOAソースも実PDF/openableを返さなければ none');
    assert.ok(calledUrls.some(u => u.includes('ebi.ac.uk/europepmc')), 'Europe PMCへのfetchが発生すること（ウォーターフォールが実行された証跡）');
    assert.ok(calledUrls.some(u => u.includes('api.unpaywall.org')), 'Unpaywallへのfetchが発生すること');
    assert.ok(!calledUrls.some(u => u.includes('clinicaltrials.gov/api/v2')), '通常論文はCTG APIを呼ばないこと');
});

// ---------------------------------------------------------------------------
// (c) Drive保存失敗時のフォールバック（例外を投げない）
// ---------------------------------------------------------------------------

test('registration行: Drive保存(ensureFolder)が失敗し原簿URLがあればlinkedにフォールバックする', async () => {
    stubFetch([]); // どのURLへのfetchも発生しない想定（kind:otherかつネットワーク不要経路）

    const ref = {
        ref_id: 'ref-fail-1',
        title: 'Fail Study',
        pmid: 'UMIN000012345',
        journal: 'ICTRP',
        source: 'UMIN-CTR',
        record_type: 'registration' as const,
        url: 'https://center6.umin.ac.jp/cgi-open-bin/ctr/ctr_view.cgi?recptno=R000012345',
    };

    const outcome = await retrieveAndCacheFulltext(
        ref, 'test@example.com',
        async () => { throw new Error('Drive folder access denied'); }
    );

    assert.deepEqual(outcome, { kind: 'linked', url: ref.url, source: 'registry', registryPmids: undefined });
});

test('registration行: Drive保存が失敗し原簿URLも無ければnoneにフォールバックする（例外を投げない）', async () => {
    stubFetch([]);

    const ref = {
        ref_id: 'ref-fail-2',
        title: 'Fail Study No URL',
        pmid: 'UMIN000099999',
        journal: 'ICTRP',
        source: 'UMIN-CTR',
        record_type: 'registration' as const,
        url: undefined,
    };

    const outcome = await retrieveAndCacheFulltext(
        ref, 'test@example.com',
        async () => { throw new Error('Drive folder access denied'); }
    );

    assert.deepEqual(outcome, { kind: 'none' });
});
