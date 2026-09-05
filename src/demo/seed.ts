// デモモード用シードデータ生成
//
// sample/pubmed-srws-psgad-set.nbib を実際の parseRIS() でパースし、References /
// Decisions / Config / LLM_Executions / LLM_Runs / Publication_Candidates タブの初期状態を
// 組み立てて sheet-store（インメモリ）へ書き込む。ref_id・タイムスタンプ等はすべて固定値にし、
// Playwright で毎回同じ画面が再現できるようにする（Date.now() や乱数は使わない）。
//
// profile='ml' 指定時（src/demo/profile.ts）は、実データ10件に加えて
// src/demo/ml-fixtures.ts の合成文献1,090件（計1,100件）と、その一部への
// デモユーザーのヒト判定40件を追加する。MLタブは文献数1,000件以上でのみ開放される
// （src/lib/ml/cmh-defaults.ts）ため、既定プロファイルではこのタブを開けない。
//
// profile='bench' 指定時は、実データを一切使わず src/demo/bench-fixtures.ts のサイズ可変な
// 合成データ（References / Decisions / LLM_Runs / LLM_Executions）で置き換える
// （Issue #151（#150 工程0）チャンク2）。'default' / 'ml' の出力バイトには一切影響しない。

import nbibContent from '../../sample/pubmed-srws-psgad-set.nbib';
import { parseRIS } from '../lib/ris-parser';
import type { Reference } from '../lib/types';
import { resetDemoStore } from './sheet-store';
import type { DemoProfile, BenchOptions } from './profile';
import { buildSyntheticReferences, buildSyntheticDecisionSeeds } from './ml-fixtures';
import { buildBenchReferences, buildBenchDecisionSeeds, buildBenchLlmRound } from './bench-fixtures';
import {
    DEMO_SPREADSHEET_TITLE,
    DEMO_USER_EMAIL,
    DEMO_COLLEAGUE_EMAIL,
    DEMO_SOURCE_FILE,
    DEMO_SEED_TIMESTAMP,
    DEMO_HUMAN_CLIENT_VERSION,
    DEMO_FULLTEXT_DRIVE_FILE_ID,
    DEMO_FULLTEXT_SOURCE_FILE_ID,
} from './constants';

/** bench プロファイル未指定時（options省略呼び出し）のフォールバックサイズ。profile.ts の DEFAULT_BENCH_SIZE と同じ値。 */
const FALLBACK_BENCH_SIZE = 1000;

// 以下2つの定数は src/lib/sheets-api.ts の REFERENCES_HEADERS / DECISIONS_HEADERS と
// 同じ並び順（同ファイルはこれらを export していないためここでミラーする）。
// sheets-api.ts 側の列構成を変更した場合はこちらも必ず追従させること。
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
    'fulltext_drive_source_id', 'fulltext_drive_copy_id',
    'record_type', 'related_ref_id',
    'duplicate_of',
];

const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
    'context_json',
];

// sheets-api.ts の LLM_EXECUTIONS_HEADERS と完全一致させること（末尾追記のみ許容）。
const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active', 'run_id',
    'requested_model', 'model_version', 'response_id',
    'target_mode', 'target_sets', 'target_selected_count',
    'executed_by', 'maybe_count', 'failed_count', 'failure_breakdown',
    'exclude_reasons_snapshot',
];

const LLM_RUNS_HEADERS = [
    'run_id', 'config_hash', 'created_at', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt',
    'include_threshold', 'status', 'is_active',
    'requested_model', 'model_version', 'response_id',
];

// sheets-api.ts の PUBLICATION_CANDIDATES_HEADERS と完全一致させること（末尾追記のみ許容）。
// Issue #118 チャンク2 パスB（レジストリ連携フェーズ1: 論文候補探索）で追加。
export const PUBLICATION_CANDIDATES_HEADERS = [
    'candidate_id', 'ref_id', 'trial_id', 'pmid', 'doi',
    'title', 'journal', 'year', 'strategy', 'status',
    'suggested_at', 'decided_by', 'decided_at', 'imported_ref_id',
];

