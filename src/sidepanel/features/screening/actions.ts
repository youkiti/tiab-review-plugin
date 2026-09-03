/**
 * スクリーニングアクションモジュール
 * 判定、ナビゲーション、ショートカットなど
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { platform } from '../../../platform';
import { getFilteredReferences } from './filters';
import type { Decision, ReferenceWithStatus } from '../../../lib/types';
import {
    setKeyOpenedStatus,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    isQuotaExceededError,
    logAuditEvent
} from '../../../lib/sheets-api';
import { getClientVersion, humanDecisionSuffix } from '../../../lib/client-version';
import { buildDecisionContext } from '../../../lib/decision-context';
import { shouldWarnBlindRule } from '../../../lib/fulltext-rule-editor';
import { showLoading, showToast } from '../../ui/feedback';
import { renderKeyStatus } from './render';
import { renderReviewerFilter, renderAiHighlightToggle, renderConsensusModeToggle } from './reviewer-filter';
import { getReviewerKey, isActiveConfirmedLlmDecision } from './reviewer-utils';
import { saveDecisionOrQueue } from '../unsent-queue';
import { noteLocalTeamDecision } from '../team-progress';
import { t } from '../../../lib/i18n';
import { toggleReviewCriteriaModal, closeReviewCriteriaModal, isCriteriaModalOpen, isCriteriaEditMode } from '../review-criteria';

// Store互換レイヤー（Phase 3）
import {
    setCurrentIndex as syncSetCurrentIndex,
    setCurrentFilter as syncSetCurrentFilter,
    setIsKeyOpened as syncSetIsKeyOpened,
    setReferences as syncSetReferences,
    setAvailableReviewers as syncSetAvailableReviewers,
    setEnabledReviewers as syncSetEnabledReviewers,
} from '../../store/compat';

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

async function saveDecisionWithQueue(decision: Decision, notifyOnFailure: boolean) {
    // チーム進捗パネルの自分の行を即時更新（オフラインキュー行きでも判定自体は有効）
    noteLocalTeamDecision(decision);

    // 保存失敗の分類・再ログイン・キュー退避・種類別トーストは unsent-queue.ts の共通ロジックへ
    // 委譲する（ml/actions.ts の saveMlDecisionWithQueue と同じロジックを共有する）
    await saveDecisionOrQueue(decision, { notifyOnFailure });
}

/**
 * 判定の瞬間にこの文献へ付いていたAI票（採用中の確定AI判定）の件数を数える。
 * render.ts の evidence ハイライトと同じ判定関数（isActiveConfirmedLlmDecision）を再利用する。
 * context_json（decision-context.ts）の ai_votes_at_decision に使う。
 */
function countActiveAiVotesAtDecision(ref: ReferenceWithStatus): number {
    return ref.allDecisions?.filter((d) => isActiveConfirmedLlmDecision(d)).length ?? 0;
}

function getReferenceById(refId: string | null | undefined): ReferenceWithStatus | undefined {
    if (!refId) return undefined;
    return state.references.find((ref) => ref.ref_id === refId);
}

function getDisplayedReference(filtered = getFilteredReferences()): ReferenceWithStatus | undefined {
    const historyRefId = state.getCurrentReviewHistoryRefId();
    const historyRef = getReferenceById(historyRefId);
    if (historyRef) {
        return historyRef;
    }
    return filtered[state.currentIndex];
}

