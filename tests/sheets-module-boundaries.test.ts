import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as sheetsApi from '../src/lib/sheets-api';

/**
 * src/lib/sheets-api.ts の分割（Issue #153）で固定した依存方向と
 * 互換窓口の公開面の回帰テスト。
 *
 * テストは .tmp/tests/ 配下にコンパイルされて実行されるため、__dirname ではなく
 * リポジトリルート（npm test の cwd）基準でソースを解決する
 * （tests/decision-item-note-layout.test.ts / tests/drive-shared-drive.test.ts と同じ流儀）。
 */

const SRC_DIR = join(process.cwd(), 'src');
const LIB_DIR = join(SRC_DIR, 'lib');
const SHEETS_DIR = join(LIB_DIR, 'sheets');
const SHEETS_API_FILE = join(LIB_DIR, 'sheets-api.ts');

/** dir 配下の .ts ファイルを再帰的に列挙する（絶対パスの配列） */
function listTsFilesRecursive(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listTsFilesRecursive(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(full);
        }
    }
    return files;
}

/** import/export の `from '...'` 節に書かれたモジュール指定子を列挙する */
function importSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const re = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

// ---------------------------------------------------------------------------
// 依存方向: sheets-api → sheets/* のみ。逆方向（sheets/* → sheets-api）は禁止。
// ---------------------------------------------------------------------------

