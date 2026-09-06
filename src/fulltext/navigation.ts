// navigation.ts - 候補計算・前後移動・進捗・キーボード操作を担う。
// 文献切替時に判定・文書・各パネルの表示を順番に接続する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { t } from '../lib/i18n';
import { explainEmptyFulltextCandidates } from '../lib/fulltext-empty-reason';
import { isFulltextCandidateRef } from '../lib/fulltext-candidates';
import { canSeeFulltextRef, matchesSelectedFulltextSets } from '../lib/fulltext-assignment';
import type { Decision } from '../lib/types';
import { session } from './session';
import { showPlaceholder, updateToolbarMode } from './document-view';
import {
    findMyFulltextDecision,
    renderDecisionPanel,
    isDecided,
    handleReasonKeydown,
    isReasonHotkey,
    selectReasonByIndex,
    chooseDecision,
} from './decision-controller';
import { clearAiHighlights, jumpToEvidence } from './evidence-controller';
import { renderBiblio, renderContextPanel, isCriteriaModalOpen, toggleCriteriaModal, closeCriteriaModal } from './page-panels';
import { prefetchNeighbors, showPdfForRef } from './document-loader';
import { showFeedback } from './page-helpers';

/**
 * 指定した文献を「ページ内で」表示する。
 * ページ全体をリロードせずに状態とUIだけを差し替えることで、
 * ナビゲーションのたびに Sheets を再取得するコストと描画のちらつきを無くす。
 */
export async function loadRef(refId: string): Promise<void> {
    const ref = session.allRefs.find(r => r.ref_id === refId) ?? null;
    if (!ref) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }
    const token = ++session.loadToken;
    session.currentRef = ref;
    session.currentCandidateIndex = session.fulltextCandidates.findIndex(r => r.ref_id === refId);

    // URL を現在の文献へ同期（リロード・ブックマーク・保存時の source_url 用）
    const url = new URL(window.location.href);
    url.searchParams.set('ref_id', refId);
    history.replaceState(null, '', url.toString());

    // この文献の既存フルテキスト判定を復元
    session.existingDecision = findMyFulltextDecision(refId);
    session.pendingDecision = session.existingDecision
        ? (session.existingDecision.decision.decision as 'include' | 'exclude' | 'maybe')
        : null;

    // 直前のフィードバックやフォーカスを片付け（i/e/m が効くよう body にフォーカスを戻す）
    document.getElementById('ft-feedback')?.remove();
    (document.activeElement as HTMLElement | null)?.blur?.();

    // 前の文献のAI判定ハイライト・根拠カードを消す。
    // applyHighlightsForCurrentRef は PDF.js 描画経路でしか呼ばれないため、
    // リンクのみ表示・論文ページ埋め込み・プレビュー等の経路では一覧が前の文献のまま残る。
    // ここで毎回リセットし、当該文献にAI判定が無ければ空表示にする。
    clearAiHighlights();

    renderBiblio(ref);
    renderContextPanel(ref);
    renderProgress();
    renderOverallProgress();
    renderDecisionPanel();
    updateToolbarMode();

    // 隣接候補のPDFを先読み（現在文献は前回のうちに先読み済みなら即表示できる）
    prefetchNeighbors();

    // PDF 表示
    await showPdfForRef(ref, token);
}

// ---------------------------------------------------------------------------
// フルテキスト候補ルール
// ---------------------------------------------------------------------------

/**
 * 候補リストを再計算する（判定は isFulltextCandidateRef に委譲。詳細は fulltext-candidates.ts 参照）
 * - 割り振り設定済み: fulltext_set が非空の文献 ∪ ルール評価で候補入りする未割り当て流入分
 * - 未設定:
 *   - ルール設定済み: 採用voterのInclude票が必要票数以上の文献
 *   - ルール未設定:
 *     - 管理者: 読み込まれている全レビュアーの TiAb Include が1件でもある文献
 *     - 非管理者: 自分が TiAb で Include した文献
 */
export function recomputeCandidates(): void {
    const byRef = new Map<string, Decision[]>();
    for (const d of session.allDecisions) {
        const list = byRef.get(d.ref_id);
        if (list) {
            list.push(d);
        } else {
            byRef.set(d.ref_id, [d]);
        }
    }

    session.fulltextCandidates = session.allRefs.filter(r => isFulltextCandidateRef({
        ref: r,
        decisions: byRef.get(r.ref_id) ?? [],
        poolRule: session.poolRule,
        assignment: session.ftAssignment,
        userEmail: session.userEmail,
        isAdmin: session.isAdmin,
    }));

    // 担当割り振り設定済みなら自分の担当分（+未割り当て）へ絞り込む。管理者は全候補。
    session.fulltextCandidates = session.fulltextCandidates.filter(r =>
        canSeeFulltextRef(r, session.ftAssignment, session.userEmail, session.isAdmin)
    );
    session.candidateCountBeforeSetFilter = session.fulltextCandidates.length;

    // サイドパネルの担当セットフィルタ選択（チェックボックス絞り込み）を反映する
    session.fulltextCandidates = session.fulltextCandidates.filter(r =>
        matchesSelectedFulltextSets(r, session.ftAssignment, session.selectedFulltextSets)
    );

    session.currentCandidateIndex = session.currentRef
        ? session.fulltextCandidates.findIndex(r => r.ref_id === session.currentRef!.ref_id)
        : -1;
}

