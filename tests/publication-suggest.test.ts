import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPubmedIdQuery,
    buildEuropePmcQuery,
    dedupePublicationCandidates,
    filterAlreadyImportedCandidates,
    filterNewCandidates,
    discoverPublicationCandidates,
} from '../src/lib/publication-suggest';
import type { PublicationCandidateDraft } from '../src/lib/publication-suggest';
import type { PublicationCandidate } from '../src/lib/types';

// Issue #118 チャンク2 パスB: registration行から結果論文候補を発見するロジックの回帰テスト。
// References への行追加やPublication_Candidatesへの永続化はここでは検証しない
// （永続化は src/lib/sheets-api.ts 側。tests/publication-candidates-headers.test.ts 参照）。

function draft(overrides: Partial<PublicationCandidateDraft> = {}): PublicationCandidateDraft {
    return {
        refId: 'ref-1',
        trialId: 'NCT12345678',
        strategy: 'ctgov_reference',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildPubmedIdQuery
// ---------------------------------------------------------------------------

test('buildPubmedIdQuery: [si] と [tiab] の OR クエリを組み立てる', () => {
    assert.equal(
        buildPubmedIdQuery('NCT12345678'),
        '"NCT12345678"[si] OR "NCT12345678"[tiab]'
    );
});

test('buildPubmedIdQuery: 前後の空白はtrimされる', () => {
    assert.equal(
        buildPubmedIdQuery('  NCT12345678  '),
        '"NCT12345678"[si] OR "NCT12345678"[tiab]'
    );
});

// ---------------------------------------------------------------------------
// buildEuropePmcQuery
// ---------------------------------------------------------------------------

test('buildEuropePmcQuery: 既定は抄録限定クエリ ABSTRACT:"<試験ID>"', () => {
    assert.equal(buildEuropePmcQuery('NCT12345678'), 'ABSTRACT:"NCT12345678"');
});

test('buildEuropePmcQuery: options.fullText:trueで全文検索クエリ "<試験ID>" になる', () => {
    assert.equal(buildEuropePmcQuery('NCT12345678', { fullText: true }), '"NCT12345678"');
});

test('buildEuropePmcQuery: 前後の空白はtrimされる（抄録限定・全文検索の両方）', () => {
    assert.equal(buildEuropePmcQuery('  NCT12345678  '), 'ABSTRACT:"NCT12345678"');
    assert.equal(buildEuropePmcQuery('  NCT12345678  ', { fullText: true }), '"NCT12345678"');
});

// ---------------------------------------------------------------------------
// dedupePublicationCandidates
// ---------------------------------------------------------------------------

test('dedupePublicationCandidates: PMIDが同じ候補は先に見つかった側（先勝ち）を残す', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: '111', strategy: 'ctgov_reference', title: 'From CTGov' }),
        draft({ pmid: '111', strategy: 'pubmed_id', title: 'From PubMed' }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].strategy, 'ctgov_reference');
    assert.equal(result[0].title, 'From CTGov');
});

test('dedupePublicationCandidates: PMIDが無ければDOI（trim・小文字化）で重複排除する', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: undefined, doi: ' 10.1000/ABC ', strategy: 'pubmed_id' }),
        draft({ pmid: undefined, doi: '10.1000/abc', strategy: 'europepmc' }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].strategy, 'pubmed_id');
});

test('dedupePublicationCandidates: PMIDとDOIの片方だけ持つ候補はそのまま残る', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: '111', doi: undefined }),
        draft({ pmid: undefined, doi: '10.1000/xyz' }),
    ]);
    assert.equal(result.length, 2);
});

test('dedupePublicationCandidates: PMIDもDOIも無い候補は捨てる', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: undefined, doi: undefined, title: 'No IDs' }),
        draft({ pmid: '222' }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '222');
});

test('dedupePublicationCandidates: 異なるPMID/DOIの候補はすべて残る', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: '111' }),
        draft({ pmid: '222' }),
        draft({ pmid: undefined, doi: '10.1000/xyz' }),
    ]);
    assert.equal(result.length, 3);
});

