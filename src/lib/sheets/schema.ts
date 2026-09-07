// schema.ts - Google Sheets 側のシート名・ヘッダー定義・列文字ヘルパー（純データ・純関数のみ）
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、行変換は ./codecs を参照。
// このファイルは ./types 以外の src モジュールに依存しない（DOM・通信・platform を持ち込まない）。

// シート名定数
export const REFERENCES_SHEET = 'References';
export const DECISIONS_SHEET = 'Decisions';
export const CONFIG_SHEET = 'Config';
export const LLM_EXECUTIONS_SHEET = 'LLM_Executions';
export const LLM_RUNS_SHEET = 'LLM_Runs';
export const AUDIT_LOG_SHEET = 'Audit_Log';
// Issue #118 チャンク2 パスB（レジストリ連携フェーズ1: 論文候補探索）で追加。
export const PUBLICATION_CANDIDATES_SHEET = 'Publication_Candidates';
// 重複候補ペアの人による採否を記憶するタブ（Issue #145 チャンク2）。
export const DUPLICATE_CANDIDATES_SHEET = 'Duplicate_Candidates';

// LLM_Executionsシートのヘッダー
// run_id は Run/Batch 分離後に追加された列。既存シートに無い場合は ensureLlmExecutionsSheet で末尾に追加される。
//
// 【重要】新しい列は必ず末尾に追加すること。saveLlmExecution() は row 配列を位置ベースで
// 組み立てており、既存シートのヘッダは「元の並び + ensureLlmExecutionsSheet が末尾へ追記した
// 不足列」という形にしかならない。途中挿入すると既存プロジェクトのシートで列がずれる。
export const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',  // Model parameters
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active', 'run_id',
    'requested_model', 'model_version', 'response_id',
    'target_mode', 'target_sets', 'target_selected_count',
    // フルテキストAI一括判定の実行履歴用（Issue #62）。ここより前には絶対に挿入しないこと。
    'executed_by', 'maybe_count', 'failed_count', 'failure_breakdown',
    // フルテキストAI判定時点の除外理由リストのスナップショット（PR #110）。末尾に追加。
    'exclude_reasons_snapshot'
];

// LLM_Runs シートのヘッダー（Run = config_hash 単位の論理実行）
export const LLM_RUNS_HEADERS = [
    'run_id', 'config_hash', 'created_at', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt',
    'include_threshold', 'status', 'is_active',
    'requested_model', 'model_version', 'response_id'
];

// Publication_Candidates タブのヘッダー（Issue #118 チャンク2 パスB）。
// registration行から発見した結果論文候補を1候補1行で保存する。
// 【重要】新しい列は必ず末尾に追加すること（LLM_EXECUTIONS_HEADERS と同じ理由）。
// decided_by/decided_at/imported_ref_id はチャンク3（候補の取り込み・棄却UI）で使う列で、
// このチャンクでは常に空文字のまま保存する。
// src/demo/seed.ts の PUBLICATION_CANDIDATES_HEADERS ミラーも必ず追従させること。
export const PUBLICATION_CANDIDATES_HEADERS = [
    'candidate_id', 'ref_id', 'trial_id', 'pmid', 'doi',
    'title', 'journal', 'year', 'strategy', 'status',
    'suggested_at', 'decided_by', 'decided_at', 'imported_ref_id'
];

// Duplicate_Candidates タブのヘッダー（Issue #145 チャンク2）。
// 重複候補として検出したペア（ref_id_a/ref_id_b）と、人が下した採否を1候補1行で保存する。
// 「別々の文献だ」という判断を記憶しておかないと、再スキャンのたびに同じ組が再提示されてしまう
// ため、取り込み時にスキップしなかった組（タイトル一致・source不一致の試験ID一致）はここへ積む。
// 【重要】新しい列は必ず末尾に追加すること（PUBLICATION_CANDIDATES_HEADERS と同じ理由）。
// decided_by/decided_at/kept_ref_id はレビューUI（チャンク3）で使う列で、このチャンクでは
// 常に空文字のまま保存する。
// src/demo/seed.ts の DUPLICATE_CANDIDATES_HEADERS ミラーも必ず追従させること。
export const DUPLICATE_CANDIDATES_HEADERS = [
    'candidate_id', 'ref_id_a', 'ref_id_b', 'match_type', 'match_key',
    'status', 'suggested_at', 'decided_by', 'decided_at', 'kept_ref_id'
];

