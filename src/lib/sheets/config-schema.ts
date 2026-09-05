// config-schema.ts - Config タブの型・既定値・純粋な変換
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信・platform・DOM に依存しない。
// Config タブの読み書きに使う型・既定値・変換を置く。

import type { AssignmentConfig, ImportStatsMap, LlmConfig } from '../types';
import { MODEL_ID_MIGRATIONS } from '../model-migrations';
import { parseLlmTargetMode, parseTargetRefIds, serializeTargetRefIds } from '../llm-target-selection';
import { parseFulltextPoolRule } from '../fulltext-pool';
import type { FulltextPoolRule } from '../fulltext-pool';
import { parseReviewCriteria } from '../review-criteria';
import type { ReviewCriteria } from '../review-criteria';
import { parseExcludeReasonConfig } from '../exclude-reason-config';
import type { ExcludeReasonConfig } from '../exclude-reason-config';
import { DEFAULT_FULLTEXT_ASSIGNMENT, normalizeFulltextReviewerMap } from '../fulltext-assignment';
import type { FulltextAssignmentConfig } from '../fulltext-assignment';

// デフォルトハイライトキーワード（RCT フィルタリング想定）
export const PRESET_RCT = {
    include: [
        'randomized', 'randomised', 'RCT', 'controlled trial',
        'random allocation', 'randomly assigned', 'randomly allocated', 'placebo'
    ],
    exclude: [
        'animal', 'mice', 'rat', 'in vitro', 'cell line',
        'protocol', 'review', 'meta-analysis', 'case report', 'case series',
        'commentary', 'editorial', 'letter', 'conference'
    ]
};

// システマティックレビュー（SR）用プリセット
export const PRESET_SR = {
    include: [
        'systematic review', 'meta-analysis', 'network meta-analysis', 'pooled analysis',
        'search strategy', 'database search', 'risk of bias', 'quality assessment',
        'eligibility criteria', 'selection criteria'
    ],
    exclude: [
        'case report', 'case series', 'editorial', 'commentary', 'letter',
        'protocol', 'narrative review', 'overview', 'animal', 'mice', 'rat',
        'in vitro', 'cell line'
    ]
};

const DEFAULT_INCLUDE_KEYWORDS = PRESET_RCT.include;

const DEFAULT_EXCLUDE_KEYWORDS = PRESET_RCT.exclude;

const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

/**
 * ハイライトキーワードの型
 */
export interface HighlightKeywords {
    include: string[];
    exclude: string[];
}

export const ASSIGNMENT_CONFIG_KEYS = [
    'assignment_status',
    'assignment_calibration_size',
    'assignment_group_count',
    'assignment_reviewer_map',
    'assignment_seed',
    'assignment_generated_at',
    'assignment_dismissed_at',
];

/** 取得済みの Config 値から担当割り振りを組み立てる。 */
export function parseAssignmentConfig(values: string[][]): AssignmentConfig {
    const config: AssignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} };

    for (const row of values) {
        const key = row[0];
        const value = row[1];

        if (!ASSIGNMENT_CONFIG_KEYS.includes(key) || !value) continue;

        switch (key) {
            case 'assignment_status':
                if (value === 'dismissed' || value === 'configured' || value === 'none') {
                    config.status = value;
                }
                break;
            case 'assignment_calibration_size':
                config.calibrationSize = parseInt(value, 10) || DEFAULT_ASSIGNMENT_CONFIG.calibrationSize;
                break;
            case 'assignment_group_count':
                config.groupCount = parseInt(value, 10) || DEFAULT_ASSIGNMENT_CONFIG.groupCount;
                break;
            case 'assignment_reviewer_map':
                try {
                    config.reviewerMap = JSON.parse(value) || {};
                } catch {
                    config.reviewerMap = {};
                }
                break;
            case 'assignment_seed':
                config.seed = value;
                break;
            case 'assignment_generated_at':
                config.generatedAt = value;
                break;
            case 'assignment_dismissed_at':
                config.dismissedAt = value;
                break;
        }
    }
    return config;
}

// ---------------------------------------------------------------------------
// フルテキスト担当割り振り（Config シート fulltext_assignment_* キー）
// ---------------------------------------------------------------------------

export const FT_ASSIGNMENT_CONFIG_KEYS = [
    'fulltext_assignment_status',
    'fulltext_assignment_group_count',
    'fulltext_assignment_reviewer_map',
    'fulltext_assignment_seed',
    'fulltext_assignment_generated_at',
];

