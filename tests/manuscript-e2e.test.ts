// 論文用テキスト（Methods / Results / PRISMA）と TiAb エクスポート（CSV/RIS）の通しの検査。
//
// シートの行（tests/fixtures/manuscript-e2e/project.json の string[][]）を、本番の読み込み
// （src/lib/sheets/project-snapshot.ts の loadProjectSnapshot）と同じ順序の既存の変換関数に通して
// 入力を作り、純関数 buildManuscriptOutput() / buildTiabExportCsv() / buildTiabExportRis() の出力を
// 明示的な数値と期待値ファイル（tests/fixtures/manuscript-e2e/expected/）で照合する。
// 期待値ファイルは自動で書き換えない。文面や列を変えるときは、期待値ファイルの差分を人が読んで直す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferenceValues, parseDecisionValues } from '../src/lib/sheets/codecs';
import { collapseToLatestDecisions } from '../src/lib/sheets/decisions';
import { parseConfigBundle, parseAssignmentConfig, parseFulltextAiActiveRound, parseLlmConfig } from '../src/lib/sheets/config-schema';
import { parseLlmRunValues, parseLlmExecutionValues, selectActiveBatchIds } from '../src/lib/sheets/llm-history';
import { mergeReferencesWithAllDecisions } from '../src/lib/reference-status';
import { isLogicallyDeleted } from '../src/lib/duplicate-detect';
import { resolveExcludeReasonItems } from '../src/lib/exclude-reason-config';
import { buildManuscriptBenchmarkSentence, buildManuscriptValidationSentence } from '../src/lib/manuscript-ai';
import { buildManuscriptOutput } from '../src/lib/manuscript-text';
import type { ManuscriptInput, ManuscriptPhase } from '../src/lib/manuscript-text';
import { buildTiabExportCsv, buildTiabExportRis } from '../src/lib/tiab-export';
import type { TiabExportOptions } from '../src/lib/tiab-export';
import { collectReviewerKeys } from '../src/lib/decision-summary';
import type { ReferenceWithStatus } from '../src/lib/types';

const FIXTURE_DIR = 'tests/fixtures/manuscript-e2e';

type ProjectSheets = Record<'References' | 'Decisions' | 'Config' | 'LLM_Runs' | 'LLM_Executions', string[][]>;

function loadSheets(): ProjectSheets {
    return JSON.parse(readFileSync(`${FIXTURE_DIR}/project.json`, 'utf8')) as ProjectSheets;
}

function expected(name: string): string {
    return readFileSync(`${FIXTURE_DIR}/expected/${name}`, 'utf8');
}

// ---- 準備 begin ----
// project-snapshot.ts の loadProjectSnapshot() と同じ順序で、シートの行から集計の入力を作る。
// 通信の代わりに固定データを渡す点だけが違う。

const USER_EMAIL = 'alice@example.com';

interface Loaded {
    input: ManuscriptInput;
    /** state.allReferences 相当（論理削除行を除く、判定を合成済み） */
    references: ReferenceWithStatus[];
    assignmentConfig: ManuscriptInput['assignmentConfig'];
}

function loadProject(phase: ManuscriptPhase, sheets: ProjectSheets = loadSheets()): Loaded {
    const allReferences = parseReferenceValues(sheets.References);
    const decisionsData = collapseToLatestDecisions(parseDecisionValues(sheets.Decisions));
    const configBundle = parseConfigBundle(sheets.Config);
    const assignmentConfig = parseAssignmentConfig(sheets.Config);
    const fulltextAiActiveRound = parseFulltextAiActiveRound(sheets.Config);
    const llmConfig = parseLlmConfig(sheets.Config);
    const llmRuns = parseLlmRunValues(sheets.LLM_Runs);
    const llmExecutions = parseLlmExecutionValues(sheets.LLM_Executions);
    const activeBatchIds = selectActiveBatchIds(llmRuns, llmExecutions);
    const references = mergeReferencesWithAllDecisions(
        allReferences, decisionsData, USER_EMAIL, activeBatchIds, fulltextAiActiveRound, () => undefined
    );
    // showManuscriptModal() と同じ。tiab 相だけ、active かつ confirmed の Run の検証記録を文にする。
    const validationSentence = phase === 'tiab'
        ? llmRuns.filter(run => run.is_active && run.status === 'confirmed')
            .map(buildManuscriptValidationSentence).filter(Boolean).join('\n\n')
        : '';
    const input: ManuscriptInput = {
        phase,
        projectTitle: 'Fixture project',
        generatedDate: '2026-01-01',
        currentVersion: '0.0.0',
        conceptDoiUrl: null,
        evaluationDatasetDoi: '',
        identificationRefs: allReferences,
        refsMayOmitLogicallyDeleted: false,
        references,
        importStats: configBundle.importStats,
        fulltextPoolRule: configBundle.fulltextPoolRule,
        fulltextAssignment: configBundle.fulltextAssignment,
        assignmentConfig,
        treatMlAsManual: false,
        mlStoppingRule: null,
        llmIncludeThreshold: llmConfig.llm_include_threshold,
        llmExecutions,
        validationSentence,
        excludeReasonItems: resolveExcludeReasonItems(configBundle.excludeReasonConfig),
        enabledJudges: null,
        userEmail: USER_EMAIL,
        isKeyOpened: configBundle.keyOpened,
    };
    return { input, references, assignmentConfig };
}
// ---- 準備 end ----

