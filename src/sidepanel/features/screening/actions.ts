/**
 * スクリーニングアクションモジュール
 * 判定、ナビゲーション、ショートカットなど
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { getFilteredReferences } from './filters';
import type { Decision } from '../../../lib/types';
import {
    saveDecision as apiSaveDecision,
    setKeyOpenedStatus,
    getReferencesWithStatus,
    getReferencesWithAllDecisions
} from '../../../lib/sheets-api';
import { showLoading, showToast } from '../../ui/feedback';
import { renderKeyStatus } from './render';
import { renderReviewerFilter } from './reviewer-filter';

// 外部レンダリング関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;
let _renderSpecificReference: ((ref: any) => void) | null = null;

export function setActionDependencies(deps: {
    renderCurrentReference: () => void;
    renderSpecificReference: (ref: any) => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
    _renderSpecificReference = deps.renderSpecificReference;
}

/**
 * ナビゲーション処理
 */
export async function navigate(direction: number) {
    const filtered = getFilteredReferences();
    const currentRef = filtered[state.currentIndex];

    // 遷移前に現在のメモを保存（変更されている場合のみ）
    if (currentRef) {
        const currentNote = dom.noteInput.value || undefined;
        const savedNote = currentRef.myDecision?.note;

        if (currentNote !== savedNote) {
            if (currentRef.myDecision) {
                // 既存の判定がある場合はメモを更新
                currentRef.myDecision.note = currentNote;
                currentRef.myDecision.decided_at = new Date().toISOString();

                // バックグラウンドで保存
                apiSaveDecision(state.spreadsheetId, currentRef.myDecision)
                    .then(() => console.log('Note saved on navigate:', currentRef.myDecision))
                    .catch((error) => {
                        console.error('Failed to save note on navigate:', error);
                    });
            } else if (currentNote) {
                // 未判定だがメモが入力されている場合は新しいDecisionを作成
                const newDecision: Decision = {
                    decision_id: crypto.randomUUID(),
                    ref_id: currentRef.ref_id,
                    reviewer_id: state.userEmail,
                    decision: 'pending',  // 未判定時のメモはpendingとして保存
                    note: currentNote,
                    decided_at: new Date().toISOString(),
                    client_version: '0.1.0',
                };
                currentRef.myDecision = newDecision;

                // バックグラウンドで保存
                apiSaveDecision(state.spreadsheetId, newDecision)
                    .then(() => console.log('Note saved on navigate (new decision):', newDecision))
                    .catch((error) => {
                        console.error('Failed to save note on navigate:', error);
                    });
            }
        }
    }

    let newIndex = state.currentIndex + direction;

    // ループナビゲーション
    if (newIndex < 0) {
        newIndex = filtered.length - 1;  // 最初から最後へ
    } else if (newIndex >= filtered.length) {
        newIndex = 0;  // 最後から最初へ
    }

    if (filtered.length > 0) {
        state.setCurrentIndex(newIndex);
        if (_renderCurrentReference) {
            _renderCurrentReference();
        }
    }
}

/**
 * 判定処理
 */
export async function handleDecision(decision: 'include' | 'exclude' | 'maybe') {
    const filtered = getFilteredReferences();
    const ref = filtered[state.currentIndex];

    if (!ref) return;

    // 判定オブジェクトを作成
    const decisionObj: Decision = {
        decision_id: ref.myDecision?.decision_id || crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: state.userEmail,
        decision,
        note: dom.noteInput.value || undefined,
        decided_at: new Date().toISOString(),
        client_version: '0.1.0',
    };

    // ローカル状態を更新
    ref.myDecision = decisionObj;

    // キーオープン後の場合、allDecisionsも更新
    if (state.isKeyOpened && ref.allDecisions) {
        const existingIndex = ref.allDecisions.findIndex(d => d.reviewer_id === state.userEmail);
        if (existingIndex !== -1) {
            ref.allDecisions[existingIndex] = decisionObj;
        } else {
            ref.allDecisions.push(decisionObj);
        }

        // 不一致状態を再計算
        const decisions = ref.allDecisions;
        if (decisions.length === 0) {
            ref.hasConflict = false;
            ref.status = 'pending';
        } else if (decisions.length === 1) {
            ref.hasConflict = true;
            ref.status = 'conflict';
        } else {
            const uniqueDecisions = new Set(decisions.map(d => d.decision));
            ref.hasConflict = uniqueDecisions.size > 1;
            ref.status = ref.hasConflict ? 'conflict' : decision;
        }
    } else {
        ref.status = decision;
    }

    // 次の文献へ（自動遷移設定が有効な場合のみ）
    console.log('[handleDecision] autoNavigateAfterDecision:', state.autoNavigateAfterDecision);
    if (state.autoNavigateAfterDecision) {
        // 自動遷移オン: UIを更新して次へ
        if (_renderCurrentReference) _renderCurrentReference();
        navigate(1);
    } else {
        // 自動遷移オフ: 同じ文献に留まる
        // フィルター結果ではなく、判定した文献を直接表示
        if (_renderSpecificReference) _renderSpecificReference(ref);
    }

    // APIに保存（バックグラウンド、UIブロックしない）
    apiSaveDecision(state.spreadsheetId, decisionObj)
        .then(() => console.log('Decision saved:', decisionObj))
        .catch((error) => {
            console.error('Failed to save decision:', error);
            // TODO: オフラインキューに追加
        });
}

