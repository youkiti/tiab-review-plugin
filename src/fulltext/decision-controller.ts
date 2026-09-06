// decision-controller.ts - 判定・理由・保存・AIサマリ・他者票の表示を担う。
// 根拠表示へ依存し、次候補への移動と進捗描画は初期化時に注入する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { saveDecision } from '../lib/sheets-api';
import { platform } from '../platform';
import { getClientVersion } from '../lib/client-version';
import { buildDecisionContext } from '../lib/decision-context';
import { excludeReasonLabel, MAX_REASON_HOTKEYS } from '../lib/exclude-reasons';
import { isTiabDecision } from '../lib/fulltext-pool';
import { isAdjudicationKey } from '../lib/fulltext-consensus';
import { selectOtherFulltextDecisions, otherReviewerLabel } from '../lib/fulltext-other-decisions';
import { isImeComposing } from '../lib/ime-composition';
import type { Decision } from '../lib/types';
import { session, effectiveEvidenceLevel } from './session';
import { refreshEvidenceDisplay, findAiFulltext, countActiveRoundAiVotesForRef } from './evidence-controller';
import { showFeedback } from './page-helpers';

interface Dependencies {
    advanceToNext: () => void;
    renderOverallProgress: () => void;
}

let deps: Dependencies | null = null;

export function setDecisionControllerDependencies(dependencies: Dependencies): void {
    deps = dependencies;
}

function getDependencies(): Dependencies {
    if (!deps) throw new Error('decision-controller の依存が設定されていません');
    return deps;
}

/** 現在のユーザーによるこの文献のフルテキスト判定（最新）を返す */
export function findMyFulltextDecision(refId: string): { decision: Decision; rowIndex: number } | null {
    const mine = session.allDecisions
        .filter(d =>
            d.ref_id === refId &&
            d.reviewer_id === session.userEmail &&
            (d.screening_phase ?? 'tiab') === 'fulltext'
        )
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));
    return mine.length > 0 ? { decision: mine[0], rowIndex: -1 } : null;
}

/** この文献に（pending 以外の）自分のフルテキスト判定があるか */
export function isDecided(refId: string): boolean {
    const d = findMyFulltextDecision(refId);
    return !!d && d.decision.decision !== 'pending';
}

// ---------------------------------------------------------------------------
// 決断パネル
// ---------------------------------------------------------------------------

export function renderDecisionPanel(): void {
    // AI判定サマリ（あれば）を提示。人間の判定は別票のためプリフィルはしない。
    renderAiSummary();
    // 現在の決断状態をボタンに反映
    updateDecisionButtons();
    // 除外理由エリアの表示制御
    updateReasonArea();
    // 保存ボタンの表示
    updateSaveButton();
}

export const AI_DECISION_LABELS: Record<string, string> = {
    include: '組み入れ',
    exclude: '除外',
    maybe: '保留',
    // AI判定には出ないが、自分のTiAb判定・他レビュアーの判定の表示で使う
    pending: '未判定',
};

/**
 * AI判定の開示トグル（管理者のみ）。
 * AI判定はブラインド情報なので、非管理者には出さず、管理者にだけ表示/非表示ボタンを出す。
 */