async function persistDisplayedNote(ref: ReferenceWithStatus | undefined) {
    if (!ref) return;

    // noteInputに残っている値が、ref と異なる文献を render したときに残ったものだった場合、
    // その値を ref に保存してしまうと「過去の文献のメモを別文献の判定として保存」する
    // 幽霊判定バグになる。lastRenderedRefId が ref と一致しないときは保存しない。
    // （例: autoNavigate=OFF で判定後に「次へ」を押した直後の状態など）
    if (state.lastRenderedRefId && state.lastRenderedRefId !== ref.ref_id) {
        return;
    }

    const currentNote = dom.noteInput.value || undefined;
    const savedNote = ref.myDecision?.note;

    if (currentNote === savedNote) return;

    if (ref.myDecision) {
        // 既存の判定がある場合はメモを更新する。
        // Decisionsタブが追記専用になったため、既存オブジェクトを破壊的に書き換えて
        // 同じ decision_id のまま再保存すると、履歴上は同一判定イベントの重複行になってしまう。
        // decision / reason / client_version / source_url / screening_phase は引き継ぎつつ、
        // decision_id と decided_at だけ新規発番した新しい Decision に差し替える。
        const updatedDecision: Decision = {
            ...ref.myDecision,
            decision_id: crypto.randomUUID(),
            note: currentNote,
            decided_at: new Date().toISOString(),
            // context_json は元判定時点の値をスプレッドで引き継がず、メモ更新の瞬間の状態で作り直す
            // （decided_at がメモ更新時刻になるのに暴露記録だけ過去のもの、という不整合を防ぐ）
            context_json: buildDecisionContext({
                keyOpened: state.isKeyOpened,
                aiHighlights: state.showAiHighlights,
                aiVotesAtDecision: countActiveAiVotesAtDecision(ref),
            }),
        };
        ref.myDecision = updatedDecision;
        saveDecisionWithQueue(updatedDecision, false);
        return;
    }

    if (!currentNote) return;

    const newDecision: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: state.userEmail,
        decision: 'pending',
        note: currentNote,
        decided_at: new Date().toISOString(),
        // メモのみ行は判定イベントではないため、合議モード中でも常に '-human'（consensusModeは反映しない）
        client_version: getClientVersion('-human'),
        context_json: buildDecisionContext({
            keyOpened: state.isKeyOpened,
            aiHighlights: state.showAiHighlights,
            aiVotesAtDecision: countActiveAiVotesAtDecision(ref),
        }),
    };
    ref.myDecision = newDecision;
    saveDecisionWithQueue(newDecision, false);
}

function syncCurrentIndexToRefId(refId: string | null, filtered = getFilteredReferences()): boolean {
    if (filtered.length === 0) {
        syncSetCurrentIndex(0);
        return false;
    }

    if (refId) {
        const nextIndex = filtered.findIndex((ref) => ref.ref_id === refId);
        if (nextIndex !== -1) {
            syncSetCurrentIndex(nextIndex);
            return true;
        }
    }

    const boundedIndex = Math.max(0, Math.min(state.currentIndex, filtered.length - 1));
    syncSetCurrentIndex(boundedIndex);
    return true;
}

function finishReviewHistoryNavigation(filtered = getFilteredReferences()) {
    const returnRefId = state.reviewHistoryReturnRefId;
    state.resetReviewHistoryNavigation();
    syncCurrentIndexToRefId(returnRefId, filtered);
}

function canUseReviewHistory() {
    return state.currentFilter === 'pending' && state.reviewHistoryRefIds.length > 0;
}

function renderCurrentReference() {
    if (_renderCurrentReference) {
        _renderCurrentReference();
    }
}

function handleReviewHistoryNavigation(direction: number, filtered = getFilteredReferences()): boolean {
    if (!canUseReviewHistory()) {
        if (state.isReviewHistoryActive()) {
            state.resetReviewHistoryNavigation();
        }
        return false;
    }

    if (state.isReviewHistoryActive()) {
        if (direction < 0) {
            const nextCursor = Math.min(state.reviewHistoryCursor + 1, state.reviewHistoryRefIds.length - 1);
            state.setReviewHistoryCursor(nextCursor);
            renderCurrentReference();
            return true;
        }

        if (direction > 0) {
            if (state.reviewHistoryCursor > 0) {
                state.setReviewHistoryCursor(state.reviewHistoryCursor - 1);
            } else {
                finishReviewHistoryNavigation(filtered);
            }
            renderCurrentReference();
            return true;
        }

        return true;
    }

    if (direction < 0) {
        const returnRefId = filtered[state.currentIndex]?.ref_id ?? null;
        state.setReviewHistoryReturnRefId(returnRefId);
        state.setReviewHistoryCursor(0);
        renderCurrentReference();
        return true;
    }

    return false;
}

/**
 * ナビゲーション処理
 */
