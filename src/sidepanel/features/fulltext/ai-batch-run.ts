/**
 * 全文の AI 一括判定の実行本体（ループと終了処理）。
 * DOM・state に依存しない依存注入型にして、node のテストから中止・宛先・画面の書き換えを検証できるようにする
 * （ai.ts は DOM 依存でテストから直接は通せない）。
 *
 * - 判定の保存・実行記録・参照の読み直しは、開始時の spreadsheetId で行う。
 * - 戻る・ログアウトで `run.cancelled` が立っても、実行中の1件は終わるまで続き、その結果は開始時のシートへ保存される
 *   （「中止」ボタンと同じ）。次の文献へは進まず、そのラウンドは採用しない。
 * - 画面の書き換え（ログ・進み具合・ボタン・トースト）は `isCurrentRun()` のときだけ行う。
 *   切り替えた後の画面に前のプロジェクトの結果を出さず、切り替えた後に始めた実行の印も消さない。
 */

import { t } from '../../../lib/i18n';
import {
    classifyFulltextAiFailure,
    summarizeFailures,
    serializeFailureBreakdown,
    type FulltextAiFailureKind,
} from '../../../lib/fulltext-ai-failures';
import { DriveAccessDeniedError, describeDriveAccessError } from '../../../lib/drive-api';
import type { LlmExecution, ReferenceWithStatus } from '../../../lib/types';

export interface AiBatchRun {
    cancelled: boolean;
}

export interface AiBatchRunParams {
    spreadsheetId: string;
    reviewerId: string;
    executionId: string;
    targets: ReferenceWithStatus[];
    run: AiBatchRun;
    /** この実行が今も現役か（戻る・ログアウトで初期化されたら false） */
    isCurrentRun: () => boolean;
    initialExecution: LlmExecution;
    /** 開始行の保存に成功したか（終了時の記録方法をこれで分岐する） */
    executionLogWritten: boolean;
}

export interface AiBatchRunDeps {
    judgeOne: (ref: ReferenceWithStatus) => Promise<{ decision: 'include' | 'exclude' | 'maybe'; evidenceTruncated: boolean }>;
    setFulltextAiActiveRound: (spreadsheetId: string, roundId: string) => Promise<unknown>;
    updateLlmExecution: (spreadsheetId: string, executionId: string, patch: Partial<LlmExecution>) => Promise<unknown>;
    saveLlmExecution: (spreadsheetId: string, execution: LlmExecution) => Promise<unknown>;
    reloadReferences: (spreadsheetId: string) => Promise<void>;
    showToast: (message: string, duration?: number) => void;
    appendLog: (text: string, cls?: string) => void;
    updateProgress: (done: number, total: number, ok: number, ng: number) => void;
    /** 終了時の画面の戻し（ボタン・入力欄・件数・ラウンド表示）。現役のときだけ呼ぶ */
    finishUi: () => void;
    /** 現役のときだけ呼ぶ。実行の印（session.aiAbort）を外す */
    clearRun: () => void;
}