// sheets-api.ts の DUPLICATE_CANDIDATES_HEADERS と完全一致させること（末尾追記のみ許容）。
// Issue #145 チャンク2で追加。
export const DUPLICATE_CANDIDATES_HEADERS = [
    'candidate_id', 'ref_id_a', 'ref_id_b', 'match_type', 'match_key',
    'status', 'suggested_at', 'decided_by', 'decided_at', 'kept_ref_id',
];

/** 決定論的な ref_id（demo-ref-001 ... ）を振り直した実データ文献一覧を作る（常に10件） */
function buildRealDemoReferences(): Reference[] {
    const parsed = parseRIS(nbibContent, DEMO_SOURCE_FILE);
    return parsed.map((ref, index) => {
        const refNumber = index + 1;
        const built: Reference = {
            ...ref,
            ref_id: `demo-ref-${String(refNumber).padStart(3, '0')}`,
            // parseRIS は new Date().toISOString() を使うため、録画のたびに値が変わらないよう上書きする
            imported_at: DEMO_SEED_TIMESTAMP,
            imported_by: DEMO_USER_EMAIL,
            source: ref.source || 'PubMed',
        };
        // フルテキストデモ用（セクション4）: 1件目はDrive保存済みPDFのキャッシュ済み扱い、
        // 2件目はあえて未取得のままにして「取得候補」の両パターンを見せる。
        if (refNumber === 1) {
            built.fulltext_status = 'cached';
            built.fulltext_url = `https://drive.google.com/file/d/${DEMO_FULLTEXT_DRIVE_FILE_ID}/view`;
            // Drive直接取り込みを経て cached になったデモ行として、取り込み元PDFとコピーの両IDも入れておく
            // （DEMO_FULLTEXT_DRIVE_FILE_ID は fulltext_url が指す「コピー」のIDなので copy 側に使う）
            built.fulltext_drive_source_id = DEMO_FULLTEXT_SOURCE_FILE_ID;
            built.fulltext_drive_copy_id = DEMO_FULLTEXT_DRIVE_FILE_ID;
        }
        return built;
    });
}

/**
 * References タブ全体を組み立てる。
 * profile==='bench' のときは実データを一切使わず、options.size 件のベンチ合成データに
 * 完全に置き換える（Issue #151（#150 工程0）チャンク2）。default/ml の出力には影響しない。
 */
function buildDemoReferences(profile: DemoProfile, options?: BenchOptions): Reference[] {
    if (profile === 'bench') {
        return buildBenchReferences(options?.size ?? FALLBACK_BENCH_SIZE);
    }
    const references = buildRealDemoReferences();
    if (profile === 'ml') {
        references.push(...buildSyntheticReferences());
    }
    return references;
}

function buildReferenceRow(ref: Reference): string[] {
    return REFERENCES_HEADERS.map((header) => {
        const value = (ref as unknown as Record<string, string | number | undefined>)[header];
        return value === undefined || value === null ? '' : String(value);
    });
}

interface SeedDecisionInput {
    decisionId: string;
    refId: string;
    reviewerId: string;
    decision: 'include' | 'exclude' | 'maybe';
    reason?: string;
    decidedAt: string;
    /** 省略時は '' （メモなし。既存のdefault/ml呼び出しと同じ挙動） */
    note?: string;
    /** 省略時は DEMO_HUMAN_CLIENT_VERSION（既存のdefault/ml呼び出しと同じ挙動） */
    clientVersion?: string;
    /** 省略時は '' = 'tiab' 扱い（既存のdefault/ml呼び出しと同じ挙動） */
    screeningPhase?: string;
}