// References タブのヘッダー
// 【重要】新しい列は必ず末尾に追加すること。途中挿入すると既存プロジェクトのシートで列がずれる。
// fulltext_drive_source_id（W列）/ fulltext_drive_copy_id（X列）は Issue #73 Phase 2 で追加した、
// Drive直接取り込みの冪等性判定用の列（詳細は updateReferenceFulltextUrls の JSDoc を参照）。
// record_type（Y列）/ related_ref_id（Z列）は Issue #118 チャンク1（レジストリ連携フェーズ1）で追加。
// duplicate_of（AA列）は Issue #145 チャンク2 で追加。重複検出（作り直し）の論理削除フラグ。
// 非空なら、この行は重複として除外済みで、値は残す側の ref_id（isLogicallyDeleted() で判定）。
// 列を足すたびに src/demo/seed.ts の REFERENCES_HEADERS ミラーも必ず追従させること。
export const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
    'fulltext_drive_source_id', 'fulltext_drive_copy_id',
    'record_type', 'related_ref_id',
    'duplicate_of'
];

// Decisions タブのヘッダー
// 互換性のため labels 列は残すが、機能としては使用しない
// screening_phase: 'tiab' | 'fulltext' (省略時は 'tiab' 扱い)
// context_json: 判定時点のAI暴露状況を記録するJSON（DecisionContextV1）。書くだけの列で
// 読み取り側の挙動は変えない（src/lib/sheets/AGENTS.md「Decisions タブ」参照）。新しい列は必ず末尾に追加すること
// （LLM_EXECUTIONS_HEADERS と同じ理由。saveDecisionInner 等が row 配列を位置ベースで組み立てるため）。
export const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
    'context_json'
];

/**
 * 1始まりの列番号を A1 形式の列名（A, B, ..., Z, AA, ...）に変換する。
 * ヘッダー配列の長さから終端列を導出するために使う。Decisions のように列が末尾追記で
 * 増えていくシートでは、`A1:K1` のように終端列をハードコードすると、列追加のたびに
 * 直し忘れた箇所だけ新しい列が反映されない事故が起きる（実際に踏んだ落とし穴）ため、
 * 必ずこのヘルパーでヘッダー数から導出すること。
 */
