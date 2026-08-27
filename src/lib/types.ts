// types.ts - 型定義

import type { LlmTargetMode } from './llm-target-selection';

/**
 * フルテキストの入手状態
 * - not_retrieved: 未取得（省略時も同じ扱い）
 * - cached:        Driveに PDF を保存済み（fulltext_url は Drive リンク）
 * - retrieved:     外部URLのみ記録（PDFのキャッシュ不可・レガシー含む）
 * - unavailable:   無料OAソースで見つからなかった
 */
export type FulltextStatus = 'not_retrieved' | 'cached' | 'retrieved' | 'unavailable';

/**
 * References 行のレコード種別。
 * - article:      通常の文献行（既定。省略時もこの扱い＝後方互換）
 * - registration: 試験登録（CTG/ICTRP）由来の行
 * 判定は必ず src/lib/registry-record.ts の isRegistrationRecord() を経由すること。
 */
export type ReferenceRecordType = 'article' | 'registration';

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
    fulltext_url?: string;    // フルテキストURL (Driveキャッシュ / OA直リンク)
    fulltext_status?: FulltextStatus;
    fulltext_set?: string;    // フルテキスト担当セットID (ft-group-N)
    fulltext_drive_source_id?: string; // 取り込み元PDFのDriveファイルID（Drive直接取り込みのみ）
    fulltext_drive_copy_id?: string;   // そのとき作成/再利用したコピーのDriveファイルID
    // レジストリ連携フェーズ1（Issue #118 チャンク1）で追加。未設定は 'article' 相当（後方互換）。
    // 確定値を持つのは CTG/ICTRP パーサのみ。判定は isRegistrationRecord() 経由で行うこと。
    record_type?: ReferenceRecordType;
    // registration 行 ⇄ そこから取り込んだ論文行の相互参照。今はスキーマのみ用意（チャンク3で使用）。
    related_ref_id?: string;
}

/**
 * インポート統計（ファイル単位）。Config シートの `import_stats` キーに
 * JSON で保存し、PRISMA フロー図の識別件数・重複除去数の自動記入に使う。
 */
export interface ImportFileStats {
    identified: number;    // ファイル内の解析済みレコード数（重複除去前）
    duplicates: number;    // 取り込み時に重複としてスキップした件数
    imported_at?: string;  // ISO 8601
}

/** source_file 名 → インポート統計 */
export type ImportStatsMap = Record<string, ImportFileStats>;

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
    /**
     * 判定の瞬間に人間がAIの情報にどれだけ暴露されていたかを記録するJSON文字列
     * （DecisionContextV1、`src/lib/decision-context.ts`）。human判定の保存時のみ設定する。
     * 書くだけの列で、読み取り側の挙動は変えない（AGENTS.md「Decisions タブ」参照）。
     */
    context_json?: string;
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
    /**
     * この文献を判定した LLM バッチの reviewer_id（= LLM_Executions.execution_id）一覧。
     * Run/active を問わず全て含める。LLM バッチの対象判定を Run 単位で行うために使う
     * （「この Run ではまだ判定していない文献」を特定する）。
     */
    llmBatchIds?: string[];
    myFulltextDecision?: Decision; // 自分のフルテキストフェーズ判定（フルテキストタブで使用）
    allFulltextDecisions?: Decision[]; // キーオープン後に全レビュアー(+有効LLM)のフルテキスト判定を保持（結果集計で使用）
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
    llm_target_mode: LlmTargetMode;    // AI一括判定の対象の決め方（'all' | 'selection'）
    llm_target_ref_ids: string;        // 選択モード時の対象 ref_id（カンマ区切り。未設定は空文字）
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
    execution_type: 'prompt_generation' | 'batch_screening' | 'fulltext_batch_screening';
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
    // 対象選択（既存行には無い列なので undefined を許容）
    target_mode?: LlmTargetMode;      // 実行時の対象モード
    target_sets?: string;             // 対象に含まれた担当セットIDのカンマ区切り（例 'calibration'）
    target_selected_count?: number;   // 選択モードで選ばれていた件数
    // フルテキストAI一括判定の実行履歴用（既存行には無い列なので undefined を許容）
    executed_by?: string;             // 実行アカウント（メールアドレス）
    maybe_count?: number;             // フルテキストは include/exclude/maybe の3値判定。TiAb 実行では空
    failed_count?: number;            // 失敗総数
    // 失敗内訳のJSON文字列（例 '{"drive_denied":3,"llm":1}'）。オブジェクトではなくstring型にしているのは
    // updateLlmExecution がヘッダ駆動で行を組み立てており、オブジェクト型にすると criteria_snapshot の
    // ような特別扱いの分岐を追加で足す必要が出るため（sheets-api.ts 側の実装コメント参照）
    failure_breakdown?: string;
    /**
     * フルテキストAI判定時点の除外理由リストのスナップショット（JSON文字列。
     * `[{key,label,labelEn}]`。criteria_snapshot / screening_prompt と同じ役割）。
     * AI判定のスキーマ(enum)とプロンプトはこのリストから生成されるため、後から
     * fulltext_exclude_reasons のラベルを変更しても、過去 Run の区分の意味を復元できるようにする。
     * フルテキスト以外の実行（TiAb の prompt_generation / batch_screening）では null。
     */
    exclude_reasons_snapshot?: string | null;
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
    /**
     * キャッシュ済み入力トークン数（OpenAI Responses API の
     * input_tokens_details.cached_tokens）。cached 入力は割引単価で課金されるため
     * 正確なコスト算出に用いる。未対応プロバイダでは undefined。
     */
    cachedInputTokens?: number;
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
 * フルテキストAI判定のエビデンス項目。
 * テキストPDFでは quote（文字列マッチでハイライト）、
 * 画像onlyのスキャンPDFでは bbox（正規化座標でハイライト）を使う。
 */