/** 次の候補へ進む（末尾なら留まって通知）。判定後の自動送りに使う。 */
export function advanceToNext(): void {
    if (session.currentCandidateIndex < 0) return;
    // 全候補が判定済みになったら、完了を通知してタブを閉じ元の画面へ戻る。
    // 判定アクション後にしか通らないので、全件判定済みの状態で
    // 開き直しただけでは発火しない（見直しはできる）。
    if (session.fulltextCandidates.length > 0 && session.fulltextCandidates.every(r => isDecided(r.ref_id))) {
        startAutoClose();
        return;
    }
    if (session.currentCandidateIndex >= session.fulltextCandidates.length - 1) {
        showFeedback('最後の候補です');
        return;
    }
    void loadRef(session.fulltextCandidates[session.currentCandidateIndex + 1].ref_id);
}

// ---------------------------------------------------------------------------
// ナビゲーション
// ---------------------------------------------------------------------------

export function wireNavButtons(): void {
    document.getElementById('ft-prev-btn')?.addEventListener('click', () => navigate(-1));
    document.getElementById('ft-next-btn')?.addEventListener('click', () => navigate(1));
    document.getElementById('ft-next-undecided-btn')?.addEventListener('click', () => jumpToNextUndecided());
    document.getElementById('ft-close-btn')?.addEventListener('click', () => closeTab());
}

/** このタブを閉じて元の画面に戻る。chrome.tabs.create で開かれたタブは
 *  window.close() が効かないことがあるため chrome.tabs API を優先する。 */
function closeTab(): void {
    chrome.tabs.getCurrent(tab => {
        if (tab?.id !== undefined) {
            chrome.tabs.remove(tab.id);
        } else {
            window.close();
        }
    });
}

/**
 * 全件判定完了を通知し、少し待ってからタブを閉じる。
 * 猶予中にキー入力・クリックがあれば自動クローズをキャンセルする
 * （直前の判定を見直したい場合の逃げ道）。
 */
function startAutoClose(): void {
    if (session.autoCloseTimer !== undefined) return;
    showFeedback('全件の判定が完了しました 🎉 まもなくタブを閉じます（操作でキャンセル）');
    const ac = new AbortController();
    const cancel = (): void => {
        ac.abort();
        if (session.autoCloseTimer === undefined) return;
        clearTimeout(session.autoCloseTimer);
        session.autoCloseTimer = undefined;
        showFeedback('自動クローズをキャンセルしました');
    };
    window.addEventListener('keydown', cancel, { capture: true, signal: ac.signal });
    window.addEventListener('pointerdown', cancel, { capture: true, signal: ac.signal });
    session.autoCloseTimer = window.setTimeout(() => closeTab(), 2000);
}

function navigate(delta: number): void {
    if (session.fulltextCandidates.length === 0) return;
    const len = session.fulltextCandidates.length;
    const newIndex = (session.currentCandidateIndex + delta + len) % len;
    const nextRef = session.fulltextCandidates[newIndex];
    if (nextRef) void loadRef(nextRef.ref_id);
}

/**
 * 次の未判定候補へジャンプする（u キー＋ボタン）。
 * 現在位置から末尾方向へ探し、末尾まで無ければ先頭へ折り返す。
 * 中断後の再開や、飛ばした文献の拾い直しを高速化する。
 */
function jumpToNextUndecided(): void {
    const len = session.fulltextCandidates.length;
    if (len === 0) return;
    const start = session.currentCandidateIndex >= 0 ? session.currentCandidateIndex : -1;
    for (let d = 1; d <= len; d++) {
        const ref = session.fulltextCandidates[(start + d + len) % len];
        if (ref && ref.ref_id !== session.currentRef?.ref_id && !isDecided(ref.ref_id)) {
            void loadRef(ref.ref_id);
            return;
        }
    }
    showFeedback('未判定の候補はありません');
}

// ---------------------------------------------------------------------------
// キーボードショートカット（TiAbレビューと同一割り当て）
// ---------------------------------------------------------------------------