export function setupAiRevealToggle(): void {
    if (!session.isAdmin) return;
    const title = document.querySelector('.ft-annotations-panel .ft-panel-title');
    if (!title || document.getElementById('ft-ai-reveal-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ft-ai-reveal-btn';
    btn.className = 'ft-ai-reveal-btn';
    btn.addEventListener('click', () => {
        session.aiReveal = !session.aiReveal;
        syncAiRevealButton();
        renderAiSummary();
        // 開示状態で evidence の表示レベル（色分け・polarityラベル）も変わるため再描画する
        refreshEvidenceDisplay();
    });
    title.appendChild(btn);
    syncAiRevealButton();
}

export function syncAiRevealButton(): void {
    const btn = document.getElementById('ft-ai-reveal-btn');
    if (!btn) return;
    btn.textContent = session.aiReveal ? 'AI判断: 表示中' : 'AI判断: 非表示';
    btn.title = 'AIの組入/除外の判断とその理由の表示を切り替えます（管理者のみ）';
    btn.classList.toggle('active', session.aiReveal);
}

/**
 * AIフルテキスト判定のサマリを決断パネル上部に表示する。
 * 人間レビュアーが「AIが何をどう判定したか」を一目で確認できるようにする（票自体は別管理）。
 * ブラインド情報のため、開示が許可（aiReveal）されている時のみ表示する。
 */
function renderAiSummary(): void {
    const panel = document.querySelector('.ft-decision-panel');
    if (!panel) return;
    let banner = document.getElementById('ft-ai-summary');

    const ai = session.aiReveal && session.currentRef ? findAiFulltext(session.currentRef.ref_id) : null;
    if (!ai) {
        banner?.remove();
        return;
    }
    const { decision, note } = ai;

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ft-ai-summary';
        banner.className = 'ft-ai-summary';
        const title = panel.querySelector('.ft-panel-title');
        if (title) title.insertAdjacentElement('afterend', banner);
        else panel.prepend(banner);
    }

    const decLabel = AI_DECISION_LABELS[decision.decision] ?? decision.decision;
    const pct = Math.round((note.include_probability ?? 0) * 100);
    const reasonCat = note.exclude_reason_category
        ? `（${excludeReasonLabel(note.exclude_reason_category, session.excludeReasonItems)}）`
        : '';

    banner.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ft-ai-summary-head';
    head.textContent = `AI判定: ${decLabel}${reasonCat} ・ 組入確率 ${pct}%`;
    // 数字＋小バーの併記で、maybe（50%前後）と高確信判定を一目で区別できるようにする
    const bar = document.createElement('span');
    bar.className = 'ft-ai-prob-bar';
    bar.title = `組入確率 ${pct}%`;
    const fill = document.createElement('span');
    fill.className = 'ft-ai-prob-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    head.appendChild(bar);
    banner.appendChild(head);

    if (note.reason) {
        const reason = document.createElement('div');
        reason.className = 'ft-ai-summary-reason';
        reason.textContent = note.reason;
        banner.appendChild(reason);
    }
}

export function wireDecisionButtons(): void {
    document.getElementById('ft-btn-include')?.addEventListener('click', () => { void chooseDecision('include'); });
    document.getElementById('ft-btn-exclude')?.addEventListener('click', () => { void chooseDecision('exclude'); });
    document.getElementById('ft-btn-maybe')?.addEventListener('click', () => { void chooseDecision('maybe'); });
    document.getElementById('ft-save-btn')?.addEventListener('click', () => { void handleSave(); });

    // 除外理由の確定はモダリティで挙動を分ける：
    // - クリック（ポインタ）で選択: 確定とみなし、保存して次の候補へ進む
    // - ↑↓キーでのブラウズ: その場で保存のみ（Enter/数字キーで次へ）
    // 新規除外は理由が選ばれてから初めて保存する。
    const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    reasonSelect?.addEventListener('change', () => {
        if (session.pendingDecision !== 'exclude') return;
        if (session.reasonPointerDown) {
            // クリック選択。確定処理（保存＋次へ）は pointerup 側で行う
            session.reasonChangedByPointer = true;
            return;
        }
        void handleSave();
    });
    reasonSelect?.addEventListener('pointerdown', () => {
        session.reasonPointerDown = true;
        session.reasonChangedByPointer = false;
    });
    // select の外で離した場合も拾えるよう window で監視する
    window.addEventListener('pointerup', (e) => {
        if (!session.reasonPointerDown) return;
        session.reasonPointerDown = false;
        if (session.pendingDecision !== 'exclude' || !reasonSelect?.value) return;
        if (e.target instanceof Node && reasonSelect.contains(e.target)) {
            // select 上で離した＝クリック確定。保存して次の候補へ。
            // 選択済みの理由をもう一度クリックした場合も確定として扱う。
            void commitReasonAndAdvance();
        } else if (session.reasonChangedByPointer) {
            // select の外で離した（クリック取り消し）。選択表示は変わっているため
            // 保存だけ行い、次へは進まない。
            void handleSave();
        }
    });
    window.addEventListener('pointercancel', () => {
        if (!session.reasonPointerDown) return;
        session.reasonPointerDown = false;
        if (session.pendingDecision === 'exclude' && session.reasonChangedByPointer && reasonSelect?.value) {
            void handleSave();
        }
    });
    // メモの変更は、その場で再保存する（自動送りはしない）。
    document.getElementById('ft-reason-note')?.addEventListener('change', () => {
        if (session.pendingDecision === 'exclude') {
            const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
            if (select?.value) void handleSave();
        } else if (session.pendingDecision) {
            void handleSave();
        }
    });

    // メモ欄で Enter（改行は Shift+Enter）: メモ込みで保存して次の候補へ。
    // 保留メモの「任意入力 → Enter で次へ」フローに使う（除外でも同様に効く）。
    //
    // 日本語入力では変換の確定にも Enter を使うため、変換中の Enter を拾うと
    // メモを書いている途中で次の文献へ飛んでしまう。IME 変換中は必ず読み飛ばし、
    // 変換が確定したあとにもう一度押された Enter だけを「次へ」として扱う。
    const noteEl = document.getElementById('ft-reason-note');
    // isComposing を立てない IME への保険として、変換状態を自前でも追跡する
    let noteComposing = false;
    noteEl?.addEventListener('compositionstart', () => { noteComposing = true; });
    noteEl?.addEventListener('compositionend', () => { noteComposing = false; });
    // blur 時に compositionend が来ないケースでも状態が残らないようにする
    noteEl?.addEventListener('blur', () => { noteComposing = false; });
    noteEl?.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (isImeComposing(e, noteComposing)) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void commitNoteAndAdvance();
        } else if (e.key === 'Escape') {
            (e.target as HTMLElement).blur();
            e.preventDefault();
        }
    });
}

