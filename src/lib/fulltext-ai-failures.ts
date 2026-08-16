/**
 * フルテキストAI一括判定の失敗分類（純関数のみ）
 *
 * Issue #62: 「何件が、なぜ失敗したのか」を LLM_Executions に残せるようにするための分類ロジック。
 * tests/ は node:test の純関数テストのみで DOM 環境が無いため、DOM・state・i18n には依存しない
 * （同じ方針の先例: src/lib/fulltext-ai-target.ts / src/lib/fulltext-consensus.ts）。
 *
 * ここで記録したいのは「この Run を実行したアカウントから読めなかった」という事実であって、
 * 「ファイルが壊れている」ではない。drive.file スコープは「アプリ×ユーザー×ファイル」単位の
 * 付与なので、他メンバーがアップロードしたPDFは実行アカウントからは読めないことがある
 * （src/lib/drive-api.ts の説明を参照）。
 */

/** フルテキストAI判定1件の失敗種別 */
export type FulltextAiFailureKind =
    | 'drive_denied'    // Drive の読み取り権限が実行アカウントに付与されていない（403相当）
    | 'drive_not_found' // Drive 上でファイルが見つからない（404相当）
    | 'drive_auth'      // Drive API 認証切れ（401）。再ログインで解消しうる
    | 'drive_transient' // Drive API の一時的な失敗（5xx / 429 / レート制限の403）。時間をおいて再実行で解消しうる
    | 'no_drive_url'    // fulltext_url から Drive ファイルIDが取り出せない
    | 'pdf'             // PDFの読み取り・解析に失敗（ダウンロードには成功したがバイト列を扱えない・サイズ超過等）
    | 'llm'             // Gemini呼び出しの失敗
    | 'other';          // 上記以外（Sheets書き込み失敗等）

/**
 * `fulltext_url` から Drive ファイルIDが取れない場合に judgeOne（fulltext-ai.ts）が投げる専用エラー。
 * 以前は `Error(t('fulltext_aiErrNoDrive'))` という i18n 文言依存のエラーを投げており、
 * 文字列マッチで分類すると表示言語が変わったときに壊れるため、判別用のエラークラスへ切り出した。
 */
export class NoDriveUrlError extends Error {
    constructor(message = 'fulltext_url does not contain a resolvable Drive file id') {
        super(message);
        this.name = 'FulltextNoDriveUrlError';
    }
}

/**
 * Drive からのダウンロード自体は成功したが、応答をPDFバイト列として読み取れなかった場合に
 * judgeOne（fulltext-ai.ts）が投げる専用エラー。元エラーは cause に保持する。
 */
export class PdfReadError extends Error {
    constructor(public readonly cause?: unknown, message = 'Failed to read downloaded file as PDF bytes') {
        super(message);
        this.name = 'FulltextPdfReadError';
    }
}

/**
 * PDFがinline送信の上限サイズを超えている場合に judgeFulltext（src/lib/gemini-fulltext.ts）が
 * 投げる専用エラー。以前はここで plain `Error` を投げており、GeminiApiError（llm分類）と
 * 見分けが付かず `other` に落ちていた。Gemini呼び出しに至る前の、PDF側の検証失敗なので `pdf` に
 * 分類する。UI表示文言を変えないよう、message はこれまでと同じ日本語文言をそのまま渡すこと。
 */
export class PdfTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FulltextPdfTooLargeError';
    }
}

/**
 * Gemini呼び出し（judgeFulltext）の内部で発生したが、GeminiApiError化されていない失敗を
 * judgeOne（fulltext-ai.ts）がラップし直すためのエラー。
 * 例: レスポンスボディが空（error_geminiEmptyResponse）、fetch自体のネットワーク例外等。
 * これらを未分類のまま流すと classifyFulltextAiFailure が `other` に落としてしまい、
 * 「Gemini呼び出しの失敗」という実態が実行履歴から読み取れなくなるため、
 * judgeOne 側で「Gemini呼び出し中に起きた失敗」であることが分かっている場合に明示的に包む。
 * 元エラーは cause に保持し、message は元エラーのものを引き継ぐ（ログ表示を変えないため）。
 */
