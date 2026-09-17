/**
 * 「不一致の解消」セクションの裁定確定 UI と裁定票の保存を担当する。
 * results.ts が800行制約を超えたため、裁定操作を切り出した。
 */

import { state } from '../../state';
import { t } from '../../../lib/i18n';
import { showToast } from '../../ui/feedback';
import { reloadReferences as reloadFulltextReferences } from './ai';
import { getClientVersion } from '../../../lib/client-version';
import { saveDecision } from '../../../lib/sheets-api';
import { adjudicationReviewerId, isAdjudicationKey } from '../../../lib/fulltext-consensus';
import type { FulltextVote } from '../../../lib/fulltext-consensus';
import type {
    ReferenceWithStatus,
    Decision,
    FulltextAdjudicationNote,
    FulltextAdjudicationVoteSnapshot,
} from '../../../lib/types';

export function buildAdjudicationControls(
    ref: ReferenceWithStatus,
    votes: FulltextVote[],
    alreadyAdjudicated: boolean,
    adjudicationMemo: string | null,
    onSaved: () => void
): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fulltext-conflict-controls';

    const head = document.createElement('div');
    head.className = 'fulltext-conflict-controls-head';
    head.textContent = t(alreadyAdjudicated ? 'fulltext_conflictRedoHead' : 'fulltext_conflictResolveHead');
    wrap.appendChild(head);

    const memoInput = document.createElement('textarea');
    memoInput.className = 'fulltext-conflict-memo-input';
    memoInput.rows = 2;
    memoInput.placeholder = t('fulltext_conflictMemoPlaceholder');
    memoInput.value = alreadyAdjudicated ? (adjudicationMemo || '') : '';
    wrap.appendChild(memoInput);

    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'fulltext-conflict-controls-buttons';

    const btnInclude = document.createElement('button');
    btnInclude.type = 'button';
    btnInclude.className = 'btn btn-small btn-include';
    btnInclude.textContent = t('fulltext_conflictAdjudicateInclude');
    btnInclude.addEventListener('click', () => { void handleAdjudicate(ref, 'include', undefined, votes, memoInput.value, onSaved); });
    buttonsRow.appendChild(btnInclude);

    const btnMaybe = document.createElement('button');
    btnMaybe.type = 'button';
    btnMaybe.className = 'btn btn-small btn-maybe';
    btnMaybe.textContent = t('fulltext_conflictAdjudicateMaybe');
    btnMaybe.addEventListener('click', () => { void handleAdjudicate(ref, 'maybe', undefined, votes, memoInput.value, onSaved); });
    buttonsRow.appendChild(btnMaybe);

    wrap.appendChild(buttonsRow);

    // 除外理由の優先順位ルール（スクリーニング側 .ft-reason-priority-note と同趣旨）。
    // 最終的な理由を決める裁定の場面でこそ効くルールなので、理由セレクトの直前に明示する。
    const reasonPriorityNote = document.createElement('div');
    reasonPriorityNote.className = 'fulltext-conflict-reason-priority-note';
    reasonPriorityNote.textContent = t('fulltext_conflictReasonPriorityNote');
    wrap.appendChild(reasonPriorityNote);

    const excludeRow = document.createElement('div');
    excludeRow.className = 'fulltext-conflict-controls-exclude-row';

    const reasonSelect = document.createElement('select');
    reasonSelect.className = 'fulltext-conflict-reason-select';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = t('fulltext_conflictReasonPlaceholder');
    reasonSelect.appendChild(placeholderOpt);
    // 選択肢はプロジェクト設定（Config タブ fulltext_exclude_reasons）から。
    // スクリーニング側（fulltext.ts の renderReasonOptions）と同じ配列・同じ並び。
    state.excludeReasonItems.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = item.key;
        opt.textContent = `${idx + 1}. ${item.label}`;
        reasonSelect.appendChild(opt);
    });

    const btnExclude = document.createElement('button');
    btnExclude.type = 'button';
    btnExclude.className = 'btn btn-small btn-exclude';
    btnExclude.textContent = t('fulltext_conflictAdjudicateExclude');
    btnExclude.addEventListener('click', () => { void handleAdjudicate(ref, 'exclude', reasonSelect.value, votes, memoInput.value, onSaved); });

    excludeRow.appendChild(reasonSelect);
    excludeRow.appendChild(btnExclude);
    wrap.appendChild(excludeRow);

    return wrap;
}

/** 裁定を確定して保存する。裁定票は追記専用経路（-human-adjudication）に乗り、やり直しの履歴も残る。 */
async function handleAdjudicate(
    ref: ReferenceWithStatus,
    decision: 'include' | 'exclude' | 'maybe',
    reason: string | undefined,
    votes: FulltextVote[],
    memo: string,
    onSaved: () => void
): Promise<void> {
    const email = state.userEmail;
    if (!email) return;

    if (decision === 'exclude' && !reason) {
        showToast(t('fulltext_conflictReasonRequired'), 3000);
        return;
    }

    const snapshot: FulltextAdjudicationVoteSnapshot[] = votes
        .filter(v => !isAdjudicationKey(v.judge))
        .map(v => ({ judge: v.judge, decision: v.decision, reason: v.reason, note: v.note }));

    const now = new Date().toISOString();
    const note: FulltextAdjudicationNote = {
        type: 'fulltext_adjudication',
        adjudicated_by: email,
        adjudicated_at: now,
        votes: snapshot,
    };
    const trimmedMemo = memo.trim();
    if (trimmedMemo) note.memo = trimmedMemo;

    const decisionObj: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: adjudicationReviewerId(email),
        decision,
        reason: decision === 'exclude' ? reason : undefined,
        note: JSON.stringify(note),
        decided_at: now,
        client_version: getClientVersion('-human-adjudication'),
        screening_phase: 'fulltext',
    };

    try {
        await saveDecision(state.spreadsheetId, decisionObj);
        showToast(t('fulltext_conflictAdjudicateSaved'), 3000);
        // 既存の参照再読込パターン（fulltext/ai.ts の reloadReferences）を再利用して state を更新し、
        // 合議表示（結果一覧・PRISMA・この不一致解消セクション自体）を最新化する
        await reloadFulltextReferences(state.spreadsheetId);
        onSaved();
    } catch (err) {
        console.error('[fulltext-results] adjudication save failed:', err);
        showToast(t('fulltext_conflictAdjudicateSaveFailed'), 4000);
    }
}