export async function navigate(direction: number) {
    const filtered = getFilteredReferences();
    const currentRef = getDisplayedReference(filtered);

    // 遷移前に現在のメモを保存（変更されている場合のみ）
    await persistDisplayedNote(currentRef);

    if (handleReviewHistoryNavigation(direction, filtered)) {
        return;
    }

    let newIndex = state.currentIndex + direction;

    // ループナビゲーション
    if (newIndex < 0) {
        newIndex = filtered.length - 1;  // 最初から最後へ
    } else if (newIndex >= filtered.length) {
        newIndex = 0;  // 最後から最初へ
    }

    if (filtered.length > 0) {
        // Store経由で両方に同期
        syncSetCurrentIndex(newIndex);
        renderCurrentReference();
    }
}

/**
 * 判定処理
 */
export async function handleDecision(decision: 'include' | 'exclude' | 'maybe') {
    const filtered = getFilteredReferences();
    const ref = getDisplayedReference(filtered);
    const wasReviewHistoryActive = state.isReviewHistoryActive();
    const historyReturnRefId = state.reviewHistoryReturnRefId;

    if (!ref) return;

    // 判定オブジェクトを作成
    // decision_id は判定イベントごとに毎回新規発番する（Decisionsタブが追記専用になったため、
    // 既存判定のIDを使い回すと判定変更の履歴が別イベントとして残らなくなる）
    // 合議モード（state.consensusMode）ONのときは '-human-consensus' サフィックスで保存する。
    // isHumanDecision() は '-human' の部分一致で判定するため、合議判定も従来どおり追記専用・
    // human判定として扱われつつ、client_version から合議での判定変更だと正確に識別できる。
    // ただし合議はブラインド中に成立しないため、キー未開封（state.isKeyOpened===false）のときは
    // state.consensusMode が残っていても必ず '-human' に落とす（humanDecisionSuffix参照）。
    // トグル非表示時に state を落とす防御（reviewer-filter.ts）とリセット関数の防御（state.ts）に
    // 加えた、書き込み地点そのものでのガード（多層防御）。
    const decisionObj: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: state.userEmail,
        decision,
        note: dom.noteInput.value || undefined,
        decided_at: new Date().toISOString(),
        client_version: getClientVersion(humanDecisionSuffix(state.isKeyOpened, state.consensusMode)),
        context_json: buildDecisionContext({
            keyOpened: state.isKeyOpened,
            aiHighlights: state.showAiHighlights,
            aiVotesAtDecision: countActiveAiVotesAtDecision(ref),
        }),
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

    if (state.currentFilter === 'pending' || wasReviewHistoryActive) {
        state.pushReviewHistoryRefId(ref.ref_id);
    } else {
        state.resetReviewHistoryNavigation();
    }

    // 次の文献へ（自動遷移設定が有効な場合のみ）
    if (wasReviewHistoryActive) {
        state.resetReviewHistoryNavigation();
        syncCurrentIndexToRefId(historyReturnRefId, getFilteredReferences());
        renderCurrentReference();
    } else if (state.autoNavigateAfterDecision) {
        // 判定後にその文献が絞り込み結果から抜けたか（Issue #140）。
        // 未判定フィルターだけでなく、不一致フィルターで不一致が解消したときや
        // include/exclude/maybe フィルターで判定を変えたときも文献が一覧から抜けるため、
        // navigate(1) すると繰り上がった次の1件を飛ばしてしまう。判定後に
        // getFilteredReferences() を呼び直せば、抜けたかどうかを一律に判定できる。
        const filteredAfter = getFilteredReferences();
        const stillListed = filteredAfter.some((r) => r.ref_id === ref.ref_id);
        if (!stillListed) {
            syncCurrentIndexToRefId(null, filteredAfter);
            renderCurrentReference();
        } else {
            navigate(1);
        }
    } else {
        // 自動遷移オフ: 同じ文献に留まる
        // フィルター結果ではなく、判定した文献を直接表示
        if (_renderSpecificReference) _renderSpecificReference(ref);
    }

    // APIに保存（バックグラウンド、UIブロックしない）
    saveDecisionWithQueue(decisionObj, true);
}

/**
 * キー切替失敗時のエラーメッセージを組み立てる。
 * クォータ超過（連打によるSheets API 429）は生のAPIエラー文をそのまま出さず、
 * 専用の分かりやすいメッセージに差し替える。それ以外は従来どおり既存キーでエラー文を表示する。
 */
function buildKeyToggleErrorMessage(key: 'blind_onError' | 'blind_offError', error: unknown): string {
    if (isQuotaExceededError(error)) {
        return t('error_quotaExceeded');
    }
    const message = error instanceof Error ? error.message : String(error);
    return t(key, message);
}

