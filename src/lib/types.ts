// types.ts - 型定義

export interface Reference {
    ref_id: string;           // UUID
    title: string;
    abstract?: string;
    year?: number;
    authors?: string;
    journal?: string;
    volume?: string;          // 巻
    issue?: string;           // 号
    pages?: string;           // ページ
    issn?: string;            // ISSN
    doi?: string;
    pmid?: string;
    url?: string;
    source?: string;
    source_file?: string;     // Import source filename
    imported_at?: string;     // ISO 8601
    imported_by?: string;     // email
    dedupe_key?: string;
    screening_set?: string;   // 担当セットID
}

export interface AssignmentConfig {
    status: 'none' | 'dismissed' | 'configured';
    calibrationSize: number;
    groupCount: number;
    reviewerMap: Record<string, string[]>;
    seed?: string;
    generatedAt?: string;
    dismissedAt?: string;
}

export interface Decision {
    decision_id: string;      // UUID
    ref_id: string;
    reviewer_id: string;      // email
    decision: 'include' | 'exclude' | 'maybe' | 'pending';
    reason?: string;          // exclude時必須
    note?: string;
    decided_at: string;       // ISO 8601
    client_version?: string;
    source_url?: string;
}

export interface ReviewerState {
    email: string;
    spreadsheetId: string;
    lastSyncedAt?: string;
    offlineQueue: Decision[];
}

export type DecisionStatus = 'pending' | 'include' | 'exclude' | 'maybe' | 'conflict';

export interface ReferenceWithStatus extends Reference {
    myDecision?: Decision;
    status: DecisionStatus;
    allDecisions?: Decision[];  // キーオープン後に全レビュアーの判定を保持
    hasConflict?: boolean;       // 不一致フラグ
}

export interface Config {
    spreadsheetId: string;
    referencesSheetName: string;
    decisionsSheetName: string;
}

// LLM関連の型定義

/**
 * LLM設定（Configシートに保存）
 */
export interface LlmConfig {
    llm_enabled: boolean;
    llm_model: string;
    llm_temperature: number;
    llm_thinking: 'low' | 'high';
    llm_protocol_text: string;
    llm_criteria: LlmCriteria | null;
    llm_screening_prompt: string;
    llm_include_threshold: number;
    llm_max_output_tokens: number;
    llm_output_language: string;
}

/**
 * LLM基準（PICO形式等）
 */
export interface LlmCriteria {
    template: 'pico' | 'peco' | 'spider' | 'custom';
    fields: Record<string, string>;
}

/**
 * LLM実行履歴（LLM_Executionsシートに保存）
 */
export interface LlmExecution {
    execution_id: string;
    execution_type: 'prompt_generation' | 'batch_screening';
    timestamp: string;
    model: string;
    // Model parameters (for traceability)
    temperature?: number;
    topP?: number;
    thinkingLevel?: string;
    // Screening settings
    criteria_snapshot: LlmCriteria | null;
    screening_prompt: string;
    include_threshold: number;
    target_count: number;
    include_count: number;
    exclude_count: number;
    status: 'pending' | 'confirmed';  // 確定状態
    is_active: boolean;               // 判定に使用するか
}

/**
 * LLMスクリーニング出力のエビデンス項目
 */
export interface LlmEvidence {
    field: 'title' | 'abstract';
    quote: string;
    start_char: number;
    end_char: number;
}

/**
 * LLMスクリーニング出力
 */
export interface LlmScreeningOutput {
    include_probability: number;
    reasons: string[];
    evidence: LlmEvidence[];
}

/**
 * Gemini API usageMetadata
 */
export interface UsageMetadata {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
}

/**
 * LLM判定のnoteフィールドに保存する構造
 */
export interface LlmDecisionNote {
    type: 'llm';
    execution_id: string;
    model: string;
    include_probability: number;
    reasons: string[];
    evidence: LlmEvidence[];
    prompt_version: string;
    usageMetadata?: UsageMetadata;
    // LLM 出力解析失敗時のフォールバック印（true なら include 1.0 で安全側に倒したケース）
    parse_error?: boolean;
    error_message?: string;
}

/**
 * バッチ処理の進捗状態
 */
export interface LlmBatchProgress {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    parseErrorFallback: number;  // LLM 出力解析失敗で確率 1.0 として保存した件数
    isRunning: boolean;
    currentRefId?: string;
}

// API Tier関連の型定義

/**
 * API キーテスト時の自動分類結果（Free / Paid の二値）
 * Gemini API は「Tier いくつか」を返さないため、可視モデル数で粗く分類する
 */
export type ApiTier = 'free' | 'paid' | 'unknown';

/**
 * ユーザが手動で指定する詳細 tier
 * - free: 自動判定で確定（変更不可）
 * - tier1/tier2/tier3: paid 検出時にユーザが選択
 */
export type ManualTier = 'free' | 'tier1' | 'tier2' | 'tier3';

/**
 * レート制限設定
 */
export interface RateLimitConfig {
    concurrency: number;          // 同時実行数
    delayBetweenRequests: number; // リクエスト間のwait (ms)
}

/**
 * バッチ実行プロファイル（並列度・スロット滞在時間・保存単位）
 */
export interface BatchProfile {
    rate: RateLimitConfig;
    saveBatchSize: number;
}

/**
 * APIキーテスト結果
 */
export interface ApiKeyTestResult {
    isValid: boolean;
    tier: ApiTier;
    availableModels: string[];
}

/**
 * Tier 別バッチ実行プロファイル
 * 想定 API レイテンシ 3〜5秒/件、Gemini 公式の RPM 上限を基準に
 * リトライバースト分のマージンを残して設定。
 */
export const BATCH_PROFILES: Record<ManualTier, BatchProfile> = {
    free: {
        rate: { concurrency: 1, delayBetweenRequests: 13000 }, // RPM 5
        saveBatchSize: 5,
    },
    tier1: {
        rate: { concurrency: 10, delayBetweenRequests: 300 },  // 実効 ~180 RPM (cap 300)
        saveBatchSize: 10,
    },
    tier2: {
        rate: { concurrency: 20, delayBetweenRequests: 150 },  // 実効 ~370 RPM (cap 2000)
        saveBatchSize: 25,
    },
    tier3: {
        rate: { concurrency: 30, delayBetweenRequests: 100 },  // 実効 ~580 RPM (cap 4000+)
        saveBatchSize: 40,
    },
};

/**
 * 旧API（後方互換のため残置）
 * 新規コードは BATCH_PROFILES を直接参照すること。
 */
export const RATE_LIMIT_FREE: RateLimitConfig = BATCH_PROFILES.free.rate;
export const RATE_LIMIT_PAID: RateLimitConfig = BATCH_PROFILES.tier1.rate;
export const RATE_LIMIT_TIER2: RateLimitConfig = BATCH_PROFILES.tier2.rate;