export interface FulltextEvidence {
    quote: string;
    /** PDFページ番号（1始まり） */
    page: number;
    /** 正規化bbox [left, top, right, bottom]（各0-1, ページ左上原点）。画像PDF時に使用。 */
    bbox?: [number, number, number, number];
    /** 組み入れ寄り(include) / 除外寄り(exclude) どちらの根拠か */
    polarity?: 'include' | 'exclude';
}

/**
 * フルテキストAI判定の出力（Gemini responseSchema に対応）
 */
export interface FulltextJudgeOutput {
    decision: 'include' | 'exclude' | 'maybe';
    include_probability: number;
    /** 判定理由（除外時は具体的に） */
    reason: string;
    /**
     * 除外時の区分（モデルの生出力）。プロジェクト設定 `fulltext_exclude_reasons` で決まる
     * **可変の区分**（固定7区分ではない。PICO/PECO/PCC/SPIDER 等プリセットやカスタム編集で変わる）。
     * リスト外の値をモデルが返すこともあるため、`'other'` 決め打ちで扱わないこと。
     * 保存・表示に使う前に必ず `normalizeExcludeReasonKey()` でそのときの理由リストへ正規化する。
     */
    exclude_reason_category?: string;
    evidence: FulltextEvidence[];
}

/**
 * フルテキストLLM判定の note フィールドに保存する構造（Decisions タブ）。
 * TiAb の LlmDecisionNote と区別するため type を 'llm_fulltext' とする。
 */
export interface FulltextLlmDecisionNote {
    type: 'llm_fulltext';
    execution_id: string;
    model: string;
    requested_model?: string;
    model_version?: string;
    response_id?: string;
    include_probability: number;
    reason: string;
    /** normalizeExcludeReasonKey() で正規化済みのキー（Decisions.reason と同じ値）。 */
    exclude_reason_category?: string;
    /**
     * モデルの生出力（正規化前）。exclude_reason_category と一致する場合は入れない
     * （デバッグ用に、正規化でフォールバックへ寄せられた・列挙外の値だった場合だけ残す）。
     */
    exclude_reason_category_raw?: string;
    evidence: FulltextEvidence[];
    /** スキャン(画像only)PDFだったか。ハイライト精度の注意表示に使う。 */
    image_only?: boolean;
    prompt_version: string;
    usageMetadata?: UsageMetadata;
    parse_error?: boolean;
    error_message?: string;
}

/**
 * 裁定票の note フィールドに保存する構造（Decisions タブ）。
 * 「不一致の解消」UIで確定したときのスナップショットを保存し、後から
 * 「誰が・いつ・どの票を見て裁定したか」を追跡できるようにする。
 * reviewer_id は adjudicationReviewerId()（src/lib/fulltext-consensus.ts）で組み立てる
 * 'adjudication:{email}' 形式。判定者選択（judge selector）には出さない特別扱いの票。
 */
export interface FulltextAdjudicationVoteSnapshot {
    judge: string;                                        // reviewer_id（裁定時点のキー。'llm:...' も含む）
    decision: 'include' | 'exclude' | 'maybe' | 'pending';
    reason?: string;
    note?: string;
}

export interface FulltextAdjudicationNote {
    type: 'fulltext_adjudication';
    adjudicated_by: string;                              // 裁定者 email
    adjudicated_at: string;                               // ISO 8601
    votes: FulltextAdjudicationVoteSnapshot[];             // 裁定時点の各判定者の票
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
    // --- 429 適応スロットリングの観測用フィールド（UI の「減速中」表示に使う） ---
    rateLimitHits: number;       // 429 (レート制限) を受けた累計回数
    currentConcurrency: number;  // 現在の実効並列度（429 のたびに半減、連続成功で1段ずつ回復）
    throttled: boolean;          // 429 を受けて既定の並列度/スロット滞在時間より速度を落としている状態か
}

// API Tier関連の型定義

/**
 * API キーテスト時の自動分類結果（Free / Paid の二値）
 * `batchGenerateContent` に空 requests の batch を送るプローブ（`detectTierByBatchProbe()`,
 * `src/lib/gemini-api.ts`）の応答から判定する。判定できなかった場合は `unknown`。
 */
export type ApiTier = 'free' | 'paid' | 'unknown';

/**
 * `batchGenerateContent` プローブ（`detectTierByBatchProbe()` / `classifyTierProbeResponse()`）
 * の分類結果。`ApiTier` との違いに注意:
 * - `invalid_key` は「キー自体が不正」を表す状態であり、tier（無料/有料）ではない。
 *   `ApiTier` にはこの値は無い（`testApiKeyWithTier()` 側で `isValid: false` にマッピングする）。
 * - `unknown` はプローブが一過性の失敗（タイムアウト・想定外レスポンス等）で判定できなかったことを表す。
 *   `free`/`paid` と誤断定しないための安全側の値。
 */
export type DetectedTier = 'free' | 'paid' | 'invalid_key' | 'unknown';

/**
 * ユーザが手動で指定する詳細 tier
 * 4値すべてを常にセレクタから選択・上書きできる（Tier 1/2/3 はもちろん、free も含めて自動判定は
 * 確定情報ではない）。`ApiTier` の自動判定結果は、この値が未設定のときだけ入る「初期値の提案」
 * （paid → tier1、free/unknown → free）にすぎず、既存の手動設定があれば上書きしない。
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