export async function executeAiBatchRun(
    params: AiBatchRunParams,
    deps: AiBatchRunDeps
): Promise<{ ok: number; ng: number }> {
    const { spreadsheetId, reviewerId, executionId, targets, run, isCurrentRun, initialExecution, executionLogWritten } = params;
    // 現役でなくなった実行は画面に書かない
    const log = (text: string, cls?: string): void => {
        if (isCurrentRun()) deps.appendLog(text, cls);
    };

    let done = 0, ok = 0, ng = 0;
    // Drive の読み取り権限が無くて落ちた件数（drive.file は「アプリ×ユーザー×ファイル」単位の
    // 付与なので、他メンバーがアップロードしたPDFは読めない。プロジェクト全体を対象にすると
    // まとまった件数で起きうるため、最後に復旧導線をまとめて案内する）。
    // 定義上 failureKinds の drive_denied + drive_not_found の件数と一致するはずなので、
    // 分類ロジック（classifyFulltextAiFailure）側だけを直して乖離させないこと。
    let driveDenied = 0;
    // include/exclude/maybe の内訳（実行履歴の include_count/exclude_count/maybe_count に使う）
    const decisionCounts: Record<'include' | 'exclude' | 'maybe', number> = { include: 0, exclude: 0, maybe: 0 };
    // 失敗種別ごとの内訳（実行履歴の failure_breakdown に使う）
    const failureKinds: FulltextAiFailureKind[] = [];
    if (isCurrentRun()) deps.updateProgress(0, targets.length, 0, 0);
    log(t('fulltext_aiStarted', String(targets.length)));

    try {
        for (const ref of targets) {
            if (run.cancelled) {
                log(t('fulltext_aiCancelled'), 'log-warn');
                break;
            }
            try {
                const { decision, evidenceTruncated } = await deps.judgeOne(ref);
                ok++;
                decisionCounts[decision]++;
                log(`✓ ${ref.title || ref.ref_id}${evidenceTruncated ? ` — ${t('fulltext_aiEvidenceTruncated')}` : ''}`,
                    evidenceTruncated ? 'log-warn' : 'log-ok');
            } catch (err) {
                ng++;
                if (err instanceof DriveAccessDeniedError) driveDenied++;
                failureKinds.push(classifyFulltextAiFailure(err));
                const msg = err instanceof Error ? err.message : String(err);
                log(`✕ ${ref.title || ref.ref_id} — ${describeDriveAccessError(err) ?? msg}`, 'log-err');
            } finally {
                done++;
                if (isCurrentRun()) deps.updateProgress(done, targets.length, ok, ng);
            }
        }
    } finally {
        // 1件以上成功していれば、今回のラウンドを自動採用する（中断時は採用しない）
        if (ok > 0 && !run.cancelled) {
            try {
                await deps.setFulltextAiActiveRound(spreadsheetId, reviewerId);
                if (isCurrentRun()) deps.showToast(t('fulltext_aiRoundAdopted'), 2500);
            } catch (err) {
                console.warn('[fulltext-ai] 自動採用に失敗:', err);
            }
        }

        // 実行履歴を確定させる。中断・全件失敗でも「実行したが0件成功だった」という事実自体を
        // 残すのが本Issueの主眼なので、条件を付けず必ず更新を試みる（失敗しても判定処理は止めない）。
        const { failedCount, breakdown } = summarizeFailures(failureKinds);
        const finalCounts = {
            include_count: decisionCounts.include,
            exclude_count: decisionCounts.exclude,
            maybe_count: decisionCounts.maybe,
            failed_count: failedCount,
            failure_breakdown: serializeFailureBreakdown(breakdown),
        };
        try {
            if (executionLogWritten) {
                await deps.updateLlmExecution(spreadsheetId, executionId, {
                    ...finalCounts,
                    status: 'confirmed',
                });
            } else {
                // 開始行の保存に失敗していると updateLlmExecution は対象行が無いため必ず
                // 「Execution not found」で失敗し、この Run の履歴が1行も残らなくなる。
                // 開始失敗の典型はネットワーク瞬断で、判定が終わる頃には回復していることが
                // 多いため、確定値を入れた行をここで新規作成するフォールバックで履歴を救う。
                await deps.saveLlmExecution(spreadsheetId, {
                    ...initialExecution,
                    ...finalCounts,
                    status: 'confirmed',
                });
            }
        } catch (err) {
            // フォールバック経路もさらに失敗しうるが、判定処理自体は止めず警告に留める
            console.warn('[fulltext-ai] 実行履歴（終了）の記録に失敗:', err);
            log(t('fulltext_aiExecutionLogFailed'), 'log-warn');
        }

        // 判定結果を反映するため参照を再読込（開始時のシートで。現在のプロジェクトと違えば reloadReferences 側が捨てる）
        await deps.reloadReferences(spreadsheetId);
        // 画面の書き換えと実行の印の解除は、この実行が現役のときだけ
        if (isCurrentRun()) {
            deps.finishUi();
            deps.clearRun();
            deps.appendLog(t('fulltext_aiDone', [String(ok), String(ng)]), 'log-done');
            if (driveDenied > 0) {
                deps.appendLog(t('fulltext_aiDriveDeniedHint', String(driveDenied)), 'log-warn');
            }
            deps.showToast(t('fulltext_aiDone', [String(ok), String(ng)]), 4000);
        }
    }
    return { ok, ng };
}
