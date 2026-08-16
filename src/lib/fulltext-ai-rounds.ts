/**
 * フルテキストAI判定のラウンド一覧（純関数のみ）
 *
 * Issue #62: 「全件失敗したラウンドは Decisions に1行も無いため、Decisions だけを見ている
 * 従来の deriveRounds には現れない」という欠落を埋めるためのモジュール。
 * 「実行したが0件成功だった」という事実も後から確認できるようにするのが本Issueの主眼なので、
 * LLM_Executions（execution_type='fulltext_batch_screening'）側にしか存在しないラウンドも
 * 一覧へ追加する（total === 0 で識別できる）。
 *
 * ただし `deleteFulltextAiRound`（sheets-api.ts）は Decisions の行しか削除せず
 * LLM_Executions の行は残るため、「かつて成功判定があったのに Decisions に無い」実行履歴は
 * ユーザーが削除したラウンドである。これを無条件に追加すると、削除したはずのラウンドが
 * 採用も削除もできないゾンビ行として復活してしまうため、追加対象は「成功判定が0件の
 * 実行履歴」だけに絞る（詳細は mergeRoundsWithExecutions 内のコメント参照）。
 *
 * tests/ は node:test の純関数テストのみで DOM 環境が無いため、DOM・state・i18n には
 * 依存しない（同じ方針の先例: src/lib/fulltext-ai-failures.ts / src/lib/fulltext-ai-target.ts）。
 */

import type { Decision, LlmExecution } from './types';
import { parseFailureBreakdown, type FulltextAiFailureKind } from './fulltext-ai-failures';

/** Decisions（screening_phase='fulltext' の llm: 判定）から集約した1ラウンド */
export interface AiRound {
    reviewerId: string;
    model: string;
    timestamp: string;
    include: number;
    exclude: number;
    maybe: number;
    total: number;
}

/** AiRound に LLM_Executions（実行履歴）の情報を結合したもの */
export interface AiRoundWithExecution extends AiRound {
    /** この reviewerId（= execution_id）に対応する LLM_Executions 行があるか */
    hasExecution: boolean;
    /** 実行時の対象件数。対応する実行履歴が無ければ null */
    targetCount: number | null;
    /** 実行アカウント（メールアドレス）。対応する実行履歴が無ければ null */
    executedBy: string | null;
    /** 実行履歴側の確定状態。対応する実行履歴が無ければ null */
    executionStatus: 'pending' | 'confirmed' | null;
    /** 失敗件数（対応する実行履歴が無ければ0） */
    failedCount: number;
    /** 失敗種別ごとの内訳（対応する実行履歴が無い、または内訳未記録なら空） */
    failureBreakdown: Partial<Record<FulltextAiFailureKind, number>>;
}

/** fulltext フェーズの llm: 判定を reviewer_id 単位のラウンドへ集約する */
export function deriveRounds(decisions: Decision[]): AiRound[] {
    const map = new Map<string, AiRound>();
    for (const d of decisions) {
        if ((d.screening_phase ?? 'tiab') !== 'fulltext') continue;
        const rid = (d.reviewer_id || '').trim();
        if (!rid.startsWith('llm:')) continue;
        let r = map.get(rid);
        if (!r) {
            const body = rid.slice('llm:'.length);
            const at = body.lastIndexOf('@'); // ISO タイムスタンプに '@' は含まれない
            r = {
                reviewerId: rid,
                model: at >= 0 ? body.slice(0, at) : body,
                timestamp: at >= 0 ? body.slice(at + 1) : '',
                include: 0, exclude: 0, maybe: 0, total: 0,
            };
            map.set(rid, r);
        }
        r.total++;
        if (d.decision === 'include') r.include++;
        else if (d.decision === 'exclude') r.exclude++;
        else if (d.decision === 'maybe') r.maybe++;
    }
    return [...map.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** 実行履歴1件を AiRound へ変換する（executions側にしか無いラウンド用） */
function executionOnlyRound(exec: LlmExecution): AiRound {
    return {
        reviewerId: exec.execution_id,
        model: exec.model,
        timestamp: exec.timestamp,
        include: 0, exclude: 0, maybe: 0, total: 0,
    };
}

/**
 * Decisions由来のラウンド一覧（deriveRounds の結果）へ、LLM_Executions の実行履歴
 * （execution_type='fulltext_batch_screening' のみ。TiAb の batch_screening 行は混ぜない）
 * を結合する。
 *
 * - 結合キーは execution_id === reviewerId
 * - executions 側にしか無いラウンド（Decisions に1行も無い＝全件失敗、または実行履歴の
 *   書き込み後に判定が1件も保存されなかったケース）も追加する。total === 0 で識別できる
 * - 既存のソート順（timestamp 降順）は維持する
 */
export function mergeRoundsWithExecutions(
    rounds: readonly AiRound[],
    executions: readonly LlmExecution[]
): AiRoundWithExecution[] {
    const fulltextExecs = executions.filter(e => e.execution_type === 'fulltext_batch_screening');
    // 同一 execution_id の行が複数存在しうる（第1チャンクのフォールバック: 開始行の保存が
    // HTTPレベルでは失敗したが実際には書き込まれていた、というタイムアウト系のケースで
    // 終了時に新規行が追加作成されうる）。Map のキー代入は後から出てきた要素で上書きされる
    // （後勝ち）ため、配列の並び順で最後に出てきた行を採用する。この Map 自体が
    // execution_id を一意化してくれるので、下の「executions側にしか無いラウンド」の
    // 追加ループもこの Map を辿ることで自然に重複が排除される
    const execById = new Map(fulltextExecs.map(e => [e.execution_id, e]));

    const withExecution = (round: AiRound): AiRoundWithExecution => {
        const exec = execById.get(round.reviewerId);
        if (!exec) {
            return {
                ...round,
                hasExecution: false,
                targetCount: null,
                executedBy: null,
                executionStatus: null,
                failedCount: 0,
                failureBreakdown: {},
            };
        }
        return {
            ...round,
            hasExecution: true,
            targetCount: exec.target_count,
            executedBy: exec.executed_by ?? null,
            executionStatus: exec.status,
            failedCount: exec.failed_count ?? 0,
            failureBreakdown: parseFailureBreakdown(exec.failure_breakdown),
        };
    };

    const merged: AiRoundWithExecution[] = rounds.map(withExecution);
    const seenIds = new Set(rounds.map(r => r.reviewerId));

    // executions側にしか無いラウンドを追加する。ただし `deleteFulltextAiRound`（sheets-api.ts）は
    // **Decisions の行しか削除しない**ため、LLM_Executions 側の行はラウンド削除後も残り続ける。
    // これを無条件に「executions側にしか無いラウンド」として出すと、削除したはずのラウンドが
    // total===0（＝採用ラジオも削除ボタンも無効）の消せないゾンビ行として一覧に復活してしまう。
    // そこで「かつて成功判定が1件以上あった（include+exclude+maybe > 0）のに Decisions に
    // 無い」実行履歴は削除済みラウンドとみなして一覧に出さない。逆に成功判定が0件の実行履歴
    // （＝実際に全件失敗した、または1件も保存できずに終わった実行）だけを対象にする。
    // これが「実行したが0件成功だった」を後から確認できるようにする本Issueの主眼そのもの
    for (const [executionId, exec] of execById) {
        if (seenIds.has(executionId)) continue;
        const successCount = exec.include_count + exec.exclude_count + (exec.maybe_count ?? 0);
        if (successCount > 0) continue; // 削除済みラウンド（Decisionsから消えた）なので出さない
        merged.push(withExecution(executionOnlyRound(exec)));
    }

    return merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