export function handleKeydown(e: KeyboardEvent): void {
    // 除外理由 select にフォーカスがある時は専用処理（数字で確定・↑↓でネイティブ移動・Enterで次へ）
    const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    if (reasonSelect && e.target === reasonSelect) {
        handleReasonKeydown(e, reasonSelect);
        return;
    }

    // その他の入力フォーム内では無効
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement) {
        return;
    }
    // 修飾キー併用時は無効
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    // レビュー基準モーダルは「開いて、しばらく読む」常設UIのため、読んでいる最中の打鍵が
    // 判定として記録され、追記専用のDecisionsタブに誤った履歴として残ってしまう事故が起きやすい。
    // モーダル表示中は開閉キー（c / Escape）以外はすべて無視する（数字キーによる除外理由確定より前）。
    if (isCriteriaModalOpen()) {
        if (e.key.toLowerCase() === 'c') {
            toggleCriteriaModal();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            closeCriteriaModal();
            e.preventDefault();
        }
        return;
    }

    // 除外モード中は（selectからフォーカスが外れていても）数字キーで理由を選べる
    if (session.pendingDecision === 'exclude' && isReasonHotkey(e.key)) {
        selectReasonByIndex(Number(e.key));
        e.preventDefault();
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'i': // Include
            void chooseDecision('include');
            e.preventDefault();
            break;
        case 'e': // Exclude
            void chooseDecision('exclude');
            e.preventDefault();
            break;
        case 'm': // Maybe
        case '?':
            void chooseDecision('maybe');
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
        case 'u': // 次の未判定候補へ
            jumpToNextUndecided();
            e.preventDefault();
            break;
        case 'n': // 次の evidence へ（カード強調＋PDFスクロール連動）
            jumpToEvidence(1);
            e.preventDefault();
            break;
        case 'p': // 前の evidence へ
            jumpToEvidence(-1);
            e.preventDefault();
            break;
        case 'c': // レビュー基準（組入・除外基準）の表示/非表示
            toggleCriteriaModal();
            e.preventDefault();
            break;
        // Escape はモーダルが開いている間だけ意味を持つため、上のガードで処理済み
        // （ここに到達する時点でモーダルは閉じているので、switch側では何もしない）
    }
}

export function renderProgress(): void {
    const el = document.getElementById('ft-progress');
    if (!el) return;
    if (session.fulltextCandidates.length === 0) {
        el.textContent = describeEmptyCandidatesReason();
        return;
    }
    if (session.currentCandidateIndex === -1) {
        // この文献は現在の候補条件に含まれていない（判定・保存は可能）
        el.textContent = `候補外（候補 ${session.fulltextCandidates.length}件）`;
        return;
    }
    el.textContent = `${session.currentCandidateIndex + 1} / ${session.fulltextCandidates.length}`;
}

/**
 * 候補0件の理由に応じたメッセージを返す（サイドパネルの空状態と同じ判定関数を使う）。
 * Blind中に他レビュアーの人間票が読み込まれず候補ルールが評価できない場合、
 * 従来は無表示で「まだTiAbが終わっていない」と誤認させていた（実際に混乱が起きた）。
 * このウィンドウにはBlind解除ボタンを置く導線が無いため、管理者にはサイドパネルへの誘導文言を出す。
 */
function describeEmptyCandidatesReason(): string {
    const assignedSetCount = session.allRefs.filter(r => (r.fulltext_set || '').trim() !== '').length;
    const reason = explainEmptyFulltextCandidates({
        poolRule: session.poolRule,
        keyOpened: session.keyOpened,
        userEmail: session.userEmail,
        assignedSetCount,
        candidateCountBeforeSetFilter: session.candidateCountBeforeSetFilter,
        visibleCandidateCount: session.fulltextCandidates.length,
    });
    switch (reason) {
        case 'rule_unevaluable_blind':
            return session.isAdmin
                ? t('fulltext_emptyBlindUnevaluableFulltextWindow')
                : t('fulltext_emptyBlindUnevaluable');
        case 'assignment_mismatch':
            return t('fulltext_emptyAssignmentMismatch', String(assignedSetCount));
        case 'filtered_out':
            return t('fulltext_emptyFilteredOut');
        default:
            // 従来どおり: 本当に候補が無いだけの場合はヘッダーに何も出さない
            return '';
    }
}

/** 候補プール全体で自分の判定がどれだけ終わったかを表示する */
export function renderOverallProgress(): void {
    const text = document.getElementById('ft-overall-text');
    const fill = document.getElementById('ft-overall-fill');
    if (!text && !fill) return;
    const total = session.fulltextCandidates.length;
    const decided = session.fulltextCandidates.filter(r => isDecided(r.ref_id)).length;
    const pct = total > 0 ? Math.round((decided / total) * 100) : 0;
    if (text) text.textContent = total > 0 ? `判定済 ${decided}/${total} (${pct}%)` : '';
    if (fill) fill.style.width = `${pct}%`;
}