test('dedupePublicationCandidates: PMIDのみの候補とDOIのみの候補が同じDOIで重複と判定され除去される（esummaryでDOIが判明した後の状態を想定）', () => {
    // esummaryはPMIDのみだった候補（戦略1/2）へDOIを補完することがある。その後段でDOIのみ
    // 返すEuropePMC候補（戦略3）が同じ論文なら、PMID/DOIどちらのキーだけを見ていても
    // 重複と気づけない。両方のキーを見て初めて重複と判定できることの回帰テスト。
    const result = dedupePublicationCandidates([
        draft({ pmid: '111', doi: '10.1000/abc', strategy: 'pubmed_id' }), // esummaryでDOIが判明した状態
        draft({ pmid: undefined, doi: '10.1000/ABC', strategy: 'europepmc' }), // EuropePMCはDOIのみ返した
    ]);
    assert.equal(result.length, 1, 'PMIDキーとDOIキーのどちらか一方だけでなく両方を見て重複判定すること');
    assert.equal(result[0].strategy, 'pubmed_id', '先に見つかった側（戦略の強い順）が残ること');
});

test('dedupePublicationCandidates: DOIのみ候補が先・PMID+DOI判明の候補が後でも、DOIキーで重複と判定される（対称性）', () => {
    const result = dedupePublicationCandidates([
        draft({ pmid: undefined, doi: '10.1000/xyz', strategy: 'europepmc' }),
        draft({ pmid: '222', doi: '10.1000/XYZ', strategy: 'pubmed_id' }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].strategy, 'europepmc', '先に見つかった側を残す（DOIキーは大文字小文字を無視して一致）');
});

// ---------------------------------------------------------------------------
// filterAlreadyImportedCandidates
// ---------------------------------------------------------------------------

test('filterAlreadyImportedCandidates: PMIDが既存Referencesと一致する候補を除外する', () => {
    const result = filterAlreadyImportedCandidates(
        [draft({ pmid: '111' }), draft({ pmid: '222' })],
        [{ pmid: '111' }]
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '222');
});

test('filterAlreadyImportedCandidates: DOIが既存Referencesと一致する候補を除外する（trim・小文字化して突合）', () => {
    const result = filterAlreadyImportedCandidates(
        [draft({ pmid: undefined, doi: '10.1000/ABC' })],
        [{ doi: ' 10.1000/abc ' }]
    );
    assert.equal(result.length, 0);
});

test('filterAlreadyImportedCandidates: 一致しない候補は残る', () => {
    const result = filterAlreadyImportedCandidates(
        [draft({ pmid: '999' })],
        [{ pmid: '111' }, { doi: '10.1000/xyz' }]
    );
    assert.equal(result.length, 1);
});

// ---------------------------------------------------------------------------
// filterNewCandidates
// ---------------------------------------------------------------------------

function existingCandidate(overrides: Partial<PublicationCandidate> = {}): PublicationCandidate {
    return {
        candidate_id: 'cand-1',
        ref_id: 'ref-1',
        trial_id: 'NCT12345678',
        strategy: 'ctgov_reference',
        status: 'suggested',
        suggested_at: '2026-08-27T00:00:00.000Z',
        ...overrides,
    };
}

test('filterNewCandidates: 同一ref_id かつ 同一PMIDの候補はPublication_Candidatesへ2回目を積まない', () => {
    const result = filterNewCandidates(
        [existingCandidate({ pmid: '111' })],
        [draft({ refId: 'ref-1', pmid: '111' })]
    );
    assert.equal(result.length, 0);
});

test('filterNewCandidates: 同一ref_id かつ 同一DOIの候補も除外する（trim・小文字化して突合）', () => {
    const result = filterNewCandidates(
        [existingCandidate({ pmid: undefined, doi: '10.1000/abc' })],
        [draft({ refId: 'ref-1', pmid: undefined, doi: ' 10.1000/ABC ' })]
    );
    assert.equal(result.length, 0);
});

test('filterNewCandidates: ref_idが異なれば同一PMIDでも新規として残る', () => {
    const result = filterNewCandidates(
        [existingCandidate({ ref_id: 'ref-1', pmid: '111' })],
        [draft({ refId: 'ref-2', pmid: '111' })]
    );
    assert.equal(result.length, 1);
});

test('filterNewCandidates: 一致が無ければそのまま残る', () => {
    const result = filterNewCandidates(
        [existingCandidate({ pmid: '111' })],
        [draft({ refId: 'ref-1', pmid: '222' })]
    );
    assert.equal(result.length, 1);
});

// ---------------------------------------------------------------------------
// discoverPublicationCandidates（fetchスタブ）
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

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

test('discoverPublicationCandidates: 3戦略の結果が統合・重複排除される', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: ['222', '333'] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({
                result: {
                    uids: ['111', '222', '333'],
                    '111': { title: 'CTGov Ref Paper', fulljournalname: 'J1', pubdate: '2023 Jan', articleids: [{ idtype: 'doi', value: '10.1/a' }] },
                    '222': { title: 'PubMed Found Paper', fulljournalname: 'J2', pubdate: '2022', articleids: [] },
                    '333': { title: 'Dup With EuropePMC', fulljournalname: 'J3', pubdate: '2021', articleids: [] },
                },
            }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: {
                    result: [
                        { pmid: '333', doi: '10.1/dup', title: 'Dup (should be discarded, ctgov/pubmed wins)', journalTitle: 'J3-EPMC', pubYear: '2021' },
                        { pmid: '444', doi: '10.1/d', title: 'EuropePMC Only Paper', journalTitle: 'J4', pubYear: '2020' },
                    ],
                },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: ['111'],
        existingRefs: [],
    }, { delayMs: 0 });

    const byPmid = new Map(result.map(c => [c.pmid, c]));
    assert.equal(result.length, 4, 'PMID 111/222/333/444の4件（333はctgov/pubmedどちらにも無いのでpubmed_idの333が優先され、europepmcの333は重複排除される）');
    assert.equal(byPmid.get('111')?.strategy, 'ctgov_reference');
    assert.equal(byPmid.get('111')?.title, 'CTGov Ref Paper');
    assert.equal(byPmid.get('222')?.strategy, 'pubmed_id');
    assert.equal(byPmid.get('333')?.strategy, 'pubmed_id', '333はesearchでも見つかったのでpubmed_id側が先勝ちし、europepmcの333は重複排除される');
    assert.equal(byPmid.get('444')?.strategy, 'europepmc');
    assert.equal(byPmid.get('444')?.title, 'EuropePMC Only Paper');
});