/** メモ欄の Enter 確定: 保存して次の候補へ（除外は理由未選択なら保存しない） */
async function commitNoteAndAdvance(): Promise<void> {
    if (!session.pendingDecision) return;
    if (session.pendingDecision === 'exclude') {
        const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        if (!select?.value) {
            showFeedback('除外理由を選択してください', true);
            focusReasonSelect();
            return;
        }
    }
    const saved = await handleSave();
    if (saved) getDependencies().advanceToNext();
}

/**
 * 判定を選択して即保存する（TiAbレビューと同じ即保存挙動）。
 * - 組み入れ: 保存してそのまま次の候補へ進む
 * - 除外: 理由エリアを表示・フォーカスし、理由が確定（クリック/数字キー/Enter）したら次へ進む
 * - 保留: 即保存しつつメモ欄（任意）を表示。第2レビュアー・adjudication で
 *   「何が判断できなかったか」を共有できるようにする。Enter で次へ進む。
 */
export async function chooseDecision(decision: 'include' | 'exclude' | 'maybe'): Promise<void> {
    session.pendingDecision = decision;
    renderDecisionPanel();

    if (decision === 'exclude') {
        focusReasonSelect();     // キーボードで理由を選べるようフォーカス
        showFeedback('除外理由を選択すると保存して次の候補へ進みます');
        return;                  // 理由確定で保存して advanceToNext する
    }

    if (decision === 'maybe') {
        const saved = await handleSave();
        if (saved) {
            showFeedback('保存しました。判断できなかった点をメモできます（Enterで次へ）');
            focusReasonNote();
        }
        return;                  // Enter（またはボタン/キーで次へ）で advanceToNext する
    }

    const saved = await handleSave();
    if (saved) getDependencies().advanceToNext();   // 組み入れは保存できたら次の候補へ
}

