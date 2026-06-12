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
    fulltext_url?: string;    // フルテキストURL (OA / ブラウザアタッチ)
    fulltext_status?: 'not_retrieved' | 'retrieved' | 'unavailable';
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
    screening_phase?: 'tiab' | 'fulltext';  // 省略時は 'tiab' として扱う（後方互換）
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
    hasAnyLlmDecision?: boolean; // LLM バッチで判定済みか（pending/confirmed/inactive を問わず）
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
 *
 * Run/Batch 分離後の役割:
 * - 1 row = 1 物理バッチ実行（API 呼び出し単位）
 * - execution_id は Decisions.reviewer_id との結合キー（後方互換のため変更不可）
 * - run_id は所属する Run（LLM_Runs）への外部キー
 * - include_threshold / status / is_active は LLM_Runs 側を正とし、ここでは
 *   既存データ・他ツール互換のため列のみ残す（書き込みは停止予定）
 */
export interface LlmExecution {
    execution_id: string;
    execution_type: 'prompt_generation' | 'batch_screening';
    timestamp: string;
    model: string;
    requested_model?: string;
    model_version?: string;
    response_id?: string;
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
    status: 'pending' | 'confirmed';  // 確定状態（Run 側を正とする）
    is_active: boolean;               // 判定に使用するか（Run 側を正とする）
    run_id?: string;                  // 所属 Run の ID（移行前は空）
}

/**
 * LLM 論理実行（LLM_Runs シートに保存）
 *
 * config_hash 単位で集約された「同一設定での実行」を表す。
 * - 同じ config_hash のバッチは自動的に同じ Run に集約される
 * - include_threshold は Run に1つだけ持ち、Run 配下の全バッチで共有
 * - is_active は Run 単位の択一フラグ（同一 spreadsheet 内で is_active=true は1つのみ）
 */