function buildDecisionRow(input: SeedDecisionInput): string[] {
    const row: Record<(typeof DECISIONS_HEADERS)[number], string> = {
        decision_id: input.decisionId,
        ref_id: input.refId,
        reviewer_id: input.reviewerId,
        decision: input.decision,
        reason: input.reason || '',
        labels: '', // 機能廃止のため常に空文字
        note: input.note || '',
        decided_at: input.decidedAt,
        // isHumanDecision() は client_version に '-human' を含むかで判定するため、
        // 実バージョンに依存しない固定リテラルを使う（空文字だと全件「未判定」扱いになるバグを踏む）。
        // bench プロファイルは LLM 判定など別の client_version を渡す必要があるため、
        // 呼び出し側が指定すればそれを優先する（省略時は従来どおり）。
        client_version: input.clientVersion ?? DEMO_HUMAN_CLIENT_VERSION,
        source_url: '',
        screening_phase: input.screeningPhase ?? '', // 省略時は 'tiab' 扱い（実際の保存挙動と同じ）
        context_json: '', // デモシードでは記録しない（実装済みプロジェクトへの後追い列のため空欄で問題ない）
    };
    return DECISIONS_HEADERS.map((header) => row[header]);
}

function refId(n: number): string {
    return `demo-ref-${String(n).padStart(3, '0')}`;
}

/** 合成文献（demo-ref-011...）内でのインデックスから ref_id を得る（seed.ts側の連番規則と一致） */
function syntheticRefId(syntheticIndex: number): string {
    return refId(10 + syntheticIndex);
}

/**
 * Decisions タブのシード判定一覧を組み立てる（デモユーザー3件・同僚5件が基本）。
 * profile==='ml' のときは、ML学習用にデモユーザーの合成文献判定40件を追加する
 * （mlStoppingRule はここでは一切保存しない。ML タブ初回起動時の停止基準ダイアログを
 * 必ず表示させるため）。
 * profile==='bench' のときは実データ由来の判定を一切使わず、bench-fixtures.ts の
 * options.size 件ベンチ合成判定に完全に置き換える（Issue #151（#150 工程0）チャンク2）。
 */
function buildDemoDecisions(profile: DemoProfile, options?: BenchOptions): string[][] {
    if (profile === 'bench') {
        const size = options?.size ?? FALLBACK_BENCH_SIZE;
        const seeds = buildBenchDecisionSeeds(size);
        return [DECISIONS_HEADERS, ...seeds.map((seed) => buildDecisionRow({
            decisionId: seed.decisionId,
            refId: seed.refId,
            reviewerId: seed.reviewerId,
            decision: seed.decision,
            reason: seed.reason,
            note: seed.note,
            decidedAt: seed.decidedAt,
            clientVersion: seed.clientVersion,
            screeningPhase: seed.screeningPhase,
        }))];
    }

    const decisions: SeedDecisionInput[] = [
        // デモユーザー本人の判定（3/10: include 2件・exclude 1件）
        { decisionId: 'demo-dec-001', refId: refId(1), reviewerId: DEMO_USER_EMAIL, decision: 'include', decidedAt: '2026-01-06T01:00:00.000Z' },
        { decisionId: 'demo-dec-002', refId: refId(2), reviewerId: DEMO_USER_EMAIL, decision: 'include', decidedAt: '2026-01-06T01:05:00.000Z' },
        { decisionId: 'demo-dec-003', refId: refId(3), reviewerId: DEMO_USER_EMAIL, decision: 'exclude', reason: '症例報告のため対象外', decidedAt: '2026-01-06T01:10:00.000Z' },
        // 同僚レビュアーの判定（5/10: チーム進捗デモ用。1-3は本人と一致、4-5は本人未判定）
        { decisionId: 'demo-dec-004', refId: refId(1), reviewerId: DEMO_COLLEAGUE_EMAIL, decision: 'include', decidedAt: '2026-01-05T09:30:00.000Z' },
        { decisionId: 'demo-dec-005', refId: refId(2), reviewerId: DEMO_COLLEAGUE_EMAIL, decision: 'include', decidedAt: '2026-01-05T09:35:00.000Z' },
        { decisionId: 'demo-dec-006', refId: refId(3), reviewerId: DEMO_COLLEAGUE_EMAIL, decision: 'exclude', reason: '症例報告のため対象外', decidedAt: '2026-01-05T09:40:00.000Z' },
        { decisionId: 'demo-dec-007', refId: refId(4), reviewerId: DEMO_COLLEAGUE_EMAIL, decision: 'include', decidedAt: '2026-01-05T09:45:00.000Z' },
        { decisionId: 'demo-dec-008', refId: refId(5), reviewerId: DEMO_COLLEAGUE_EMAIL, decision: 'exclude', reason: 'プロトコルのため対象外', decidedAt: '2026-01-05T09:50:00.000Z' },
    ];

    if (profile === 'ml') {
        buildSyntheticDecisionSeeds().forEach((seed, i) => {
            decisions.push({
                decisionId: `demo-dec-ml-${String(i + 1).padStart(3, '0')}`,
                refId: syntheticRefId(seed.syntheticIndex),
                reviewerId: DEMO_USER_EMAIL,
                decision: seed.decision,
                reason: seed.decision === 'exclude' ? '研究デザインが組み入れ基準に合致しないため対象外' : undefined,
                decidedAt: '2026-01-06T02:00:00.000Z',
            });
        });
    }

    return [DECISIONS_HEADERS, ...decisions.map(buildDecisionRow)];
}