/** Config タブの A:B 行列から FulltextAssignmentConfig を組み立てる */
export function parseFulltextAssignmentRows(values: string[][]): FulltextAssignmentConfig {
    const config: FulltextAssignmentConfig = { ...DEFAULT_FULLTEXT_ASSIGNMENT, reviewerMap: {} };

    for (const row of values) {
        const key = row[0];
        const value = row[1];
        if (!FT_ASSIGNMENT_CONFIG_KEYS.includes(key) || !value) continue;

        switch (key) {
            case 'fulltext_assignment_status':
                if (value === 'configured' || value === 'none') {
                    config.status = value;
                }
                break;
            case 'fulltext_assignment_group_count':
                config.groupCount = parseInt(value, 10) || DEFAULT_FULLTEXT_ASSIGNMENT.groupCount;
                break;
            case 'fulltext_assignment_reviewer_map':
                try {
                    config.reviewerMap = normalizeFulltextReviewerMap(JSON.parse(value) || {});
                } catch {
                    config.reviewerMap = {};
                }
                break;
            case 'fulltext_assignment_seed':
                config.seed = value;
                break;
            case 'fulltext_assignment_generated_at':
                config.generatedAt = value;
                break;
        }
    }

    return config;
}

/**
 * Config タブの共有設定（キー開封・キーワード・フルテキスト候補ルール）
 */
export interface ProjectConfigBundle {
    keyOpened: boolean;
    keywords: HighlightKeywords;
    fulltextPoolRule: FulltextPoolRule | null;
    // 採用するフルテキストAI判定ラウンド（reviewer_id = `llm:{model}@{timestamp}`）。未設定は null。
    fulltextAiActiveRound: string | null;
    // ブラインド中（AI判断 非開示時）のAI evidence 表示レベル。実験条件（ヒト単独 vs AI支援）の制御に使う。
    fulltextEvidenceDisplay: FulltextEvidenceDisplay;
    // インポート統計（PRISMA識別件数・重複除去数の自動記入用）
    importStats: ImportStatsMap;
    // フルテキスト担当割り振り（未設定は status 'none' = 全員が全候補）
    fulltextAssignment: FulltextAssignmentConfig;
    // レビュー基準（人間レビュアー向けの表示用。AI 判定用の llm_criteria とは別物）
    reviewCriteria: ReviewCriteria | null;
    // フルテキスト除外理由リスト（未設定は null = 既定のPICO7区分）
    excludeReasonConfig: ExcludeReasonConfig | null;
}

/**
 * ブラインド中のAI evidence（ハイライト・根拠カード）の表示レベル。
 * Config タブのキー `fulltext_evidence_display` で共有設定する。
 * - none:    evidence 自体を表示しない（AI判定なしの文献と見分けが付かない表示にする）
 * - neutral: 単色ハイライト＋「AI注目箇所」ラベルのみ（polarity 非表示。既定値）
 * - full:    ブラインド中でも組入/除外の色分け・ラベルまで表示する
 * AI判断の開示時（keyOpened / 管理者トグル）は設定によらず full 相当で表示する。
 */
export type FulltextEvidenceDisplay = 'none' | 'neutral' | 'full';

function parseFulltextEvidenceDisplay(value: string | undefined): FulltextEvidenceDisplay {
    const v = (value ?? '').trim().toLowerCase();
    return v === 'none' || v === 'neutral' || v === 'full' ? v : 'neutral';
}

export const DEFAULT_CONFIG_BUNDLE: ProjectConfigBundle = {
    keyOpened: false,
    keywords: { include: DEFAULT_INCLUDE_KEYWORDS, exclude: DEFAULT_EXCLUDE_KEYWORDS },
    fulltextPoolRule: null,
    fulltextAiActiveRound: null,
    fulltextEvidenceDisplay: 'neutral',
    importStats: {},
    fulltextAssignment: { ...DEFAULT_FULLTEXT_ASSIGNMENT },
    reviewCriteria: null,
    excludeReasonConfig: null,
};

/**
 * Config タブの import_stats 値（JSON）をパースする。不正値は空として扱う。
 */
function parseImportStats(value: string | undefined): ImportStatsMap {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const stats: ImportStatsMap = {};
        for (const [file, raw] of Object.entries(parsed as Record<string, unknown>)) {
            if (!raw || typeof raw !== 'object') continue;
            const entry = raw as Record<string, unknown>;
            const identified = Number(entry.identified);
            const duplicates = Number(entry.duplicates);
            if (!Number.isFinite(identified) || !Number.isFinite(duplicates)) continue;
            stats[file] = {
                identified,
                duplicates,
                imported_at: typeof entry.imported_at === 'string' ? entry.imported_at : undefined,
            };
        }
        return stats;
    } catch {
        return {};
    }
}

/**
 * Config タブ（Key-Value 形式: A列=キー、B列=値）のシート値を共有設定に変換
 */