test('discoverPublicationCandidates: esummaryは1リクエストにまとめて呼ばれる（PMIDごとに個別に呼ばない）', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: ['222'] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({
                result: { uids: ['111', '222'], '111': { title: 'A' }, '222': { title: 'B' } },
            }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: ['111'],
        existingRefs: [],
    }, { delayMs: 0 });

    const esummaryCalls = calledUrls.filter(u => u.includes('esummary.fcgi'));
    assert.equal(esummaryCalls.length, 1, 'esummaryは1回しか呼ばれないこと');
    assert.ok(esummaryCalls[0].includes('111') && esummaryCalls[0].includes('222'), '両方のPMIDが同一リクエストのidパラメータに含まれること');
});

test('discoverPublicationCandidates: 1戦略が失敗（非200）しても他戦略の結果が返る', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response('error', { status: 500 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: { result: [{ pmid: '999', title: 'EuropePMC Survivor', journalTitle: 'J', pubYear: '2024' }] },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: [],
        existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '999');
    assert.equal(result[0].strategy, 'europepmc');
});

test('discoverPublicationCandidates: 1戦略がJSON不正でも例外を投げず他戦略の結果が返る', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response('not json', { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: { result: [{ pmid: '888', title: 'Survives JSON error', journalTitle: 'J', pubYear: '2024' }] },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: [],
        existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '888');
});

test('discoverPublicationCandidates: 全戦略が失敗しても例外を投げず空配列を返す', async () => {
    stubFetch([]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: [],
        existingRefs: [],
    }, { delayMs: 0 });

    assert.deepEqual(result, []);
});

test('discoverPublicationCandidates: 既存Referencesと一致する候補は除外される', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: {
                    result: [
                        { pmid: '111', title: 'Already Imported', journalTitle: 'J', pubYear: '2024' },
                        { pmid: '222', title: 'New Candidate', journalTitle: 'J', pubYear: '2024' },
                    ],
                },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: [],
        existingRefs: [{ pmid: '111' }],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '222');
});