/** 画面側（handleExportCSV/RIS）と同じ規則で、エクスポートの入力を作る。 */
function exportOptions(loaded: Loaded, isBlinded: boolean): TiabExportOptions {
    return {
        isBlinded,
        reviewerKeys: isBlinded ? [] : collectReviewerKeys(loaded.references, new Set(), false),
        treatMlAsManual: false,
        assignmentConfig: loaded.assignmentConfig,
    };
}

test('Identification と PRISMA の数が、シートの行から手で求めた値と一致する', () => {
    const sheets = loadSheets();
    // 固定データの前提（期待値の導出元）を先に固定する。
    assert.equal(sheets.References.length - 1, 14);
    const tiab = buildManuscriptOutput(loadProject('tiab').input);
    const id = tiab.identification;

    // 10 (pubmed.nbib) + 6 (embase.ris)
    assert.equal(id.identifiedTotal, 16);
    assert.deepEqual(id.files, [
        { file: 'embase.ris', identified: 6, hasStats: true },
        { file: 'pubmed.nbib', identified: 10, hasStats: true },
    ]);
    // 2 + 1 (import_stats) + 1 (R13。論理削除した重複)
    assert.equal(id.duplicatesTotal, 4);
    // R01〜R12。R13 は論理削除、R14 は other methods 腕
    assert.equal(id.screened, 12);
    assert.equal(id.statsComplete, true);
    // alice・bob
    assert.equal(tiab.tiabHumanReviewers, 2);
    // database 腕の全文候補 R01〜R06。非 active バッチの AI 票（R07 include）は候補に入らない
    assert.equal(tiab.sought, 6);
    // ML 不使用
    assert.equal(tiab.stoppingRuleExclusions, 0);
    assert.equal(tiab.fulltext, null);
    // TiAb 除外数 = 12 - 6（Results と PRISMA の両方に出る）
    assert.match(tiab.results, /, 6 were excluded, and 6 were retained for full-text review\./);
    assert.match(tiab.prisma, /Records excluded \(n = 6\)/);

    const ft = buildManuscriptOutput(loadProject('fulltext').input);
    assert.equal(ft.identification.identifiedTotal, 16);
    assert.equal(ft.sought, 6);
    assert.ok(ft.fulltext);
    const db = ft.fulltext.database;
    // 全文 未入手 / 評価 = 1 (R01) / 5 (R02〜R06)
    assert.equal(db.sought, 6);
    assert.equal(db.notRetrieved, 1);
    assert.equal(db.obtained, 5);
    // include 2 (R02・R03) / exclude 3 (R04・R05・R06)
    assert.equal(db.include, 2);
    assert.equal(db.exclude, 3);
    // 理由別内訳。件数降順の安定ソートで、同数は候補の並び（R04・R05・R06）の順
    assert.deepEqual(db.reasons, [
        { reason: 'population', count: 1 },
        { reason: 'intervention', count: 1 },
        { reason: 'study_design', count: 1 },
    ]);
    // 判定の不一致は R06 の1件（裁定済みも数える）
    assert.equal(db.conflict, 1);
    assert.equal(db.reasonConflict, 0);
    // R06 は裁定済みなので未解消は 0、裁定は 1
    assert.equal(db.unresolved, 0);
    assert.equal(db.adjudicated, 1);
    // R01（判定なし）
    assert.equal(db.pending, 1);
    assert.equal(db.maybe, 0);
    // other methods 腕は R14 の 1 / 1 / 1
    const rl = ft.fulltext.registryLinkage;
    assert.equal(rl.sought, 1);
    assert.equal(rl.obtained, 1);
    assert.equal(rl.include, 1);
    assert.equal(ft.stoppingRuleExclusions, 0);
    // PRISMA ブロックの数字
    assert.match(ft.prisma, /Reports sought for retrieval \(n = 6\)/);
    assert.match(ft.prisma, /Reports not retrieved \(n = 1\)/);
    assert.match(ft.prisma, /Reports assessed for eligibility \(n = 5\)/);
    assert.match(ft.prisma, /Reports excluded \(n = 3\):/);
    assert.match(ft.prisma, /Studies included in review \(n = 2\)/);
});