test('src/lib/sheets/*.ts のどれも互換窓口 sheets-api を import していない', () => {
    const files = listTsFilesRecursive(SHEETS_DIR);
    assert.ok(files.length > 0, 'src/lib/sheets/ 配下にファイルが見つからない');

    const offenders: string[] = [];
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        if (/from\s+['"]\.\.\/sheets-api['"]/.test(source)) {
            offenders.push(file);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'src/lib/sheets/ は互換窓口 sheets-api.ts に依存してはならない（依存方向: sheets-api → sheets/*）'
    );
});

// ---------------------------------------------------------------------------
// schema.ts / codecs.ts は ./types 以外の src モジュールに依存しない純モジュール。
// ---------------------------------------------------------------------------

test('schema.ts / codecs.ts の import は ../types のみ（platform・通信・DOMを持ち込まない）', () => {
    for (const name of ['schema.ts', 'codecs.ts']) {
        const source = readFileSync(join(SHEETS_DIR, name), 'utf8');
        const specifiers = importSpecifiers(source);
        const disallowed = specifiers.filter(s => s !== '../types');

        assert.deepEqual(
            disallowed,
            [],
            `${name} は ../types 以外に依存してはならない: ${disallowed.join(', ')}`
        );
    }
});

// ---------------------------------------------------------------------------
// references.ts / decisions.ts は互いを import しない（Issue #153 工程2）。
// ---------------------------------------------------------------------------

test('references.ts と decisions.ts は互いを import していない', () => {
    const referencesSource = readFileSync(join(SHEETS_DIR, 'references.ts'), 'utf8');
    const decisionsSource = readFileSync(join(SHEETS_DIR, 'decisions.ts'), 'utf8');

    assert.ok(
        !/from\s+['"]\.\/decisions['"]/.test(referencesSource),
        'references.ts は ./decisions を import してはならない'
    );
    assert.ok(
        !/from\s+['"]\.\/references['"]/.test(decisionsSource),
        'decisions.ts は ./references を import してはならない'
    );
});

// ---------------------------------------------------------------------------
// src/lib/sheets/ の利用元は sheets-api.ts（互換窓口）だけに閉じる。
// 分割を機械的な移動に閉じるため、他の src ファイルが直接 sheets/ 配下を
// import すると、次の分割PRで互換窓口を経由しない依存が紛れ込む。
// ---------------------------------------------------------------------------

test('src/ 配下で lib/sheets/ を import しているのは sheets-api.ts と sheets/ 自身だけ', () => {
    const files = listTsFilesRecursive(SRC_DIR);
    const offenders: string[] = [];

    for (const file of files) {
        if (file === SHEETS_API_FILE) continue;
        if (file.startsWith(SHEETS_DIR + sep)) continue;

        const source = readFileSync(file, 'utf8');
        const specifiers = importSpecifiers(source);
        if (specifiers.some(s => /\/sheets\//.test(s))) {
            offenders.push(file);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'src/lib/sheets/ は sheets-api.ts 経由でのみ使うこと（Issue #153 の分割を機械的な移動に閉じるため）'
    );
});

// ---------------------------------------------------------------------------
// 互換窓口の公開面: 移動前に export されていた名前は、移動後も同じ名前で
// sheets-api.ts から export され続けること。
// ---------------------------------------------------------------------------

test('facade: 移動前に export されていた名前が sheets-api.ts から引き続き export される', () => {
    const exportedNames = [
        'SheetsAccessDeniedError',
        'isSheetsAccessDeniedStatus',
        'isQuotaExceededError',
        'getAuthToken',
        'REFERENCES_HEADERS',
        'PUBLICATION_CANDIDATES_HEADERS',
        'DUPLICATE_CANDIDATES_HEADERS',
        'validateReferencesManagedHeaders',
        'ensureHeaders',
        'invalidateFulltextDriveColumnsMemo',
        'validateSpreadsheetFormat',
        'getReferences',
        'getFulltextPageData',
        'loadProjectSnapshot',
        'selectReferencesWithStatus',
        'buildReferenceInsertRow',
        'addReferences',
        'updateReferenceFulltextUrl',
        'updateReferenceFulltextUrls',
        'getReferenceFulltextState',
        'getFulltextClaimsSnapshot',
        'deleteReferencesBySourceFile',
        'updateReferenceScreeningSets',
        'updateReferenceFulltextSets',
        'setDuplicateOf',
        'getDecisions',
        'detectConflict',
        'invalidateDecisionRowCache',
        'saveDecision',
        'appendDecisions',
        'getDecisionsByReviewerId',
        'updateDecisionsBatch',
        'getLlmPendingDecisions',
        'PRESET_RCT',
        'PRESET_SR',
        'parseAssignmentConfig',
        'parseFulltextAiActiveRound',
        'DEFAULT_LLM_CONFIG',
        'getAssignmentConfig',
        'saveAssignmentConfig',
        'getFulltextAssignmentConfig',
        'saveFulltextAssignmentConfig',
        'getProjectConfigBundle',
        'getProjectLoadConfig',
        'getHighlightKeywords',
        'updateConfigKeywords',
        'getFulltextPoolRule',
        'saveFulltextPoolRule',
        'saveReviewCriteria',
        'saveExcludeReasonConfig',
        'saveImportStats',
        'getFulltextAiActiveRound',
        'setFulltextAiActiveRound',
        'getKeyOpenedStatus',
        'setKeyOpenedStatus',
        'getFulltextDriveFolderId',
        'saveFulltextDriveFolderId',
        'getProjectDriveFolderId',
        'saveProjectDriveFolderId',
        'getLlmConfig',
        'updateLlmConfig',
        'clearLlmSheetEnsureMemo',
        'ensureLlmExecutionsSheet',
        'ensureLlmRunsSheet',
        'saveLlmExecution',
        'getLlmExecutions',
        'updateLlmExecution',
        'saveLlmRun',
        'updateLlmRun',
        'getLlmRuns',
        'getLlmHistory',
        'findRunByConfigHash',
        'getActiveLlmRun',
        'getRunForBatchId',
        'getBatchIdsForRun',
        'getJudgedRefIdsForBatches',
        'getActiveBatchIdsForActiveRun',
        'selectActiveBatchIds',
        'selectActiveLlmRun',
        'setSingleActiveRun',
        'ensurePublicationCandidatesSheet',
        'savePublicationCandidates',
        'getPublicationCandidates',
        'updatePublicationCandidateStatus',
        'ensureDuplicateCandidatesSheet',
        'saveDuplicateCandidates',
        'getDuplicateCandidates',
        'updateDuplicateCandidateStatus',
        'getRecentSpreadsheets',
        'getLocalRecentSheets',
        'rememberLocalRecentSheet',
        'getFilePermissions',
        'getSpreadsheetPermissions',
        'DrivePermissionError',
        'deletePermission',
        'addPermission',
        'isUserAdmin',
    ];

    const facade = sheetsApi as unknown as Record<string, unknown>;
    for (const name of exportedNames) {
        assert.notEqual(facade[name], undefined, `sheets-api.ts から ${name} が export されていない`);
    }
});


test('config-schema.ts は通信・シート定義・platform・他タブの読み書きに依存しない', () => {
    const source = readFileSync(join(SHEETS_DIR, 'config-schema.ts'), 'utf8');
    const specifiers = importSpecifiers(source);
    const forbidden = ['./transport', './schema', '../platform', './references', './decisions', './config'];
    const disallowed = specifiers.filter(s => forbidden.includes(s));

    assert.deepEqual(
        disallowed,
        [],
        `config-schema.ts に禁止された依存がある: ${disallowed.join(', ')}`
    );
});

test('llm-history.ts は references.ts / config.ts / config-schema.ts を import していない', () => {
    const source = readFileSync(join(SHEETS_DIR, 'llm-history.ts'), 'utf8');
    const specifiers = importSpecifiers(source);
    const forbidden = ['./references', './config', './config-schema'];
    const disallowed = specifiers.filter(s => forbidden.includes(s));

    assert.deepEqual(
        disallowed,
        [],
        `llm-history.ts に禁止された依存がある: ${disallowed.join(', ')}`
    );
});

test('publication-candidates.ts と duplicate-candidates.ts は他タブのモジュールと互いを import していない', () => {
    for (const name of ['publication-candidates', 'duplicate-candidates']) {
        const source = readFileSync(join(SHEETS_DIR, `${name}.ts`), 'utf8');
        const specifiers = importSpecifiers(source);
        const forbidden = ['./references', './decisions', './config', './config-schema', './llm-history', './publication-candidates', './duplicate-candidates']
            .filter(s => s !== `./${name}`);
        const disallowed = specifiers.filter(s => forbidden.includes(s));

        assert.deepEqual(
            disallowed,
            [],
            `${name}.ts に禁止された依存がある: ${disallowed.join(', ')}`
        );
    }
});

test('config.ts は references.ts と decisions.ts を import していない', () => {
    const source = readFileSync(join(SHEETS_DIR, 'config.ts'), 'utf8');

    assert.ok(
        !/from\s+['"]\.\/references['"]/.test(source),
        'config.ts は ./references を import してはならない'
    );
    assert.ok(
        !/from\s+['"]\.\/decisions['"]/.test(source),
        'config.ts は ./decisions を import してはならない'
    );
});

test('drive-recent-files.ts と drive-permissions.ts は互換窓口と sheets/ を import していない', () => {
    for (const name of ['drive-recent-files.ts', 'drive-permissions.ts']) {
        const source = readFileSync(join(LIB_DIR, name), 'utf8');
        const specifiers = importSpecifiers(source);
        const disallowed = specifiers.filter(s => s === './sheets-api' || s.includes('/sheets/'));

        assert.deepEqual(
            disallowed,
            [],
            `${name} は互換窓口にも sheets/ にも依存してはならない: ${disallowed.join(', ')}`
        );
    }
});

test('判定集約の純関数はsheets・互換窓口・platformに依存しない', () => {
    for (const name of ['reference-status.ts', 'decision-aggregate.ts']) {
        const source = readFileSync(join(LIB_DIR, name), 'utf8');
        const disallowed = importSpecifiers(source).filter(s =>
            s === './sheets-api' || s.includes('/sheets/') || s === './platform' || s === '../platform');
        assert.deepEqual(disallowed, [], `${name} に禁止された依存がある: ${disallowed.join(', ')}`);
    }
});

test('project-snapshot.ts は取得・変換・合成に必要なモジュールだけに依存する', () => {
    const source = readFileSync(join(SHEETS_DIR, 'project-snapshot.ts'), 'utf8');
    const allowed = [
        './references', './decisions', './config', './llm-history', './duplicate-candidates',
        './transport', './codecs', './config-schema', '../reference-status', '../types',
        './schema', '../duplicate-detect',
    ];
    const disallowed = importSpecifiers(source).filter(s => !allowed.includes(s));
    assert.deepEqual(disallowed, [], `project-snapshot.ts に禁止された依存がある: ${disallowed.join(', ')}`);
});