test('discoverPublicationCandidates: kind==="other"（NCT以外）でも戦略2・3は動く', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: ['555'] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({ result: { uids: ['555'], '555': { title: 'Found via jRCT search' } } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'jRCT1031210123',
        kind: 'other',
        ctgPmids: [],
        existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '555');
    assert.ok(calledUrls.some(u => u.includes('esearch.fcgi')));
    assert.ok(calledUrls.some(u => u.includes('ebi.ac.uk/europepmc')));
});

test('discoverPublicationCandidates: options.delayMs:0 で高速に完了する（実運用の待機を挟まない）', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    const start = Date.now();
    await discoverPublicationCandidates({
        refId: 'ref-1',
        trialId: 'NCT12345678',
        kind: 'nct',
        ctgPmids: ['111'],
        existingRefs: [],
    }, { delayMs: 0 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 300, `delayMs:0なら350msの既定待機が入らず高速に終わるはず（実測: ${elapsed}ms）`);
});

// ---------------------------------------------------------------------------
// レビュー指摘対応（Sheets APIクォータ・year NaN・EuropePMCパラメータ・eutils tool/email・
// PMID/DOI両キーでの重複排除）
// ---------------------------------------------------------------------------

test('discoverPublicationCandidates: pubYearが非数値でもyearはNaNではなくundefinedになる', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: { result: [{ pmid: '999', title: 'Weird Year', journalTitle: 'J', pubYear: 'n/a' }] },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].year, undefined, '非数値のpubYearはNaNではなくundefinedになること（シートへの"NaN"書き込み防止）');
    assert.ok(!Number.isNaN(result[0].year));
});

test('discoverPublicationCandidates: esummaryのpubdateに年が無くてもyearはNaNではなくundefinedになる', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({
                result: { uids: ['111'], '111': { title: 'No Date', pubdate: '' } },
            }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: ['111'], existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1);
    assert.equal(result[0].year, undefined);
});

test('discoverPublicationCandidates: Europe PMCの1回目は抄録限定クエリ・resultType=lite・pageSize=25で、1件以上ヒットすればフォールバック（2回目）は発生しない', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: { result: [{ pmid: '999', title: 'Found via abstract', journalTitle: 'J', pubYear: '2024' }] },
            }), { status: 200 }),
        },
    ]);

    await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    const epmcUrls = calledUrls.filter(u => u.includes('ebi.ac.uk/europepmc'));
    assert.equal(epmcUrls.length, 1, '1回目が0件でなければEurope PMCへの呼び出しは1回だけ（フォールバックは走らない）');
    const params = new URL(epmcUrls[0]).searchParams;
    assert.equal(params.get('query'), 'ABSTRACT:"NCT12345678"', '1回目は抄録限定クエリであること（全文検索は本文中の言及まで拾いノイズになるため）');
    assert.equal(params.get('resultType'), 'lite', 'pmid/doi/title/journalTitle/pubYearだけで足りるためliteにすること');
    assert.equal(params.get('pageSize'), '25', '既定値に依存せず明示すること');
});