test('TiAb 相の文章と警告が期待値ファイルと完全一致する', () => {
    const out = buildManuscriptOutput(loadProject('tiab').input);
    assert.equal(out.methods, expected('tiab-methods.txt'));
    assert.equal(out.results, expected('tiab-results.txt'));
    assert.equal(out.prisma, expected('tiab-prisma.txt'));
    // 未判定の database 腕の文献なし。統計は揃い、キーは開封済み
    assert.deepEqual(out.warnings, []);
});

test('全文相の文章・理由別内訳・警告が期待値ファイルと完全一致する', () => {
    const out = buildManuscriptOutput(loadProject('fulltext').input);
    assert.equal(out.methods, expected('fulltext-methods.txt'));
    assert.equal(out.results, expected('fulltext-results.txt'));
    assert.equal(out.prisma, expected('fulltext-prisma.txt'));
    // pending 1 (R01)、maybe 0、未解消 0
    assert.deepEqual(out.warnings, [{ key: 'manuscript_warnUnresolved', args: ['1', '0', '0'] }]);
    // 理由の英語ラベルが生キーでなく文章に出る
    assert.match(out.results, /Ineligible population \(n = 1\); Ineligible intervention \(n = 1\); Ineligible study design \(n = 1\)/);
});

test('版の範囲と concept DOI・評価データセットの DOI が Methods に出る', () => {
    // 固定データの client_version はすべて 0.57.2 系なので、期待値ファイルは単一の版になる。
    // 1行だけ古い版にして、範囲の書き方を確かめる（TiAb 相は人の判定行、全文相は全文の判定行を書き換える）。
    const sheets = loadSheets();
    const header = sheets.Decisions[0];
    const versionCol = header.indexOf('client_version');
    const phaseCol = header.indexOf('screening_phase');
    const rewrite = (phase: string) => {
        const row = sheets.Decisions.slice(1).find(r => r[phaseCol] === phase && r[versionCol] === '0.57.2-human');
        assert.ok(row, `${phase} の人の判定行がある`);
        row[versionCol] = '0.56.0-human';
    };
    rewrite('tiab');
    rewrite('fulltext');
    for (const phase of ['tiab', 'fulltext'] as const) {
        const input = { ...loadProject(phase, sheets).input, conceptDoiUrl: 'https://doi.org/10.5281/zenodo.1' };
        const out = buildManuscriptOutput(input);
        assert.match(out.methods, /TiAb Review Plugin \(versions 0\.56\.0 to 0\.57\.2; https:\/\/doi\.org\/10\.5281\/zenodo\.1\)/);
    }
});

test('評価データセットの DOI が空なら AI の文だけ、あるときは同じ段落に1文が付く', () => {
    const base = loadProject('tiab').input;
    const without = buildManuscriptOutput(base).methods;
    assert.ok(!without.includes('benchmark'));
    const doi = '10.5281/zenodo.2';
    const withDoi = buildManuscriptOutput({ ...base, evaluationDatasetDoi: doi }).methods;
    const sentence = buildManuscriptBenchmarkSentence(doi);
    assert.ok(withDoi.includes(`, using TiAb Review's screening prompt version fixture-1. ${sentence}\n\n`));
    // 足されるのはこの1文だけ
    assert.equal(withDoi.replace(` ${sentence}`, ''), without);
});

test('判定から版が読めないとき、Methods は現在の版を書く（読めなければ [version]）', () => {
    const noVersion = loadSheets();
    const col = noVersion.Decisions[0].indexOf('client_version');
    for (const row of noVersion.Decisions.slice(1)) row[col] = 'unknown-human';
    const input = loadProject('tiab', noVersion).input;
    assert.match(buildManuscriptOutput({ ...input, currentVersion: '1.2.3' }).methods, /TiAb Review Plugin \(version 1\.2\.3\)/);
    assert.match(buildManuscriptOutput({ ...input, currentVersion: 'unknown' }).methods, /TiAb Review Plugin \(version \[version\]\)/);
});

