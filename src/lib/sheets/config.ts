// config.ts - Config タブの読み書き
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート名は ./schema を参照。
// 型・既定値・変換は ./config-schema を参照。

import type { AssignmentConfig, ImportStatsMap, LlmConfig } from '../types';
import { parseFulltextPoolRule } from '../fulltext-pool';
import type { FulltextPoolRule } from '../fulltext-pool';
import { serializeReviewCriteria } from '../review-criteria';
import type { ReviewCriteria } from '../review-criteria';
import { serializeExcludeReasonConfig } from '../exclude-reason-config';
import type { ExcludeReasonConfig } from '../exclude-reason-config';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../fulltext-assignment';
import type { FulltextAssignmentConfig } from '../fulltext-assignment';
import {
    getSheetValues,
    updateRange,
    appendRows,
    addSheet,
    isSheetMissingError,
} from './transport';
import { CONFIG_SHEET } from './schema';
import type { HighlightKeywords, ProjectConfigBundle } from './config-schema';
import {
    ASSIGNMENT_CONFIG_KEYS,
    parseAssignmentConfig,
    FT_ASSIGNMENT_CONFIG_KEYS,
    parseFulltextAssignmentRows,
    DEFAULT_CONFIG_BUNDLE,
    parseConfigBundle,
    parseFulltextAiActiveRound,
    DEFAULT_LLM_CONFIG,
    LLM_CONFIG_KEYS,
    parseLlmConfig,
} from './config-schema';

export async function getAssignmentConfig(spreadsheetId: string): Promise<AssignmentConfig> {
    try {
        return parseAssignmentConfig(await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`));
    } catch (error) {
        console.log('[getAssignmentConfig] Config not found, using defaults:', error);
        return parseAssignmentConfig([]);
    }
}

export async function saveAssignmentConfig(spreadsheetId: string, config: AssignmentConfig): Promise<void> {
    try {
        await trySaveAssignmentConfig(spreadsheetId, config);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveAssignmentConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveAssignmentConfig(spreadsheetId, config);
        } else {
            throw error;
        }
    }
}

async function trySaveAssignmentConfig(spreadsheetId: string, config: AssignmentConfig): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    const rowIndices: Record<string, number> = {};

    values.forEach((row, index) => {
        if (ASSIGNMENT_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1;
        }
    });

    const entries: Record<string, string> = {
        assignment_status: config.status,
        assignment_calibration_size: String(config.calibrationSize),
        assignment_group_count: String(config.groupCount),
        assignment_reviewer_map: JSON.stringify(config.reviewerMap || {}),
        assignment_seed: config.seed || '',
        assignment_generated_at: config.generatedAt || '',
        assignment_dismissed_at: config.dismissedAt || '',
    };

    for (const [key, value] of Object.entries(entries)) {
        if (rowIndices[key]) {
            await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndices[key]}`, [[value]]);
        } else {
            await appendRows(spreadsheetId, CONFIG_SHEET, [[key, value]]);
        }
    }
}

export async function getFulltextAssignmentConfig(spreadsheetId: string): Promise<FulltextAssignmentConfig> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseFulltextAssignmentRows(values);
    } catch (error) {
        console.log('[getFulltextAssignmentConfig] Config not found, using defaults:', error);
        return { ...DEFAULT_FULLTEXT_ASSIGNMENT, reviewerMap: {} };
    }
}

export async function saveFulltextAssignmentConfig(
    spreadsheetId: string,
    config: FulltextAssignmentConfig
): Promise<void> {
    try {
        await trySaveFulltextAssignmentConfig(spreadsheetId, config);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveFulltextAssignmentConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveFulltextAssignmentConfig(spreadsheetId, config);
        } else {
            throw error;
        }
    }
}