export class LlmCallError extends Error {
    constructor(public readonly cause?: unknown, message?: string) {
        super(message ?? (cause instanceof Error ? cause.message : String(cause)));
        this.name = 'FulltextLlmCallError';
    }
}

/**
 * src/lib/drive-api.ts の型付きエラー（DriveAccessDeniedError / DriveAuthError /
 * DriveTransientError）を判定するための最小形。instanceof で判定すると drive-api.ts を
 * import することになり、このモジュールの純粋性（DOM・state・i18n は元より、実行時に副作用を
 * 持ちうる他モジュールにも依存しない）が崩れるため、drive-api.ts が付与する安定した `name`
 * プロパティで判定する（drive-api.ts の describeDriveAccessError() と同じ発想）。
 */
function looksLikeNamedError(err: unknown, name: string): err is { name: string; status?: number } {
    return !!err && typeof err === 'object' && (err as { name?: unknown }).name === name;
}

/**
 * src/lib/gemini-api.ts の GeminiApiError を判定するための最小形。
 * 同じ理由（純粋性維持）で instanceof ではなく name プロパティで判定する。
 */
function looksLikeGeminiApiError(err: unknown): boolean {
    return looksLikeNamedError(err, 'GeminiApiError');
}

/** 1件の失敗を種別へ分類する */
export function classifyFulltextAiFailure(err: unknown): FulltextAiFailureKind {
    if (err instanceof NoDriveUrlError) return 'no_drive_url';
    if (err instanceof PdfReadError) return 'pdf';
    if (err instanceof PdfTooLargeError) return 'pdf';
    if (err instanceof LlmCallError) return 'llm';
    if (looksLikeNamedError(err, 'DriveAccessDeniedError')) {
        return err.status === 404 ? 'drive_not_found' : 'drive_denied';
    }
    if (looksLikeNamedError(err, 'DriveAuthError')) return 'drive_auth';
    if (looksLikeNamedError(err, 'DriveTransientError')) return 'drive_transient';
    if (looksLikeGeminiApiError(err)) return 'llm';
    return 'other';
}

/** 分類済みの失敗種別一覧から件数と内訳を集計する */
export function summarizeFailures(
    kinds: readonly FulltextAiFailureKind[]
): { failedCount: number; breakdown: Partial<Record<FulltextAiFailureKind, number>> } {
    const breakdown: Partial<Record<FulltextAiFailureKind, number>> = {};
    for (const kind of kinds) {
        breakdown[kind] = (breakdown[kind] ?? 0) + 1;
    }
    return { failedCount: kinds.length, breakdown };
}

// シート直編集で未知のキーが混入した場合に弾くための既知キー一覧
const ALL_FAILURE_KINDS: readonly FulltextAiFailureKind[] = [
    'drive_denied', 'drive_not_found', 'drive_auth', 'drive_transient',
    'no_drive_url', 'pdf', 'llm', 'other'
];
const KNOWN_FAILURE_KIND_SET = new Set<string>(ALL_FAILURE_KINDS);

/** 失敗内訳をシート保存用のJSON文字列にする。0件の種別はキーごと落とす。空なら空文字を返す */
export function serializeFailureBreakdown(
    breakdown: Partial<Record<FulltextAiFailureKind, number>>
): string {
    const entries = ALL_FAILURE_KINDS
        .filter(kind => (breakdown[kind] ?? 0) > 0)
        .map(kind => [kind, breakdown[kind]] as const);
    if (entries.length === 0) return '';
    return JSON.stringify(Object.fromEntries(entries));
}

/**
 * シートに保存された失敗内訳のJSON文字列をパースする。
 * シート直編集がありうるため、壊れたJSON・想定外のキー・数値でない値は握りつぶして無視する。
 */
export function parseFailureBreakdown(
    raw: string | undefined
): Partial<Record<FulltextAiFailureKind, number>> {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Partial<Record<FulltextAiFailureKind, number>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!KNOWN_FAILURE_KIND_SET.has(key)) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        result[key as FulltextAiFailureKind] = value;
    }
    return result;
}