test('TiAb エクスポート CSV/RIS が期待値ファイルと完全一致する（開封済み・ブラインド中）', () => {
    const loaded = loadProject('tiab');
    const refs = loaded.references;
    // 画面の絞り込みは対象外。References の全件（R13 は論理削除済みで含まれない）
    assert.equal(refs.length, 13);
    assert.ok(refs.every(r => !isLogicallyDeleted(r)));

    const open = exportOptions(loaded, false);
    const blinded = exportOptions(loaded, true);
    const openCsv = buildTiabExportCsv(refs, open);
    const blindedCsv = buildTiabExportCsv(refs, blinded);
    const openRis = buildTiabExportRis(refs, open);
    const blindedRis = buildTiabExportRis(refs, blinded);

    assert.equal(openCsv, expected('tiab-export-open.csv'));
    assert.equal(blindedCsv, expected('tiab-export-blinded.csv'));
    assert.equal(openRis, expected('tiab-export-open.ris'));
    assert.equal(blindedRis, expected('tiab-export-blinded.ris'));

    // (a) 開封済みのヘッダーの並び。判定者キーは人（昇順）、AI(llm:)の順
    const openRows = parseCsv(openCsv);
    assert.deepEqual(openRows[0], [
        'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'issn',
        'doi', 'pmid', 'status', 'team_status', 'n_judged', 'n_expected',
        'alice@example.com', 'bob@example.com', 'llm:gemini-3.1-flash-lite@2026-01-02T00:00:00.000Z',
        'decision_notes', 'note', 'source_file',
    ]);
    const teamStatus = (title: string) => openRows.find(r => r[0] === title)?.[openRows[0].indexOf('team_status')];
    assert.equal(teamStatus('Fixture study R06'), 'conflict');
    assert.equal(teamStatus('Fixture study R01'), 'include');
    // 非 active バッチの AI 票（R07 include）は入らず、人2人と active の AI の exclude で一致する
    assert.equal(teamStatus('Fixture study R07'), 'exclude');
    // 追記専用の履歴。alice の R07 は最新行（メモなし）だけが効き、初回行のメモ 'first pass' は出ない
    const r07 = openRows.find(r => r[0] === 'Fixture study R07')!;
    assert.equal(r07[openRows[0].indexOf('note')], '');
    assert.ok(!openCsv.includes('first pass'));

    // (b) ブラインド中は判定者キーの列と decision_notes が無く、全行 blinded
    const blindedRows = parseCsv(blindedCsv);
    assert.deepEqual(blindedRows[0], [
        'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'issn',
        'doi', 'pmid', 'status', 'team_status', 'n_judged', 'n_expected', 'note', 'source_file',
    ]);
    assert.equal(blindedRows.length - 1, 13);
    const tsIndex = blindedRows[0].indexOf('team_status');
    assert.ok(blindedRows.slice(1).every(r => r[tsIndex] === 'blinded'));
    assert.ok(!blindedRis.includes('C2  - Decisions:'));
    assert.ok(openRis.includes('C2  - Decisions:'));
});

test('エクスポートの判定者別列から Cohen の κ が 5/6 になる', () => {
    // アプリは κ を出さない。ここでは「エクスポートした列から κ を出せる」ことだけを確かめる
    // （R で Decisions を直接読む手順は src/lib/sheets/AGENTS.md の「κの算出手順」）。
    const loaded = loadProject('tiab');
    const rows = parseCsv(buildTiabExportCsv(loaded.references, exportOptions(loaded, false)));
    const header = rows[0];
    const a = header.indexOf('alice@example.com');
    const b = header.indexOf('bob@example.com');
    const pairs = rows.slice(1)
        .map(r => [r[a], r[b]])
        .filter(([x, y]) => x !== '' && y !== '');
    // 2人とも判定した R01〜R12 の12件
    assert.equal(pairs.length, 12);
    const kappa = cohensKappa(pairs);
    // 一致 11（include 5、exclude 6）で po = 11/12。alice の include 6/12、bob の include 5/12 から
    // pe = 0.5 * 5/12 + 0.5 * 7/12 = 0.5。κ = (11/12 - 0.5) / (1 - 0.5) = 5/6
    assert.ok(Math.abs(kappa - 5 / 6) < 1e-9, `kappa = ${kappa}`);
});

/** RFC 4180 の最小実装（引用符・引用符内の改行とコンマ・\r\n）。 */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
        else cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows;
}

function cohensKappa(pairs: string[][]): number {
    const n = pairs.length;
    const labels = [...new Set(pairs.flat())];
    const po = pairs.filter(([x, y]) => x === y).length / n;
    const pe = labels.reduce((sum, label) =>
        sum + (pairs.filter(([x]) => x === label).length / n) * (pairs.filter(([, y]) => y === label).length / n), 0);
    return (po - pe) / (1 - pe);
}