/** 除外理由 select にフォーカスを移す（表示中のときだけ） */
function focusReasonSelect(): void {
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const area = document.getElementById('ft-reason-area');
    if (select && area && !area.classList.contains('hidden')) {
        select.focus();
    }
}

/** メモ欄（textarea）にフォーカスを移す（表示中のときだけ）。保留メモの入力導線。 */
function focusReasonNote(): void {
    const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
    const area = document.getElementById('ft-reason-area');
    if (note && area && !area.classList.contains('hidden')) {
        note.focus();
    }
}

/**
 * 除外理由の <select> をプロジェクト設定（excludeReasonItems）から描画する。
 * fulltext.html 側は空の <select> だけを持ち、選択肢はここでのみ組み立てる
 * （並び＝優先順位・数字キーの割り当ても同じ配列から導く）。
 */
export function renderReasonOptions(): void {
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    if (!select) return;

    select.innerHTML = '';
    session.excludeReasonItems.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = item.key;
        // フォールバック理由（fallbackExcludeReasonKey）は常に末尾の項目なので、
        // 末尾の項目にだけ「1〜n が当てはまらない場合」の補足を付ける
        // （'other' というキー名では判定しない。カスタム理由には無いか、あっても末尾とは限らない）
        const isFallback = idx === session.excludeReasonItems.length - 1 && idx > 0;
        const suffix = isFallback ? `（1〜${idx}が当てはまらない場合）` : '';
        opt.textContent = `${idx + 1}. ${item.label}${suffix}`;
        select.appendChild(opt);
    });
    // size は項目数に追随させる（スクロールせず全選択肢が見える状態を保つ。増えすぎたら打ち切る）
    select.size = Math.min(10, Math.max(2, session.excludeReasonItems.length));
    select.selectedIndex = -1;

    const hint = document.querySelector('.ft-reason-hint');
    if (hint) {
        hint.textContent = `クリックまたは数字 1〜${hotkeyCount()} で確定して次へ ／ ↑↓ で移動・Enter で確定`;
    }
}

/** 数字キーを割り当てられる件数（1〜9まで。理由がそれ以上ならクリックで選ぶ） */
function hotkeyCount(): number {
    return Math.min(session.excludeReasonItems.length, MAX_REASON_HOTKEYS);
}

/** 押された数字キーが理由の選択に使えるか（理由の件数を超える数字は無視する） */
export function isReasonHotkey(key: string): boolean {
    if (!/^[1-9]$/.test(key)) return false;
    return Number(key) <= hotkeyCount();
}

/**
 * 数字キーで除外理由を選び、保存して次へ進む。
 * 除外理由の選択肢はプロジェクト設定（Config タブ fulltext_exclude_reasons）が唯一の定義。
 */
export function selectReasonByIndex(n: number): void {
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const value = session.excludeReasonItems[n - 1]?.key;
    if (!select || value === undefined) return;
    select.value = value;
    void commitReasonAndAdvance();
}

/** 除外理由を確定して保存し、次の候補へ進む */
async function commitReasonAndAdvance(): Promise<void> {
    if (session.pendingDecision !== 'exclude') return;
    const saved = await handleSave();
    if (saved) getDependencies().advanceToNext();
}

function updateDecisionButtons(): void {
    const states: Array<['include' | 'exclude' | 'maybe', string]> = [
        ['include', 'ft-btn-include'],
        ['exclude', 'ft-btn-exclude'],
        ['maybe', 'ft-btn-maybe'],
    ];
    for (const [val, id] of states) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        if (session.pendingDecision === val) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }
}