/**
 * Config タブ（Key-Value）のシード行を組み立てる。
 * profile==='bench' かつ options.keyOpened===true のときだけ key_opened 行を追加する
 * （それ以外は default/ml と同じ3行のまま。1バイトも変えないため profile==='bench' の
 * 判定を先に見てから分岐する）。
 */
function buildDemoConfig(profile: DemoProfile, options?: BenchOptions): string[][] {
    const rows: string[][] = [
        ['include_keywords', 'randomized, meta-analysis'],
        ['exclude_keywords', 'case report, protocol'],
        // 'dismissed' にしておくことで、初回接続時に担当割り振りウィザードのモーダルが
        // 出ないようにする（'none' のままだと maybeShowAssignmentWizard が表示してしまう）。
        ['assignment_status', 'dismissed'],
    ];
    if (profile === 'bench' && options?.keyOpened) {
        // key_opened の値書式: src/lib/sheets-api.ts の getKeyOpenedStatus()/trySetKeyOpened() が
        // row[1]?.toLowerCase() === 'true' で判定する小文字文字列 'true'/'false'
        // （sheets-api.ts 2399行目・3092行目・3127行目で確認済み）。
        rows.push(['key_opened', 'true']);
    }
    if (profile === 'bench') {
        // フルテキストAI判定の根拠ジャンプ計測用（Issue #151（#150 工程0）チャンク3b）。
        // src/fulltext/fulltext.ts の findAiFulltext() は「採用ラウンド」
        // （Config.fulltext_ai_active_round = sheets-api.ts の parseConfigBundle() が
        // fulltextAiActiveRound として読む）の reviewer_id と一致する
        // screening_phase='fulltext' の判定しか拾わない。buildBenchDecisionSeeds() が
        // BENCH_FULLTEXT_CACHED_REF_ID へ追加するフルテキストAI判定の reviewer_id を
        // buildBenchLlmRound(size).execution.execution_id にしているため、ここも同じ値に
        // 揃える（execution_id 自体は size に依存しない固定値。bench-fixtures.ts参照）。
        const size = options?.size ?? FALLBACK_BENCH_SIZE;
        rows.push(['fulltext_ai_active_round', buildBenchLlmRound(size).execution.execution_id]);
    }
    return rows;
}

/**
 * LlmRun / LlmExecution を LLM_RUNS_HEADERS / LLM_EXECUTIONS_HEADERS の順の行配列へ並べ替える。
 * src/lib/sheets-api.ts の serializeLlmRunRow()（非公開関数のため import できない）と同じ
 * 「ヘッダー名でプロパティを引く」方式をここでミラーする（ファイル冒頭コメントの
 * ヘッダーミラー方針と同じ理由）。bench-fixtures.ts の buildBenchLlmRound() がオブジェクトを
 * 返す設計を選んだのはこの並べ替えを seed.ts 側に持たせるため（bench-fixtures.ts 側のコメント参照）。
 */