/**
 * キー状態切替処理
 *
 * 「取得してから確定する」順序で実行する: setKeyOpenedStatus による永続化やローカル状態の
 * 変更より前に getReferencesWith*() のデータ取得を成功させる。取得は isKeyOpened に依存せず
 * 引数だけで完結するため、この順序でも結果は変わらない。途中で失敗しても何も永続化・変更して
 * いない状態を保てるため、catch側はチェックボックスの見た目を戻すだけで整合が取れる
 * （旧実装は永続化・状態更新の後にデータ取得しており、取得失敗時に isKeyOpened と
 * availableReviewers/enabledReviewers が食い違って「レビュアーが誰も表示されない」まま
 * 固まる不具合があった）。
 */
export async function handleKeyToggle() {
    // チェックボックスは既に切り替わっているので、その状態を取得
    const newState = dom.keyToggleInput.checked;

    if (!newState) {
        // CLOSE処理 (ON -> OFF)
        // 実際に起きた事故への対策: 候補ルールが人間の票を使い、かつ担当割り振りが
        // 未設定のままBlindへ戻すと、他のメンバーの候補リストが0件になる
        // （他人の票はBlind中クライアントへ配られないため）。この経路で警告する。
        // ルール保存時のガード（fulltext-rule-editor.ts）はキー開封中しか通らないため、
        // 「開封してルールを保存 → Blindへ戻す」という実運用の順序はここでしか拾えない。
        let confirmMessage = t('blind_onConfirm');
        if (state.fulltextPoolRule
            && shouldWarnBlindRule(state.fulltextPoolRule, false)
            && state.fulltextAssignment.status !== 'configured') {
            confirmMessage += '\n\n' + t('blind_onFulltextRuleWarn');
        }
        if (!confirm(confirmMessage)) {
            // キャンセルされたら元の状態に戻す
            dom.keyToggleInput.checked = true;
            return;
        }

        try {
            showLoading(true);

            // 1. 先にデータ取得を成功させる（失敗してもまだ何も変更していない）
            const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);

            // 2. 取得成功後に永続化
            await setKeyOpenedStatus(state.spreadsheetId, false);
            // 監査ログ（ベストエフォート。失敗してもキー切替自体は成功扱いのまま進める）
            await logAuditEvent(state.spreadsheetId, {
                event_type: 'key_closed',
                actor: state.userEmail,
                occurred_at: new Date().toISOString(),
                client_version: getClientVersion('-human'),
            });

            // 3. ローカル状態を確定
            state.clearReviewHistory();
            syncSetIsKeyOpened(false);
            syncSetReferences(refs);
            // プロジェクト全体を見る表示（フルテキストの結果ビュー = PRISMA・判定者一覧・
            // 不一致の解消・エクスポート）は state.allReferences を読むため、こちらも必ず更新する。
            // 更新しないと、Blindへ戻した後も他レビュアーの判定が結果ビューに残り続ける。
            state.setAllReferences(refs);
            // 合議はブラインド中に成立しないため、Blindへ戻すときは合議モードも必ず解除する
            state.setConsensusMode(false);

            // レビュアーフィルターをクリア（Store経由）
            syncSetAvailableReviewers(new Set());
            syncSetEnabledReviewers(new Set());

            // 表示を更新
            renderKeyStatus();
            renderReviewerFilter();  // レビュアーリストを非表示に
            renderAiHighlightToggle();  // AIハイライトトグルを更新
            renderConsensusModeToggle();  // 合議モードトグル・バッジを非表示に
            syncSetCurrentIndex(0);
            syncSetCurrentFilter('pending');
            dom.statusFilter.value = 'pending';
            if (_renderCurrentReference) _renderCurrentReference();

            // 別ウィンドウで開いているPDF判定画面（fulltext.ts）が古いキー状態のまま
            // 他レビュアーの判定を出し続けるのを防ぐため、キー状態の変更を通知する。
            // 受信側がいなくてもエラーにならない fire-and-forget。
            platform().emitMessage({ type: 'blind:key-changed', spreadsheetId: state.spreadsheetId, keyOpened: false });

            showToast(t('blind_onSuccess'));
        } catch (error) {
            console.error('Key close error:', error);
            alert(buildKeyToggleErrorMessage('blind_onError', error));
            // エラー時は元の状態に戻す（永続化・状態変更はまだ行っていないため、これだけで整合する）
            dom.keyToggleInput.checked = true;
        } finally {
            showLoading(false);
        }

    } else {
        // OPEN処理 (OFF -> ON)
        if (!confirm(t('blind_offConfirm'))) {
            // キャンセルされたら元の状態に戻す
            dom.keyToggleInput.checked = false;
            return;
        }

        try {
            showLoading(true);

            // 1. 先にデータ取得を成功させる（失敗してもまだ何も変更していない）
            const refs = await getReferencesWithAllDecisions(state.spreadsheetId, state.userEmail);

            // 2. 取得成功後に永続化
            await setKeyOpenedStatus(state.spreadsheetId, true);
            // 監査ログ（ベストエフォート。失敗してもキー切替自体は成功扱いのまま進める）
            await logAuditEvent(state.spreadsheetId, {
                event_type: 'key_opened',
                actor: state.userEmail,
                occurred_at: new Date().toISOString(),
                client_version: getClientVersion('-human'),
            });

            // 3. ローカル状態を確定
            state.clearReviewHistory();
            syncSetIsKeyOpened(true);
            syncSetReferences(refs);
            // 上と同じ理由。開封直後にフルテキストの結果ビューを開くと、更新しない限り
            // ブラインド中のスナップショット（自分の判定だけ）で不一致0件と表示されてしまう。
            state.setAllReferences(refs);

            // レビュアーを抽出
            const reviewers = new Set<string>();
            refs.forEach(ref => {
                if (ref.allDecisions) {
                    ref.allDecisions.forEach(d => {
                        const reviewerKey = getReviewerKey(d);
                        if (reviewerKey) reviewers.add(reviewerKey);
                    });
                }
            });
            if (state.userEmail) {
                reviewers.add(state.userEmail);
            }
            // Store経由で両方に同期
            syncSetAvailableReviewers(reviewers);
            syncSetEnabledReviewers(new Set(reviewers));

            // 表示を更新
            renderKeyStatus();
            renderReviewerFilter();
            renderAiHighlightToggle();
            renderConsensusModeToggle();  // キー開封中のみ合議モードトグルを表示
            syncSetCurrentIndex(0);
            syncSetCurrentFilter('pending');
            dom.statusFilter.value = 'pending';
            if (_renderCurrentReference) _renderCurrentReference();

            // 別ウィンドウで開いているPDF判定画面（fulltext.ts）が古いキー状態のまま
            // 他レビュアーの判定を出し続けるのを防ぐため、キー状態の変更を通知する。
            // 受信側がいなくてもエラーにならない fire-and-forget。
            platform().emitMessage({ type: 'blind:key-changed', spreadsheetId: state.spreadsheetId, keyOpened: true });

            showToast(t('blind_offSuccess'));
        } catch (error) {
            console.error('Key open error:', error);
            alert(buildKeyToggleErrorMessage('blind_offError', error));
            // エラー時は元の状態に戻す（永続化・状態変更はまだ行っていないため、これだけで整合する）
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

    // screeningタブがアクティブでない場合は処理しない（ML/AIタブでは各自のハンドラを使用）
    if (state.currentTab !== 'screening') {
        return;
    }

    // 修飾キーなし
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        // レビュー基準モーダルは「開いて、しばらく読む」常設UIのため、読んでいる最中の打鍵が
        // 判定として記録され、追記専用のDecisionsタブに誤った履歴として残ってしまう事故が起きやすい。
        // モーダル表示中は開閉キー（c / Escape）以外はすべて無視する。
        // 編集モード中は c / Escape も受け付けない（未保存の入力が無言で消えるのを防ぐ）。
        if (isCriteriaModalOpen()) {
            if (isCriteriaEditMode()) return;
            if (e.key.toLowerCase() === 'c') {
                toggleReviewCriteriaModal();
                e.preventDefault();
            } else if (e.key === 'Escape') {
                closeReviewCriteriaModal();
                e.preventDefault();
            }
            return;
        }

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
            case 'c': // レビュー基準モーダルの開閉トグル
                toggleReviewCriteriaModal();
                e.preventDefault();
                break;
        }
    }
}