export function columnLetter(index: number): string {
    let n = index;
    let letters = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

export function columnNumberToLetter(columnIndex: number): string {
    let result = '';
    let current = columnIndex + 1;

    while (current > 0) {
        const remainder = (current - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        current = Math.floor((current - 1) / 26);
    }

    return result;
}

// Publication_Candidates タブの終端列（A1形式）。PUBLICATION_CANDIDATES_HEADERS の長さから
// 動的に導出する（REFERENCES_LAST_COLUMN / DECISIONS_LAST_COLUMN と同じ流儀。columnLetter() は
// 1始まりの列番号を取るヘルパーなので、他箇所で使う0始まりの columnNumberToLetter() とは
// 引数の基準が異なる点に注意）。readPublicationCandidatesRows() と
// updatePublicationCandidateStatus() の両方でこれを使い、終端列の導出式を重複させない。
export const PUBLICATION_CANDIDATES_LAST_COLUMN = columnLetter(PUBLICATION_CANDIDATES_HEADERS.length);

// Decisions タブの終端列（A1形式）。DECISIONS_HEADERS の長さから動的に導出する。
// 以前は 'K'（11列時代）をシート操作の各所に直書きしていたが、context_json 追加で
// 12列目（L列）になったため、以後は列数変更に自動追従するこの定数を使うこと。
export const DECISIONS_LAST_COLUMN = columnLetter(DECISIONS_HEADERS.length);

// References タブの終端列（A1形式）。REFERENCES_HEADERS の長さから動的に導出する。
// 以前は 'References!A:X' を4箇所に直書きしていたが（24列固定の想定）、record_type/
// related_ref_id 追加で26列（Z列）になったため、以後は列数変更に自動追従するこの定数を使うこと
// （Decisions と同じ落とし穴。T:X（fulltext系5列の部分範囲）のように末尾以外を指す固定範囲は
// 対象外＝変更不要）。
export const REFERENCES_LAST_COLUMN = columnLetter(REFERENCES_HEADERS.length);

// References タブの「アプリ後付け列」の開始位置（0-indexed）。
// A〜V の22列（ref_id 〜 fulltext_set）は初期バージョンから存在する安定プレフィックスで、
// W列（index 22）以降は、このアプリが後から追加してきた列
// （fulltext_drive_source_id/fulltext_drive_copy_id → record_type/related_ref_id、…）。
// ユーザーが独自の列を追加するなら必ずこの位置以降になるため、
// 「ユーザー独自ヘッダーとの衝突」検証はこの位置から REFERENCES_HEADERS.length-1 までを対象にする。
export const REFERENCES_MANAGED_TAIL_START_INDEX = 22;

/** validateReferencesManagedHeaders() が検出した1列分の衝突情報 */
export interface ReferencesHeaderConflict {
    /** A1形式の列名（例: 'Y'） */
    column: string;
    /** アプリが期待するヘッダー名 */
    expected: string;
    /** 実際にシートへ入っていたヘッダー名（trim済み） */
    actual: string;
}

/** validateReferencesManagedHeaders() の判定結果 */
export interface ReferencesManagedHeadersCheck {
    ok: boolean;
    /** ok=false のとき、衝突した列ぶんの情報（呼び出し側がログに出すため） */
    conflicts: ReferencesHeaderConflict[];
}

/**
 * References タブの「アプリ後付け列」（REFERENCES_MANAGED_TAIL_START_INDEX（W列）から
 * REFERENCES_HEADERS.length-1 まで）を、ユーザーが独自ヘッダー名で使っていないか検証する。
 *
 * 【経緯】この検証は元々 W/X列（fulltext_drive_source_id/fulltext_drive_copy_id）限定だった
 * （validateFulltextDriveHeaders、PR #105。ユーザーが独自の23列目以降を1本だけ足したシートで
 * W1のユーザー独自名を無警告で改名し、直後の書き込みでデータごと上書きしてしまう事故が実機で
 * 発生した）。その後 record_type/related_ref_id（Y/Z列、Issue #118）を追加した際にこの検証が
 * 追従しておらず、Y/Z列で同じ穴がそのまま再発した（詳細は ensureHeaders() のコメント参照）。
 *
 * 二度と列を足すたびに同じ穴が空かないよう、検証対象の終端を REFERENCES_HEADERS.length から
 * 動的に導出する。**ここが今回の一般化の肝**で、次に列を1本足せば、その列は呼び出し側の
 * 変更なしに自動でこの検証範囲へ含まれる。
 */
export function validateReferencesManagedHeaders(headerRow: string[]): ReferencesManagedHeadersCheck {
    const conflicts: ReferencesHeaderConflict[] = [];
    for (let i = REFERENCES_MANAGED_TAIL_START_INDEX; i < REFERENCES_HEADERS.length; i++) {
        const expected = REFERENCES_HEADERS[i];
        const actual = (headerRow[i] ?? '').trim();
        if (actual !== '' && actual !== expected) {
            conflicts.push({ column: columnLetter(i + 1), expected, actual });
        }
    }
    return { ok: conflicts.length === 0, conflicts };
}