function updateReasonArea(): void {
    const area = document.getElementById('ft-reason-area');
    if (!area) return;
    const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
    const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
    const selectLabel = area.querySelector('.ft-reason-label') as HTMLElement | null;
    const hint = area.querySelector('.ft-reason-hint') as HTMLElement | null;

    // メモ欄は非表示中でも handleSave が値を参照するため、判定種によらず
    // 「同じ判定種の既存メモ」を復元し、それ以外はクリアする。
    // （旧実装は exclude 以外で復元もクリアもせず、include/maybe＋note の既存判定を
    //   開いてもメモが見えない・前の文献のメモが残って保存される問題があった）
    if (note) {
        note.value = session.pendingDecision && session.existingDecision?.decision.decision === session.pendingDecision
            ? session.existingDecision.decision.note ?? ''
            : '';
    }

    if (session.pendingDecision === 'exclude' || session.pendingDecision === 'maybe') {
        area.classList.remove('hidden');
        const excludeMode = session.pendingDecision === 'exclude';
        // 保留（maybe）ではPRISMA理由の選択は不要。メモ欄のみ出す。
        selectLabel?.classList.toggle('hidden', !excludeMode);
        select?.classList.toggle('hidden', !excludeMode);
        hint?.classList.toggle('hidden', !excludeMode);
        if (note) {
            note.placeholder = excludeMode
                ? '補足メモ（任意・Enterで保存して次へ／Shift+Enterで改行）'
                : '判断できなかった点のメモ（任意・Enterで保存して次へ／Shift+Enterで改行）';
        }
        // 既存の除外理由を復元
        if (select) {
            if (excludeMode && session.existingDecision?.decision.decision === 'exclude' && session.existingDecision.decision.reason) {
                select.value = session.existingDecision.decision.reason;
            } else {
                select.selectedIndex = -1;
            }
        }
    } else {
        area.classList.add('hidden');
    }
}

function updateSaveButton(): void {
    // 判定は即保存されるため保存ボタンは常に非表示
    const btn = document.getElementById('ft-save-btn');
    btn?.classList.add('hidden');
}

async function handleSave(): Promise<boolean> {
    if (!session.currentRef || !session.pendingDecision) return false;

    const saveBtn = document.getElementById('ft-save-btn') as HTMLButtonElement | null;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        const reasonNote = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
        const reason = reasonSelect?.value || '';

        if (session.pendingDecision === 'exclude' && !reason) {
            showFeedback('除外理由を選択してください', true);
            focusReasonSelect();
            return false;
        }

        // decision_id は判定イベントごとに毎回新規発番する（Decisionsタブが追記専用になったため、
        // 既存判定のIDを使い回すと判定変更の履歴が別イベントとして残らなくなる）
        const decisionObj: Decision = {
            decision_id: crypto.randomUUID(),
            ref_id: session.currentRef.ref_id,
            reviewer_id: session.userEmail,
            decision: session.pendingDecision,
            reason: session.pendingDecision === 'exclude' ? reason : undefined,
            note: reasonNote?.value || undefined,
            decided_at: new Date().toISOString(),
            client_version: getClientVersion('-human'),
            source_url: window.location.href,
            screening_phase: 'fulltext',
            context_json: buildDecisionContext({
                keyOpened: session.keyOpened,
                aiEvidenceLevel: effectiveEvidenceLevel(),
                aiVotesAtDecision: countActiveRoundAiVotesForRef(session.currentRef.ref_id),
            }),
        };

        // 送信前にメモリ状態を確定させる。decision_id は追記専用化により毎回新規発番されるため、
        // (ref_id, reviewer_id, screening_phase) が一致する既存要素を探して置換することで、
        // メモリ上の allDecisions に同一判定の重複が積まれるのを防ぐ。
        if (session.existingDecision) {
            session.existingDecision.decision = decisionObj;
        } else {
            session.existingDecision = { decision: decisionObj, rowIndex: -1 };
        }
        const idx = session.allDecisions.findIndex(d =>
            d.ref_id === decisionObj.ref_id &&
            d.reviewer_id === decisionObj.reviewer_id &&
            (d.screening_phase ?? 'tiab') === (decisionObj.screening_phase ?? 'tiab')
        );
        if (idx >= 0) session.allDecisions[idx] = decisionObj;
        else session.allDecisions.push(decisionObj);
        getDependencies().renderOverallProgress();

        await saveDecision(session.spreadsheetId, decisionObj);

        // サイドパネルのチーム進捗パネルへ即時反映を通知
        // （サイドパネルが閉じていて受信側がいなくてもエラーにしない）
        platform().emitMessage({ type: 'team-progress:decision-saved', spreadsheetId: session.spreadsheetId, decision: decisionObj });

        showFeedback('保存しました');
        return true;
    } catch (err) {
        showFeedback(`保存失敗: ${(err as Error).message}`, true);
        return false;
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    }
}