export interface LlmRun {
    run_id: string;                   // UUID
    config_hash: string;              // "v1:sha256(...)" 形式
    created_at: string;               // 配下バッチ最古の timestamp
    model: string;
    requested_model?: string;
    model_version?: string;
    response_id?: string;
    temperature?: number;
    topP?: number;
    thinkingLevel?: string;
    criteria_snapshot: LlmCriteria | null;
    screening_prompt: string;
    include_threshold: number;
    status: 'pending' | 'confirmed';
    is_active: boolean;
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
 * Gemini API response metadata
 */
export interface LlmModelResponseMetadata {
    modelVersion?: string;
    responseId?: string;
}

/**
 * LLM判定のnoteフィールドに保存する構造
 */
export interface LlmDecisionNote {
    type: 'llm';
    execution_id: string;
    model: string;
    requested_model?: string;
    model_version?: string;
    response_id?: string;
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
 * Tier 別バッチ実行プロファイル（デフォルト: Gemini 3 Flash 想定）
 * 想定 API レイテンシ 3〜5秒/件、AI Studio 実測の RPM 上限
 * (T1=1K / T2=2K / T3=20K) に対しブラウザ並列性とリトライバーストの
 * マージンを残して設定。
 */
export const BATCH_PROFILES: Record<ManualTier, BatchProfile> = {
    free: {
        rate: { concurrency: 1, delayBetweenRequests: 13000 }, // RPM 5
        saveBatchSize: 5,
    },
    tier1: {
        rate: { concurrency: 10, delayBetweenRequests: 300 },  // 実効 ~180 RPM (cap 1,000)
        saveBatchSize: 10,
    },
    tier2: {
        rate: { concurrency: 20, delayBetweenRequests: 150 },  // 実効 ~370 RPM (cap 2,000)
        saveBatchSize: 25,
    },
    tier3: {
        rate: { concurrency: 50, delayBetweenRequests: 60 },   // 実効 ~750 RPM (cap 20,000)
        saveBatchSize: 50,
    },
};

/**
 * モデル別プロファイル上書き
 * AI Studio 実測値で flash-lite は他モデルより RPM 上限が大幅に高い
 * (T1=4K / T2=10K / T3=30K) ため、選択時は高並列プロファイルを採用する。
 *
 * 対応していない (tier, model) の組み合わせは BATCH_PROFILES の値が使われる。
 */
export const BATCH_PROFILE_OVERRIDES: Record<string, Partial<Record<ManualTier, BatchProfile>>> = {
    'gemini-flash-lite-latest': {
        tier1: {
            rate: { concurrency: 30, delayBetweenRequests: 80 },   // 実効 ~450 RPM (cap 4,000)
            saveBatchSize: 30,
        },
        tier2: {
            rate: { concurrency: 60, delayBetweenRequests: 50 },   // 実効 ~900 RPM (cap 10,000)
            saveBatchSize: 60,
        },
        tier3: {
            rate: { concurrency: 100, delayBetweenRequests: 30 },  // 実効 ~1,500 RPM (cap 30,000)
            saveBatchSize: 100,
        },
    },
    'gemini-3.1-flash-lite': {
        tier1: {
            rate: { concurrency: 30, delayBetweenRequests: 80 },   // 実効 ~450 RPM (cap 4,000)
            saveBatchSize: 30,
        },
        tier2: {
            rate: { concurrency: 60, delayBetweenRequests: 50 },   // 実効 ~900 RPM (cap 10,000)
            saveBatchSize: 60,
        },
        tier3: {
            rate: { concurrency: 100, delayBetweenRequests: 30 },  // 実効 ~1,500 RPM (cap 30,000)
            saveBatchSize: 100,
        },
    },
    'gemini-2.5-flash-lite': {
        tier1: {
            rate: { concurrency: 30, delayBetweenRequests: 80 },   // 実効 ~450 RPM (cap 4,000)
            saveBatchSize: 30,
        },
        tier2: {
            rate: { concurrency: 60, delayBetweenRequests: 50 },   // 実効 ~900 RPM (cap 10,000)
            saveBatchSize: 60,
        },
        tier3: {
            rate: { concurrency: 100, delayBetweenRequests: 30 },  // 実効 ~1,500 RPM (cap 30,000)
            saveBatchSize: 100,
        },
    },
    'gemini-3.5-flash': {
        // Thinking 対応 Flash モデル: 1件あたり数秒〜数十秒、RPM 上限は Flash-Lite より低い前提
        tier1: {
            rate: { concurrency: 10, delayBetweenRequests: 300 },  // 実効 ~180 RPM (cap 1,000)
            saveBatchSize: 10,
        },
        tier2: {
            rate: { concurrency: 20, delayBetweenRequests: 150 },  // 実効 ~370 RPM (cap 2,000)
            saveBatchSize: 25,
        },
        tier3: {
            rate: { concurrency: 50, delayBetweenRequests: 60 },   // 実効 ~750 RPM (cap 20,000)
            saveBatchSize: 50,
        },
    },
    // OpenRouter 系: tier の概念がないため、全 tier 値で同じ固定プロファイルを返す。
    // 値は experiments/openrouter-bench/config.json の openrouter_default と揃える
    // (concurrency 10 / delay 200ms / saveBatchSize 10)。
    'qwen/qwen3-235b-a22b-2507': {
        free: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier1: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier2: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier3: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
    },
    'deepseek/deepseek-v4-flash': {
        free: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier1: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier2: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
        tier3: { rate: { concurrency: 10, delayBetweenRequests: 200 }, saveBatchSize: 10 },
    },
};

/**
 * モデルと tier からバッチ実行プロファイルを解決する
 * モデル別の上書きがあればそちらを優先し、なければデフォルトを返す
 */
export function getBatchProfile(tier: ManualTier, modelId?: string): BatchProfile {
    if (modelId) {
        const override = BATCH_PROFILE_OVERRIDES[modelId]?.[tier];
        if (override) return override;
    }
    return BATCH_PROFILES[tier];
}

/**
 * 旧API（後方互換のため残置）
 * 新規コードは BATCH_PROFILES を直接参照すること。
 */
export const RATE_LIMIT_FREE: RateLimitConfig = BATCH_PROFILES.free.rate;
export const RATE_LIMIT_PAID: RateLimitConfig = BATCH_PROFILES.tier1.rate;
export const RATE_LIMIT_TIER2: RateLimitConfig = BATCH_PROFILES.tier2.rate;

// ---------------------------------------------------------------------------
// フルテキストスクリーニング / データ抽出 アノテーション
// ---------------------------------------------------------------------------

/**
 * PDFハイライト位置（PDF.js の TextContent ベース）
 * - offset: ページ内文字オフセット（主キー、再描画に使用）
 * - context_before / context_after: 前後50文字（オフセット失敗時のフォールバック）
 */
export interface AnnotationPosition {
    page: number;
    offset_start: number;
    offset_end: number;
    context_before: string;
    context_after: string;
}

/**
 * PDFアノテーション（ハイライト1件 = 1行）
 *
 * フルテキストスクリーニングとデータ抽出を同じ型で扱う。
 * - phase: 'fulltext_screening' のとき category は include_evidence / exclude_evidence
 * - phase: 'data_extraction' のとき category は 'data_point'、label にフィールド名を入れる
 *
 * Google Sheets: Annotations タブに1行1アノテーションで保存する。
 * position_json 列に AnnotationPosition を JSON 文字列として格納する。
 */
export interface Annotation {
    annotation_id: string;   // UUID
    ref_id: string;          // References への FK
    reviewer_id: string;     // email
    phase: 'fulltext_screening' | 'data_extraction';
    category: 'include_evidence' | 'exclude_evidence' | 'data_point';
    label?: string;          // data_extraction 時のフィールド名（例: 'sample_size'）
    highlighted_text: string;
    page_number: number;
    position_json: string;   // JSON.stringify(AnnotationPosition)
    pdf_url: string;         // アノテーション作成時に使ったPDFのURL
    created_at: string;      // ISO 8601
}