function serializeBenchLlmRow<T extends Record<string, unknown>>(value: T, headers: readonly string[]): string[] {
    return headers.map((header) => {
        const cell = value[header];
        if (cell === undefined || cell === null) return '';
        if (header === 'criteria_snapshot') return cell ? JSON.stringify(cell) : '';
        if (header === 'is_active') return cell ? 'true' : 'false';
        return String(cell);
    });
}

/**
 * LLM_Executions タブのシード行。profile==='bench' のときだけ採用済みラウンド1本分の行を追加する。
 * buildBenchLlmRound() の target_count は size 比例のため、buildDemoDecisions() と同じ
 * options?.size ?? FALLBACK_BENCH_SIZE の解決を使って Decisions 側のAI票件数と一致させる。
 */
function buildDemoLlmExecutions(profile: DemoProfile, options?: BenchOptions): string[][] {
    if (profile !== 'bench') return [LLM_EXECUTIONS_HEADERS];
    const size = options?.size ?? FALLBACK_BENCH_SIZE;
    const { execution } = buildBenchLlmRound(size);
    return [LLM_EXECUTIONS_HEADERS, serializeBenchLlmRow(execution as unknown as Record<string, unknown>, LLM_EXECUTIONS_HEADERS)];
}

/**
 * LLM_Runs タブのシード行。profile==='bench' のときだけ採用済みラウンド1本分の行を追加する。
 * run 自体には target_count 等は含まれないが、buildBenchLlmRound() の引数は
 * buildDemoLlmExecutions() と揃えておく（同じ size で呼ばないと意味がないため）。
 */
function buildDemoLlmRuns(profile: DemoProfile, options?: BenchOptions): string[][] {
    if (profile !== 'bench') return [LLM_RUNS_HEADERS];
    const size = options?.size ?? FALLBACK_BENCH_SIZE;
    const { run } = buildBenchLlmRound(size);
    return [LLM_RUNS_HEADERS, serializeBenchLlmRow(run as unknown as Record<string, unknown>, LLM_RUNS_HEADERS)];
}

/**
 * シード全体を組み立てて sheet-store へ書き込む。
 * @param profile 'default'（実データ10件のみ）/ 'ml'（+ 合成文献1,090件。MLタブ開放デモ用）/
 *   'bench'（+ サイズ可変のベンチマーク合成データ。Issue #151（#150 工程0）チャンク2）
 * @param options bench プロファイル用オプション（src/demo/profile.ts の resolveBenchOptions()）。
 *   profile !== 'bench' のときは無視される。
 */
export function seedDemoStore(profile: DemoProfile = 'default', options?: BenchOptions): void {
    const references = buildDemoReferences(profile, options);

    resetDemoStore(DEMO_SPREADSHEET_TITLE, {
        References: [REFERENCES_HEADERS, ...references.map(buildReferenceRow)],
        Decisions: buildDemoDecisions(profile, options),
        Config: buildDemoConfig(profile, options),
        // LLM機能: default/ml は従来どおりヘッダー行のみ（ensureLlmExecutionsSheet/
        // ensureLlmRunsSheet が「ヘッダーは揃っている」と判定できればよいため）。
        // bench は採用済みAIラウンド1本分の行を追加する。
        LLM_Executions: buildDemoLlmExecutions(profile, options),
        LLM_Runs: buildDemoLlmRuns(profile, options),
        // Publication_Candidates はこのチャンクの対象外（パスBはまだ何も候補を発見しない状態からデモが
        // 始まる想定）。ensurePublicationCandidatesSheet が「ヘッダーは揃っている」と判定できるよう、
        // ヘッダー行のみ用意しておく（LLM_Executions/LLM_Runsと同じ理由）。
        Publication_Candidates: [PUBLICATION_CANDIDATES_HEADERS],
        // Duplicate_Candidates も同じ理由でヘッダー行のみ（Issue #145 チャンク2。重複候補ペアの
        // 検出・保存はチャンク2の後続配線とチャンク3のレビューUIで行う）。
        Duplicate_Candidates: [DUPLICATE_CANDIDATES_HEADERS],
    });
}