export function parseConfigBundle(values: string[][]): ProjectConfigBundle {
    let includeKeywords = DEFAULT_INCLUDE_KEYWORDS;
    let excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS;
    let keyOpened = false;
    let fulltextPoolRule: FulltextPoolRule | null = null;
    let fulltextAiActiveRound: string | null = null;
    let fulltextEvidenceDisplay: FulltextEvidenceDisplay = 'neutral';
    let importStats: ImportStatsMap = {};
    let reviewCriteria: ReviewCriteria | null = null;
    let excludeReasonConfig: ExcludeReasonConfig | null = null;

    for (const row of values) {
        if (row[0] === 'include_keywords' && row[1]) {
            const keywords = row[1]
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            if (keywords.length > 0) {
                includeKeywords = keywords;
            }
        }
        if (row[0] === 'exclude_keywords' && row[1]) {
            const keywords = row[1]
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            if (keywords.length > 0) {
                excludeKeywords = keywords;
            }
        }
        if (row[0] === 'key_opened') {
            keyOpened = row[1]?.toLowerCase() === 'true';
        }
        if (row[0] === 'fulltext_pool_rule' && row[1]) {
            fulltextPoolRule = parseFulltextPoolRule(row[1]);
        }
        if (row[0] === 'fulltext_ai_active_round') {
            fulltextAiActiveRound = row[1] ? row[1].trim() || null : null;
        }
        if (row[0] === 'fulltext_evidence_display') {
            fulltextEvidenceDisplay = parseFulltextEvidenceDisplay(row[1]);
        }
        if (row[0] === 'import_stats' && row[1]) {
            importStats = parseImportStats(row[1]);
        }
        if (row[0] === 'review_criteria') {
            reviewCriteria = parseReviewCriteria(row[1]);
        }
        if (row[0] === 'fulltext_exclude_reasons') {
            excludeReasonConfig = parseExcludeReasonConfig(row[1]);
        }
    }

    return {
        keyOpened,
        keywords: { include: includeKeywords, exclude: excludeKeywords },
        fulltextPoolRule,
        fulltextAiActiveRound,
        fulltextEvidenceDisplay,
        importStats,
        fulltextAssignment: parseFulltextAssignmentRows(values),
        reviewCriteria,
        excludeReasonConfig,
    };
}

// ---------------------------------------------------------------------------
// フルテキストAI判定の採用ラウンド（reviewer_id = `llm:{model}@{timestamp}`）
// ---------------------------------------------------------------------------

/** 取得済みの Config 値から採用ラウンドを取得する（最初の一致を採用）。 */
export function parseFulltextAiActiveRound(values: string[][]): string | null {
    for (const row of values) {
        if (row[0] === 'fulltext_ai_active_round') {
            const v = (row[1] || '').trim();
            return v || null;
        }
    }
    return null;
}

/**
 * デフォルトのLLM設定
 */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
    llm_enabled: false,
    llm_model: 'gemini-3.1-flash-lite',
    llm_temperature: 0,
    llm_thinking: 'low',
    llm_protocol_text: '',
    llm_criteria: null,
    llm_screening_prompt: '',
    llm_include_threshold: 0.3,
    llm_max_output_tokens: 2048,
    llm_output_language: 'ja',
    llm_target_mode: 'all',
    llm_target_ref_ids: '',
};

/**
 * LLM設定キーのリスト
 */
export const LLM_CONFIG_KEYS = [
    'llm_enabled',
    'llm_model',
    'llm_temperature',
    'llm_thinking',
    'llm_protocol_text',
    'llm_criteria',
    'llm_screening_prompt',
    'llm_include_threshold',
    'llm_max_output_tokens',
    'llm_output_language',
    'llm_target_mode',
    'llm_target_ref_ids',
];

/** 取得済みの Config 値から LLM 設定を組み立てる（未設定キーは既定値）。 */
export function parseLlmConfig(values: string[][]): LlmConfig {
    const config = { ...DEFAULT_LLM_CONFIG };

    for (const row of values) {
        const key = row[0];
        const value = row[1];

        if (!LLM_CONFIG_KEYS.includes(key) || !value) continue;

        switch (key) {
            case 'llm_enabled':
                config.llm_enabled = value.toLowerCase() === 'true';
                break;
            case 'llm_model':
                // latest エイリアスを固定バージョン ID へマイグレーション
                // (2026-05 以降の保存値は固定 ID。既存シートの latest 値はここで透過的に変換)
                config.llm_model = MODEL_ID_MIGRATIONS[value] || value;
                break;
            case 'llm_temperature':
                config.llm_temperature = parseFloat(value) || 0;
                break;
            case 'llm_thinking':
                config.llm_thinking = value === 'high' ? 'high' : 'low';
                break;
            case 'llm_protocol_text':
                config.llm_protocol_text = value;
                break;
            case 'llm_criteria':
                try {
                    config.llm_criteria = JSON.parse(value);
                } catch {
                    config.llm_criteria = null;
                }
                break;
            case 'llm_screening_prompt':
                config.llm_screening_prompt = value;
                break;
            case 'llm_include_threshold':
                config.llm_include_threshold = parseFloat(value) || 0.3;
                break;
            case 'llm_max_output_tokens':
                config.llm_max_output_tokens = parseInt(value, 10) || 2048;
                break;
            case 'llm_output_language':
                config.llm_output_language = value;
                break;
            case 'llm_target_mode':
                config.llm_target_mode = parseLlmTargetMode(value);
                break;
            case 'llm_target_ref_ids':
                // シート直編集で混じる改行・重複・空白をここで正規化する
                config.llm_target_ref_ids = serializeTargetRefIds(parseTargetRefIds(value));
                break;
        }
    }

    return config;
}
