// デモモード用シードデータ生成
//
// sample/pubmed-srws-psgad-set.nbib を実際の parseRIS() でパースし、References /
// Decisions / Config / LLM_Executions / LLM_Runs タブの初期状態を組み立てて
// sheet-store（インメモリ）へ書き込む。ref_id・タイムスタンプ等はすべて固定値にし、
// Playwright で毎回同じ画面が再現できるようにする（Date.now() や乱数は使わない）。

import nbibContent from '../../sample/pubmed-srws-psgad-set.nbib';
import { parseRIS } from '../lib/ris-parser';
import type { Reference } from '../lib/types';
import { resetDemoStore } from './sheet-store';
import {
    DEMO_SPREADSHEET_TITLE,
    DEMO_USER_EMAIL,
    DEMO_COLLEAGUE_EMAIL,
    DEMO_SOURCE_FILE,
    DEMO_SEED_TIMESTAMP,
    DEMO_HUMAN_CLIENT_VERSION,
} from './constants';

// 以下2つの定数は src/lib/sheets-api.ts の REFERENCES_HEADERS / DECISIONS_HEADERS と
// 同じ並び順（同ファイルはこれらを export していないためここでミラーする）。
// sheets-api.ts 側の列構成を変更した場合はこちらも必ず追従させること。
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
];

const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
];

const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active', 'run_id',
    'requested_model', 'model_version', 'response_id',
];

const LLM_RUNS_HEADERS = [
    'run_id', 'config_hash', 'created_at', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt',
    'include_threshold', 'status', 'is_active',
    'requested_model', 'model_version', 'response_id',
];

/** 決定論的な ref_id（demo-ref-001 ... ）を振り直した文献一覧を作る */
function buildDemoReferences(): Reference[] {
    const parsed = parseRIS(nbibContent, DEMO_SOURCE_FILE);
    return parsed.map((ref, index) => ({
        ...ref,
        ref_id: `demo-ref-${String(index + 1).padStart(3, '0')}`,
        // parseRIS は new Date().toISOString() を使うため、録画のたびに値が変わらないよう上書きする
        imported_at: DEMO_SEED_TIMESTAMP,
        imported_by: DEMO_USER_EMAIL,
        source: ref.source || 'PubMed',
    }));
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
}

function buildDecisionRow(input: SeedDecisionInput): string[] {
    const row: Record<(typeof DECISIONS_HEADERS)[number], string> = {
        decision_id: input.decisionId,
        ref_id: input.refId,
        reviewer_id: input.reviewerId,
        decision: input.decision,
        reason: input.reason || '',
        labels: '', // 機能廃止のため常に空文字
        note: '',
        decided_at: input.decidedAt,
        // isHumanDecision() は client_version に '-human' を含むかで判定するため、
        // 実バージョンに依存しない固定リテラルを使う（空文字だと全件「未判定」扱いになるバグを踏む）。
        client_version: DEMO_HUMAN_CLIENT_VERSION,
        source_url: '',
        screening_phase: '', // 省略時は 'tiab' 扱い（実際の保存挙動と同じ）
    };
    return DECISIONS_HEADERS.map((header) => row[header]);
}

function refId(n: number): string {
    return `demo-ref-${String(n).padStart(3, '0')}`;
}

/** Decisions タブのシード判定一覧を組み立てる（デモユーザー3件・同僚5件） */
function buildDemoDecisions(): string[][] {
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
    return [DECISIONS_HEADERS, ...decisions.map(buildDecisionRow)];
}

/** Config タブ（Key-Value）のシード行を組み立てる */
function buildDemoConfig(): string[][] {
    return [
        ['include_keywords', 'randomized, meta-analysis'],
        ['exclude_keywords', 'case report, protocol'],
        // 'dismissed' にしておくことで、初回接続時に担当割り振りウィザードのモーダルが
        // 出ないようにする（'none' のままだと maybeShowAssignmentWizard が表示してしまう）。
        ['assignment_status', 'dismissed'],
    ];
}

/** シード全体を組み立てて sheet-store へ書き込む */
export function seedDemoStore(): void {
    const references = buildDemoReferences();

    resetDemoStore(DEMO_SPREADSHEET_TITLE, {
        References: [REFERENCES_HEADERS, ...references.map(buildReferenceRow)],
        Decisions: buildDemoDecisions(),
        Config: buildDemoConfig(),
        // LLM機能はこのチャンクの対象外。ensureLlmExecutionsSheet/ensureLlmRunsSheet が
        // 「ヘッダーは揃っている」と判定できるよう、ヘッダー行のみ用意しておく。
        LLM_Executions: [LLM_EXECUTIONS_HEADERS],
        LLM_Runs: [LLM_RUNS_HEADERS],
    });
}