async function trySaveFulltextAssignmentConfig(
    spreadsheetId: string,
    config: FulltextAssignmentConfig
): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    const rowIndices: Record<string, number> = {};

    values.forEach((row, index) => {
        if (FT_ASSIGNMENT_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1;
        }
    });

    const entries: Record<string, string> = {
        fulltext_assignment_status: config.status,
        fulltext_assignment_group_count: String(config.groupCount),
        fulltext_assignment_reviewer_map: JSON.stringify(config.reviewerMap || {}),
        fulltext_assignment_seed: config.seed || '',
        fulltext_assignment_generated_at: config.generatedAt || '',
    };

    for (const [key, value] of Object.entries(entries)) {
        if (rowIndices[key]) {
            await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndices[key]}`, [[value]]);
        } else {
            await appendRows(spreadsheetId, CONFIG_SHEET, [[key, value]]);
        }
    }
}

/**
 * Config タブの共有設定をまとめて取得（1リクエスト）
 * getKeyOpenedStatus + getHighlightKeywords + getFulltextPoolRule を
 * 個別に呼ぶとConfigを3回読むため、初期ロードではこちらを使うこと（429対策）。
 */
export async function getProjectConfigBundle(spreadsheetId: string): Promise<ProjectConfigBundle> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseConfigBundle(values);
    } catch (error) {
        console.log('[getProjectConfigBundle] Config not found, using defaults:', error);
        return { ...DEFAULT_CONFIG_BUNDLE };
    }
}

/** 初期ロード専用。Config の内容は呼び出し元だけで共有し、保持しない。 */
export async function getProjectLoadConfig(spreadsheetId: string): Promise<{
    configBundle: ProjectConfigBundle;
    assignmentConfig: AssignmentConfig;
    fulltextAiActiveRound: string | null;
}> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return {
            configBundle: parseConfigBundle(values),
            assignmentConfig: parseAssignmentConfig(values),
            fulltextAiActiveRound: parseFulltextAiActiveRound(values),
        };
    } catch (error) {
        console.log('[getProjectLoadConfig] Config not found, using defaults:', error);
        return {
            configBundle: { ...DEFAULT_CONFIG_BUNDLE },
            assignmentConfig: parseAssignmentConfig([]),
            fulltextAiActiveRound: null,
        };
    }
}

/**
 * Config タブからハイライトキーワードを取得
 * Config タブは Key-Value 形式（A列=キー、B列=値）を想定
 * 見つからない場合はデフォルト値を返す
 */
export async function getHighlightKeywords(spreadsheetId: string): Promise<HighlightKeywords> {
    const bundle = await getProjectConfigBundle(spreadsheetId);
    return bundle.keywords;
}

/**
 * Config タブのハイライトキーワードを更新
 */
export async function updateConfigKeywords(
    spreadsheetId: string,
    keywords: HighlightKeywords
): Promise<void> {
    try {
        await tryUpdateConfig(spreadsheetId, keywords);
    } catch (error) {
        // シートがない場合のエラーハンドリング
        // "Unable to parse range: Config!A:B" のようなエラーが返る
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[updateConfigKeywords] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            // 再試行
            await tryUpdateConfig(spreadsheetId, keywords);
        } else {
            console.error('[updateConfigKeywords] Failed:', error);
            throw error;
        }
    }
}

async function tryUpdateConfig(spreadsheetId: string, keywords: HighlightKeywords) {
    // Config シートの全データを取得
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let includeRowIndex = -1;
    let excludeRowIndex = -1;

    // 既存の行を探す
    values.forEach((row, index) => {
        if (row[0] === 'include_keywords') includeRowIndex = index + 1; // 1-indexed
        if (row[0] === 'exclude_keywords') excludeRowIndex = index + 1;
    });

    // include_keywords 更新
    const includeValue = keywords.include.join(',');
    if (includeRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${includeRowIndex}`, [[includeValue]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['include_keywords', includeValue]]);
    }

    // exclude_keywords 更新
    const excludeValue = keywords.exclude.join(',');
    if (excludeRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${excludeRowIndex}`, [[excludeValue]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['exclude_keywords', excludeValue]]);
    }
}

/**
 * フルテキスト候補ルールを取得（未設定・不正値は null）
 */
export async function getFulltextPoolRule(spreadsheetId: string): Promise<FulltextPoolRule | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'fulltext_pool_rule' && row[1]) {
                return parseFulltextPoolRule(row[1]);
            }
        }
        return null;
    } catch (error) {
        console.log('[getFulltextPoolRule] Config not found, returning null:', error);
        return null;
    }
}

/**
 * Config タブへ key=value の1行を保存する（既存なら B列を上書き、無ければ末尾に追記）。
 * fulltext_pool_rule / review_criteria / fulltext_exclude_reasons / import_stats など、
 * Config タブに「1キー1行」で保存する値はすべてこれを経由する
 * （旧実装ではキー名とシリアライザ以外ほぼ同一の関数が4つ並んでいたのを集約した）。
 * Config シート自体が無いプロジェクトでは自動作成してから1回だけリトライする。
 */
async function saveConfigValue(spreadsheetId: string, key: string, value: string): Promise<void> {
    try {
        await trySaveConfigValue(spreadsheetId, key, value);
    } catch (error) {
        // reject の中身が Error とは限らない（Promise.reject(文字列) 等）ため、
        // .message への安全なアクセスに寄せる。
        const message = String((error as { message?: unknown } | undefined)?.message ?? error);
        if (message.includes('Unable to parse range') || message.includes('not found')) {
            console.log(`[saveConfigValue] Config sheet missing, creating... (key=${key})`);
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveConfigValue(spreadsheetId, key, value);
        } else {
            throw error;
        }
    }
}

async function trySaveConfigValue(spreadsheetId: string, key: string, value: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === key) rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [[key, value]]);
    }
}

/**
 * フルテキスト候補ルールを保存
 */
export async function saveFulltextPoolRule(spreadsheetId: string, rule: FulltextPoolRule): Promise<void> {
    await saveConfigValue(spreadsheetId, 'fulltext_pool_rule', JSON.stringify(rule));
}

/**
 * レビュー基準（組入・除外基準）を保存
 */
export async function saveReviewCriteria(spreadsheetId: string, criteria: ReviewCriteria): Promise<void> {
    await saveConfigValue(spreadsheetId, 'review_criteria', serializeReviewCriteria(criteria));
}

/**
 * フルテキスト除外理由リストを Config タブの fulltext_exclude_reasons キーへ保存する
 */
export async function saveExcludeReasonConfig(spreadsheetId: string, config: ExcludeReasonConfig): Promise<void> {
    await saveConfigValue(spreadsheetId, 'fulltext_exclude_reasons', serializeExcludeReasonConfig(config));
}

/**
 * インポート統計を Config タブの import_stats キーへ保存する
 */
export async function saveImportStats(spreadsheetId: string, stats: ImportStatsMap): Promise<void> {
    await saveConfigValue(spreadsheetId, 'import_stats', JSON.stringify(stats));
}

/** 採用中のフルテキストAI判定ラウンド（reviewer_id）を取得。未設定は null。 */
export async function getFulltextAiActiveRound(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseFulltextAiActiveRound(values);
    } catch (error) {
        console.log('[getFulltextAiActiveRound] Config not found:', error);
        return null;
    }
}

/** 採用するフルテキストAI判定ラウンドを設定する（null で採用解除）。 */
export async function setFulltextAiActiveRound(spreadsheetId: string, reviewerId: string | null): Promise<void> {
    try {
        await trySetFulltextAiActiveRound(spreadsheetId, reviewerId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySetFulltextAiActiveRound(spreadsheetId, reviewerId);
        } else {
            throw error;
        }
    }
}

async function trySetFulltextAiActiveRound(spreadsheetId: string, reviewerId: string | null): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;
    values.forEach((row, index) => {
        if (row[0] === 'fulltext_ai_active_round') rowIndex = index + 1;
    });
    const value = reviewerId ?? '';
    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['fulltext_ai_active_round', value]]);
    }
}

/**
 * キーオープン状態を取得
 */
export async function getKeyOpenedStatus(spreadsheetId: string): Promise<boolean> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'key_opened') {
                return row[1]?.toLowerCase() === 'true';
            }
        }
        return false;
    } catch (error) {
        console.log('[getKeyOpenedStatus] Config not found, returning false:', error);
        return false;
    }
}

/**
 * キーオープン状態を設定
 */
export async function setKeyOpenedStatus(spreadsheetId: string, opened: boolean): Promise<void> {
    try {
        await trySetKeyOpened(spreadsheetId, opened);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[setKeyOpenedStatus] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySetKeyOpened(spreadsheetId, opened);
        } else {
            throw error;
        }
    }
}

async function trySetKeyOpened(spreadsheetId: string, opened: boolean) {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let keyOpenedRowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'key_opened') keyOpenedRowIndex = index + 1;
    });

    const value = opened ? 'true' : 'false';
    if (keyOpenedRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${keyOpenedRowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['key_opened', value]]);
    }
}

/**
 * フルテキストPDF保存用 Drive フォルダIDを取得（未設定は null）。
 * Config タブが本当に無い場合だけ null を返す。アクセス拒否・一時エラーは
 * 「未設定」に見せず throw する（呼び出し元の ensureFulltextFolder が誤ってフォルダを
 * 作り直さないようにするため。詳細は drive-api.ts の resolveFolderState 参照）。
 */
export async function getFulltextDriveFolderId(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'fulltext_drive_folder' && row[1]) {
                return row[1];
            }
        }
        return null;
    } catch (error) {
        if (isSheetMissingError(error)) {
            console.log('[getFulltextDriveFolderId] Config not found, returning null:', error);
            return null;
        }
        throw error;
    }
}

/**
 * フルテキストPDF保存用 Drive フォルダIDを保存
 */
export async function saveFulltextDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    try {
        await trySaveFulltextDriveFolderId(spreadsheetId, folderId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveFulltextDriveFolderId] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveFulltextDriveFolderId(spreadsheetId, folderId);
        } else {
            throw error;
        }
    }
}

async function trySaveFulltextDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'fulltext_drive_folder') rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[folderId]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['fulltext_drive_folder', folderId]]);
    }
}

/**
 * プロジェクト用 Drive フォルダIDを取得（未設定は null）
 * このフォルダ配下にスプレッドシート本体と fulltext サブフォルダを格納する。
 * Config タブが本当に無い場合だけ null を返す。アクセス拒否・一時エラーは
 * 「未設定」に見せず throw する（isSheetMissingError のコメント参照）。
 */
export async function getProjectDriveFolderId(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'project_drive_folder' && row[1]) {
                return row[1];
            }
        }
        return null;
    } catch (error) {
        if (isSheetMissingError(error)) {
            console.log('[getProjectDriveFolderId] Config not found, returning null:', error);
            return null;
        }
        throw error;
    }
}

/**
 * プロジェクト用 Drive フォルダIDを保存
 */
export async function saveProjectDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    try {
        await trySaveProjectDriveFolderId(spreadsheetId, folderId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveProjectDriveFolderId] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveProjectDriveFolderId(spreadsheetId, folderId);
        } else {
            throw error;
        }
    }
}

async function trySaveProjectDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'project_drive_folder') rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[folderId]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['project_drive_folder', folderId]]);
    }
}

/**
 * ConfigシートからLLM設定を取得
 */
export async function getLlmConfig(spreadsheetId: string): Promise<LlmConfig> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseLlmConfig(values);
    } catch (error) {
        console.log('[getLlmConfig] Config not found, using defaults:', error);
        return { ...DEFAULT_LLM_CONFIG };
    }
}

/**
 * LLM設定を更新
 */
export async function updateLlmConfig(
    spreadsheetId: string,
    updates: Partial<LlmConfig>
): Promise<void> {
    try {
        await tryUpdateLlmConfig(spreadsheetId, updates);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[updateLlmConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await tryUpdateLlmConfig(spreadsheetId, updates);
        } else {
            throw error;
        }
    }
}

async function tryUpdateLlmConfig(spreadsheetId: string, updates: Partial<LlmConfig>): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);

    // 既存行のインデックスをマップ
    const rowIndices: Record<string, number> = {};
    values.forEach((row, index) => {
        if (LLM_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1; // 1-indexed
        }
    });

    // 各キーを更新
    for (const [key, value] of Object.entries(updates)) {
        if (!LLM_CONFIG_KEYS.includes(key)) continue;

        let stringValue: string;
        if (typeof value === 'boolean') {
            stringValue = value ? 'true' : 'false';
        } else if (typeof value === 'object' && value !== null) {
            stringValue = JSON.stringify(value);
        } else if (value === null) {
            stringValue = '';
        } else {
            stringValue = String(value);
        }

        if (rowIndices[key]) {
            await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndices[key]}`, [[stringValue]]);
        } else {
            await appendRows(spreadsheetId, CONFIG_SHEET, [[key, stringValue]]);
        }
    }
}