/**
 * キー状態切替処理
 */
export async function handleKeyToggle() {
    // チェックボックスは既に切り替わっているので、その状態を取得
    const newState = dom.keyToggleInput.checked;

    if (!newState) {
        // CLOSE処理 (ON -> OFF)
        if (!confirm('Blind onを実行しますか？\n他のレビュアーの判定が見えなくなり、不一致表示も非表示になります。')) {
            // キャンセルされたら元の状態に戻す
            dom.keyToggleInput.checked = true;
            return;
        }

        try {
            showLoading(true);
            await setKeyOpenedStatus(state.spreadsheetId, false);
            state.setIsKeyOpened(false);

            // データを再読み込み（自分の判定のみ取得になる）
            const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);
            state.setReferences(refs);

            // レビュアーフィルターをクリア
            state.setAvailableReviewers(new Set());
            state.setEnabledReviewers(new Set());

            // 表示を更新
            renderKeyStatus();
            renderReviewerFilter();  // レビュアーリストを非表示に
            state.setCurrentIndex(0);
            state.setCurrentFilter('pending');
            dom.statusFilter.value = 'pending';
            if (_renderCurrentReference) _renderCurrentReference();

            showToast('Blind onを実行しました');
        } catch (error) {
            console.error('Key close error:', error);
            alert(`Blind onエラー: ${(error as Error).message}`);
            // エラー時は元の状態に戻す
            dom.keyToggleInput.checked = true;
        } finally {
            showLoading(false);
        }

    } else {
        // OPEN処理 (OFF -> ON)
        if (!confirm('Blind offを実行しますか？\n全レビュアーの判定が相互に見えるようになり、不一致が表示されます。')) {
            // キャンセルされたら元の状態に戻す
            dom.keyToggleInput.checked = false;
            return;
        }

        try {
            showLoading(true);
            await setKeyOpenedStatus(state.spreadsheetId, true);
            state.setIsKeyOpened(true);

            // データを再読み込み（全員の判定を取得）
            const refs = await getReferencesWithAllDecisions(state.spreadsheetId, state.userEmail);
            state.setReferences(refs);

            // レビュアーを抽出
            const reviewers = new Set<string>();
            refs.forEach(ref => {
                if (ref.allDecisions) {
                    ref.allDecisions.forEach(d => reviewers.add(d.reviewer_id));
                }
            });
            state.setAvailableReviewers(reviewers);
            state.setEnabledReviewers(new Set(reviewers));

            // 表示を更新
            renderKeyStatus();
            renderReviewerFilter();
            state.setCurrentIndex(0);
            state.setCurrentFilter('pending');
            dom.statusFilter.value = 'pending';
            if (_renderCurrentReference) _renderCurrentReference();

            showToast('Blind offを実行しました');
        } catch (error) {
            console.error('Key open error:', error);
            alert(`Blind openエラー: ${(error as Error).message}`);
            // エラー時は元の状態に戻す
            dom.keyToggleInput.checked = false;
        } finally {
            showLoading(false);
        }
    }
}

/**
 * キーボードショートカットハンドラ
 */
export function handleKeydown(e: KeyboardEvent) {
    // 入力フォーム内では無効
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
    }

    // 修飾キーなし
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
            case 'i': // Include
                handleDecision('include');
                e.preventDefault();
                break;
            case 'e': // Exclude
                handleDecision('exclude');
                e.preventDefault();
                break;
            case 'm': // Maybe
            case '?':
                handleDecision('maybe');
                e.preventDefault();
                break;
            case 'arrowright': // Next
            case 'j':
                navigate(1);
                e.preventDefault();
                break;
            case 'arrowleft': // Prev
            case 'k':
                navigate(-1);
                e.preventDefault();
                break;
        }
    }
}