test('discoverPublicationCandidates: Europe PMCの1回目が0件のとき、2回目は全文検索クエリで呼ばれその結果が候補になる', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            // 1回目（抄録限定）は0件。URLのqueryパラメータに'ABSTRACT'が含まれる方を先に判定する。
            match: (url) => url.includes('ebi.ac.uk/europepmc') && url.includes('ABSTRACT'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
        {
            // 2回目（全文検索、フォールバック）は1件ヒットする。
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: { result: [{ pmid: '777', title: 'Found via fallback fulltext', journalTitle: 'J', pubYear: '2024' }] },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    const epmcUrls = calledUrls.filter(u => u.includes('ebi.ac.uk/europepmc'));
    assert.equal(epmcUrls.length, 2, '1回目が0件なら2回目（全文検索）が発生すること');
    assert.equal(new URL(epmcUrls[0]).searchParams.get('query'), 'ABSTRACT:"NCT12345678"', '1回目は抄録限定クエリ');
    assert.equal(new URL(epmcUrls[1]).searchParams.get('query'), '"NCT12345678"', '2回目（フォールバック）は全文検索クエリ');

    assert.equal(result.length, 1);
    assert.equal(result[0].pmid, '777', 'フォールバック（全文検索）の結果が候補として返ること');
    assert.equal(result[0].strategy, 'europepmc', 'フォールバック由来でもstrategyは引き続きeuropepmcであること（新しい戦略値は追加しない）');
});

test('discoverPublicationCandidates: Europe PMCの1回目が非200のとき、フォールバックせずこの戦略をスキップする（失敗を0件と同一視しない）', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response('error', { status: 500 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    const epmcUrls = calledUrls.filter(u => u.includes('ebi.ac.uk/europepmc'));
    assert.equal(epmcUrls.length, 1, '1回目が失敗（非200）のときフォールバック（2回目）は発生しないこと');
    assert.deepEqual(result, [], '失敗時は「0件だった」ことにして全文検索へ広げず、候補を返さないこと');
});

test('discoverPublicationCandidates: Europe PMCの1回目がJSON不正のとき、フォールバックせずこの戦略をスキップする', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response('not json', { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    const epmcUrls = calledUrls.filter(u => u.includes('ebi.ac.uk/europepmc'));
    assert.equal(epmcUrls.length, 1, '1回目がJSON不正のときもフォールバック（2回目）は発生しないこと');
    assert.deepEqual(result, [], '失敗時は候補を返さないこと');
});

test('discoverPublicationCandidates: esearch/esummaryにtool/emailが付く（NCBI E-utilitiesの申告要件）', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: ['111'] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({ result: { uids: ['111'], '111': { title: 'T' } } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
        email: 'reviewer@example.com',
    }, { delayMs: 0 });

    const esearchUrl = calledUrls.find(u => u.includes('esearch.fcgi'));
    const esummaryUrl = calledUrls.find(u => u.includes('esummary.fcgi'));
    assert.ok(esearchUrl && esummaryUrl);
    for (const url of [esearchUrl!, esummaryUrl!]) {
        const params = new URL(url).searchParams;
        assert.equal(params.get('tool'), 'tiab-review-plugin', `enrichNcbiIds()と同じtool申告になっていること: ${url}`);
        assert.equal(params.get('email'), 'reviewer@example.com', `emailが申告されること: ${url}`);
    }
});

test('discoverPublicationCandidates: emailを渡さなくてもesearch/esummaryは呼べる（emailパラメータ無し）', async () => {
    const calledUrls = stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 }),
        },
    ]);

    await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: [], existingRefs: [],
    }, { delayMs: 0 });

    const esearchUrl = calledUrls.find(u => u.includes('esearch.fcgi'));
    assert.ok(esearchUrl);
    const params = new URL(esearchUrl!).searchParams;
    assert.equal(params.get('tool'), 'tiab-review-plugin');
    assert.equal(params.has('email'), false, 'email未指定ならemailパラメータ自体を付けないこと');
});

test('discoverPublicationCandidates: esummaryで判明したDOIとEuropePMCのDOIのみ候補が同一と判定され重複排除される', async () => {
    stubFetch([
        {
            match: (url) => url.includes('esearch.fcgi'),
            respond: () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }),
        },
        {
            match: (url) => url.includes('esummary.fcgi'),
            respond: () => new Response(JSON.stringify({
                result: {
                    uids: ['111'],
                    '111': {
                        title: 'CTGov Paper', fulljournalname: 'J', pubdate: '2023',
                        articleids: [{ idtype: 'doi', value: '10.1000/same' }],
                    },
                },
            }), { status: 200 }),
        },
        {
            match: (url) => url.includes('ebi.ac.uk/europepmc'),
            respond: () => new Response(JSON.stringify({
                resultList: {
                    result: [{ doi: '10.1000/SAME', title: 'Same paper via EuropePMC (no pmid)', journalTitle: 'J', pubYear: '2023' }],
                },
            }), { status: 200 }),
        },
    ]);

    const result = await discoverPublicationCandidates({
        refId: 'ref-1', trialId: 'NCT12345678', kind: 'nct', ctgPmids: ['111'], existingRefs: [],
    }, { delayMs: 0 });

    assert.equal(result.length, 1, 'esummaryでDOIが判明したctgov_reference候補とEuropePMCのDOIのみ候補は同一論文として1件にまとまること');
    assert.equal(result[0].strategy, 'ctgov_reference');
    assert.equal(result[0].pmid, '111');
    assert.equal(result[0].doi, '10.1000/same');
});