/**
 * 除外理由 select にフォーカスがある時のキー処理。
 * - 数字キー: その理由を選んで保存し、次の候補へ（割り当ては先頭9件まで）
 * - ↑↓: ネイティブの select で理由を上下移動（change で随時保存。まだ次へは進まない）
 * - Enter: 選択中の理由を確定して次の候補へ
 * - Escape: select からフォーカスを外す
 */
export function handleReasonKeydown(e: KeyboardEvent, select: HTMLSelectElement): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isReasonHotkey(e.key)) {
        selectReasonByIndex(Number(e.key));
        e.preventDefault();
        return;
    }
    if (e.key === 'Enter') {
        if (select.value) void commitReasonAndAdvance();
        e.preventDefault();
        return;
    }
    if (e.key === 'Escape') {
        select.blur();
        e.preventDefault();
    }
    // ArrowUp / ArrowDown はネイティブ select に委ねる（change ハンドラで保存される）
}

/** 現在のユーザーによるこの文献のTiAb判定（最新）を返す */
export function findMyTiabDecision(refId: string): Decision | null {
    const mine = session.allDecisions
        .filter(d => d.ref_id === refId && d.reviewer_id === session.userEmail && isTiabDecision(d))
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));
    return mine[0] ?? null;
}

/**
 * この文献に対する他レビュアーのフルテキスト判定（レビュアーごとに最新の1件）。
 * 選別・並び順・ブラインドの線引きは lib 側の純関数に委譲する（テストはそちらで書く）。
 */
export function findOtherFulltextDecisions(refId: string): Decision[] {
    return selectOtherFulltextDecisions(session.allDecisions, refId, session.userEmail, session.keyOpened);
}

/**
 * 他レビュアーのフルテキスト判定ブロックを組み立てる（Blind解除時のみ呼ぶ）。
 * 不一致の見直しでPDFを読み直すとき、相手の判定・除外理由・メモをこの画面で読めるようにする
 * （従来はサイドパネルの「不一致の解消」ビューへ戻らないと読めなかった）。
 */
export function buildOtherDecisionsBlock(others: Decision[]): HTMLElement {
    const block = document.createElement('div');
    block.className = 'ft-context-others';

    const head = document.createElement('div');
    head.className = 'ft-context-others-head';
    head.textContent = '他レビュアーのフルテキスト判定';
    block.appendChild(head);

    if (others.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ft-context-others-empty';
        empty.textContent = 'まだありません';
        block.appendChild(empty);
        return block;
    }

    for (const d of others) {
        const row = document.createElement('div');
        row.className = 'ft-context-other';
        row.dataset.decision = d.decision;

        const parts = [otherReviewerLabel(d.reviewer_id || '', session.userEmail), AI_DECISION_LABELS[d.decision] ?? d.decision];
        if (d.reason) parts.push(excludeReasonLabel(d.reason, session.excludeReasonItems));
        const rowHead = document.createElement('div');
        rowHead.className = 'ft-context-other-head';
        rowHead.textContent = parts.join(' · ');
        row.appendChild(rowHead);

        // 裁定票の note は裁定時点の票のスナップショット（JSON）なので本文としては出さない
        if (d.note && !isAdjudicationKey(d.reviewer_id || '')) {
            const note = document.createElement('div');
            note.className = 'ft-context-other-note';
            note.textContent = d.note;
            row.appendChild(note);
        }

        block.appendChild(row);
    }

    return block;
}
