// evidence-controller.ts - AI根拠のハイライト・カード一覧・ジャンプ・表示切替を担う。
// 状態と表示ヘルパーへ依存し、PDF取得処理へは依存しない。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { explainEmptyAiEvidence } from '../lib/ai-evidence-empty-reason';
import type { AiEvidenceEmptyReason } from '../lib/ai-evidence-empty-reason';
import type { Decision, FulltextLlmDecisionNote } from '../lib/types';
import type { HighlightCategory } from './pdf-renderer';
import { perfSpanSync } from '../lib/perf';
import { session, effectiveEvidenceLevel, HighlightListItem } from './session';
import { appendTextWithBreaks } from './page-helpers';

// ---------------------------------------------------------------------------
// ハイライト表示トグル（スクリーニング用ハイライトのON/OFF、デフォルトON）
// ---------------------------------------------------------------------------

export function wireHighlightToggle(): void {
    const checkbox = document.getElementById('ft-highlight-checkbox') as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = session.highlightEnabled;
    checkbox.addEventListener('change', () => {
        session.highlightEnabled = checkbox.checked;
        applyHighlightVisibility();
    });
    applyHighlightVisibility();
}

/**
 * PDF上のハイライトオーバーレイの表示をトグル状態に同期する。
 * 根拠カード一覧は制御しない（原文を読みたくてオーバーレイをOFFにしても、
 * カードから文脈を辿れるよう常に残す）。
 */
function applyHighlightVisibility(): void {
    // PDF.js 描画中はレンダラ側のハイライトレイヤーをまとめて制御する
    session.pdfRenderer?.setHighlightsVisible(session.highlightEnabled);
    document.querySelectorAll('.ft-highlight').forEach(el => {
        (el as HTMLElement).style.display = session.highlightEnabled ? '' : 'none';
    });
}

/**
 * 現在表示中PDFに対し、AIフルテキスト判定の evidence をハイライト描画し、
 * 右ペインのアノテーション一覧を再構築する。
 *
 * - 経路A（quote文字列マッチ）→ 経路B（bbox）の順で renderer が解決を試みる。
 * - どちらも解決できなかった evidence は「位置不明」として一覧に出し、
 *   クリックでページ送りのみ行う（縮退フォールバック）。
 */
/**
 * AI evidence ハイライト（canvas）と根拠カード一覧（右ペイン）を空にする。
 * 文献遷移のたびに呼び、前の文献のハイライトが残らないようにする。
 * AI判定のある cached PDF では、この後 applyHighlightsForCurrentRef が再構築する。
 */
export function clearAiHighlights(): void {
    session.pdfRenderer?.clearHighlights();
    // 空文言は文献に依存しない（ラウンドの状態のみで決まる）ため、
    // ここでも理由別メッセージを出しておき、遷移時に既定文言が一瞬見える状態を作らない
    renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
}

/**
 * 根拠一覧の空メッセージ（理由別）。
 * 'blinded'（表示レベル none）は、採用ラウンドの有無等で文言を変えると
 * 「AI判定が存在するか」が推測できてしまうため 'no_evidence' と同一文言に固定する。
 * Config の生キー名は出さず、UIから辿れる導線（サイドパネルのAI判定タブ）を案内する。
 */
const AI_EVIDENCE_EMPTY_MESSAGES: Record<AiEvidenceEmptyReason, string> = {
    blinded: 'このPDFのAI判定根拠はまだありません。',
    no_round:
        'フルテキストAI判定はまだ実行されていません。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」から一括AI判定を実行すると、ここに根拠ハイライトが表示されます'
        + '（TiAbのAI判定とは別枠です）。',
    round_not_adopted:
        'フルテキストAI判定はありますが、採用するラウンドが選ばれていません。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」→「判定ラウンド」で選択してください。',
    adopted_round_missing:
        '採用中のAI判定ラウンドの判定が見つかりません（削除された可能性があります）。\n'
        + 'サイドパネルの「フルテキスト」→「AI判定」→「判定ラウンド」で選び直してください。',
    no_evidence: 'このPDFのAI判定根拠はまだありません。',
};

/** 状態に応じた根拠一覧の空メッセージ */
function evidenceEmptyMessage(): string {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: effectiveEvidenceLevel(),
        hasAnyFulltextAiDecision: session.allDecisions.some(isFulltextAiDecision),
        hasAdoptedRoundDecision: !!session.aiActiveRound
            && session.allDecisions.some(d => isFulltextAiDecision(d) && d.reviewer_id === session.aiActiveRound),
        activeRound: session.aiActiveRound,
    });
    return AI_EVIDENCE_EMPTY_MESSAGES[reason];
}

/** フルテキストフェーズのAI判定（reviewer_id が `llm:`）か */
function isFulltextAiDecision(d: Decision): boolean {
    return (d.screening_phase ?? 'tiab') === 'fulltext' && (d.reviewer_id || '').startsWith('llm:');
}

/**
 * 判定の瞬間にこの文献へ付いていた、採用ラウンド(aiActiveRound)のAI票の件数を数える。
 * context_json（decision-context.ts）の ai_votes_at_decision に使う。
 */
export function countActiveRoundAiVotesForRef(refId: string): number {
    if (!session.aiActiveRound) return 0;
    return session.allDecisions.filter(d =>
        d.ref_id === refId && d.reviewer_id === session.aiActiveRound && isFulltextAiDecision(d)
    ).length;
}

/**
 * 現在の表示経路に応じて AI evidence 表示を再構築する。
 * PDF.js 描画中はハイライト＋カード、それ以外（iframe埋め込み等）はカードのみ。
 * 開示トグルや表示レベル変更時の再描画に使う。
 */
export function refreshEvidenceDisplay(): void {
    if (session.currentPdfInfo) {
        applyHighlightsForCurrentRef();
    } else {
        renderAiCardsFallback();
    }
}

/**
 * PDF.js 以外の表示経路（Driveプレビュー埋め込み・Chrome内蔵ビュワー・
 * 論文ページ埋め込み・リンクのみ表示）でも根拠カード一覧は表示する。
 * 矩形ハイライトは描けないため、カードは quote＋AIの申告ページ番号のみで
 * クリックでのスクロールは無効にする。
 */
export function renderAiCardsFallback(): void {
    if (!session.currentRef) return;

    const level = effectiveEvidenceLevel();
    if (level === 'none') {
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const note = findAiFulltextNote(session.currentRef.ref_id);
    if (!note || !Array.isArray(note.evidence) || note.evidence.length === 0) {
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const items: HighlightListItem[] = note.evidence.map((ev, idx) => ({
        id: `ai-ev-${idx}`,
        category: (level !== 'full' ? 'ai_evidence'
            : ev.polarity === 'exclude' ? 'exclude_evidence' : 'include_evidence') as HighlightCategory,
        quote: ev.quote,
        page: ev.page,
        resolved: false,
        via: 'none' as const,
    }));

    renderAnnotationsList(items, note.image_only ?? false, {
        clickable: false,
        notice: 'この表示モードではPDF上のハイライト表示はできません（根拠一覧のみ）。',
    });
}

export function applyHighlightsForCurrentRef(): void {
    // Issue #151（#150 工程0）: tiab:pdf.highlight として計測（ハイライト適用）。
    return perfSpanSync('tiab:pdf.highlight', () => applyHighlightsForCurrentRefImpl());
}

function applyHighlightsForCurrentRefImpl(): void {
    if (!session.pdfRenderer || !session.currentRef || !session.currentPdfInfo) return;
    session.pdfRenderer.clearHighlights();

    // evidence の表示レベル（ブラインディング制御）:
    // - none:    evidence 自体を出さない（AI判定なしと同じ見た目）
    // - neutral: 単色ハイライト＋「AI注目箇所」。polarity の並びからAI判断を推測させない
    // - full:    組入/除外の色分け・polarityラベル（開示時は常にこれ）
    const level = effectiveEvidenceLevel();
    if (level === 'none') {
        // 空表示は「AI判定根拠なし」と同文言にし、AI判定の有無自体を漏らさない
        renderAnnotationsList([], false, { emptyMessage: evidenceEmptyMessage() });
        return;
    }

    const note = findAiFulltextNote(session.currentRef.ref_id);
    const items: HighlightListItem[] = [];

    if (note && Array.isArray(note.evidence)) {
        note.evidence.forEach((ev, idx) => {
            // neutral では DOM 属性からも polarity が読めないよう中立カテゴリに落とす
            const category: HighlightCategory =
                level !== 'full' ? 'ai_evidence'
                    : ev.polarity === 'exclude' ? 'exclude_evidence' : 'include_evidence';
            const id = `ai-ev-${idx}`;
            const result = session.pdfRenderer!.highlight({
                id,
                category,
                quote: ev.quote,
                page: ev.page,
                bbox: ev.bbox,
                title: ev.quote,
            });
            items.push({
                id,
                category,
                quote: ev.quote,
                page: result.page ?? ev.page,
                resolved: result.resolved,
                via: result.via,
            });
        });
    }

    renderAnnotationsList(items, note?.image_only ?? session.currentPdfInfo?.isImageOnly ?? false, {
        emptyMessage: evidenceEmptyMessage(),
    });
    session.pdfRenderer.setHighlightsVisible(session.highlightEnabled);
}

/**
 * 現在の文献に対するAIフルテキスト判定（Decision + パース済み note）を返す。
 * 採用ラウンド(aiActiveRound)の判定のみを対象とする。
 * 採用ラウンド未設定、または当該ラウンドの判定が無ければ null（＝AI判定は一切表示しない）。
 */
export function findAiFulltext(refId: string): { decision: Decision; note: FulltextLlmDecisionNote } | null {
    if (!session.aiActiveRound) return null;
    const candidates = session.allDecisions
        .filter(d =>
            d.ref_id === refId &&
            d.reviewer_id === session.aiActiveRound &&
            (d.screening_phase ?? 'tiab') === 'fulltext' &&
            !!d.note && d.note.trim().startsWith('{')
        )
        .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));

    for (const d of candidates) {
        try {
            const parsed = JSON.parse(d.note as string);
            if (parsed && parsed.type === 'llm_fulltext') {
                return { decision: d, note: parsed as FulltextLlmDecisionNote };
            }
        } catch { /* 次の候補へ */ }
    }
    return null;
}

/** 現在の文献に対する最新のAIフルテキスト判定 note を返す（無ければ null） */
function findAiFulltextNote(refId: string): FulltextLlmDecisionNote | null {
    return findAiFulltext(refId)?.note ?? null;
}

/**
 * 指定idの根拠カードへスクロールして一時強調する。
 * PDF上のハイライトクリック・n/pジャンプからの連動に使う。
 */
export function focusAnnotationCard(id: string): void {
    const list = document.getElementById('ft-annotations-list');
    const card = list?.querySelector(`.ft-annotation-card[data-hl-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!card) return;
    session.evidenceCursor = session.evidenceItems.findIndex(i => i.id === id);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    flashElement(card, 'ft-card-flash');
}

/** 要素に flash クラスを付け直してアニメーションを再始動し、終了後に外す */
function flashElement(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow でアニメーションをリセット
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 1300);
}

/**
 * n / p キーで次/前の evidence へジャンプする。
 * カードを強調し、PDF.js 描画中は該当ハイライト（または申告ページ）へもスクロールする。
 */
export function jumpToEvidence(delta: number): void {
    if (session.evidenceItems.length === 0) return;
    if (session.evidenceCursor === -1) {
        session.evidenceCursor = delta > 0 ? 0 : session.evidenceItems.length - 1;
    } else {
        session.evidenceCursor = (session.evidenceCursor + delta + session.evidenceItems.length) % session.evidenceItems.length;
    }
    const item = session.evidenceItems[session.evidenceCursor];
    focusAnnotationCard(item.id);
    // オーバーレイ非表示中は（不可視要素へは scrollIntoView が効かないため）ページ単位で送る
    if (item.resolved && session.highlightEnabled) {
        // Issue #151（#150 工程0）: tiab:pdf.evidenceJump として計測（根拠カードからのジャンプ）。
        perfSpanSync('tiab:pdf.evidenceJump', () => session.pdfRenderer?.scrollToHighlight(item.id));
        session.pdfRenderer?.flashHighlight(item.id);
    } else if (session.currentPdfInfo) {
        session.pdfRenderer?.scrollToPage(item.page);
    }
}

interface AnnotationListOptions {
    /** カードクリックでのスクロールを有効にするか（PDF.js 描画時のみ true）。既定 true */
    clickable?: boolean;
    /** 一覧先頭に出す注意書き（フォールバック表示モードの説明など） */
    notice?: string;
    /** 空表示の文言（状態別の出し分け用）。省略時は既定文言 */
    emptyMessage?: string;
}

/** 右ペインのアノテーション一覧を再構築する */
function renderAnnotationsList(
    items: HighlightListItem[],
    imageOnly: boolean,
    opts: AnnotationListOptions = {}
): void {
    const list = document.getElementById('ft-annotations-list');
    if (!list) return;
    list.innerHTML = '';
    const clickable = opts.clickable ?? true;

    // n/p ジャンプ・ハイライト連動用の一覧を差し替え、カーソルをリセット
    session.evidenceItems = items;
    session.evidenceCursor = -1;

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ft-annotation-empty';
        // 理由別メッセージは導線案内を含み複数行になるため、改行を <br> として描画する
        appendTextWithBreaks(empty, opts.emptyMessage ?? AI_EVIDENCE_EMPTY_MESSAGES.no_evidence);
        list.appendChild(empty);
        return;
    }

    if (opts.notice) {
        const notice = document.createElement('div');
        notice.className = 'ft-annotation-notice';
        notice.textContent = opts.notice;
        list.appendChild(notice);
    }

    if (imageOnly) {
        const note = document.createElement('div');
        note.className = 'ft-annotation-imageonly';
        note.textContent = '⚠ スキャン画像PDFのため、ハイライト位置はAIの領域推定に基づきます（精度が落ちる場合があります）。';
        list.appendChild(note);
    }

    for (const item of items) {
        const card = document.createElement('div');
        card.className = 'ft-annotation-card';
        card.dataset.category = item.category;
        card.dataset.hlId = item.id;

        const text = document.createElement('div');
        text.className = 'ft-annotation-text';
        text.textContent = item.quote;
        card.appendChild(text);

        const meta = document.createElement('div');
        meta.className = 'ft-annotation-meta';
        // ＋/－ は緑/赤（P/D型色覚で区別困難）の冗長コーディング
        const polarityLabel =
            item.category === 'ai_evidence' ? 'AI注目箇所'
                : item.category === 'exclude_evidence' ? '－ 除外根拠' : '＋ 組入根拠';
        // フォールバック（クリック不可）時の位置はAIの申告ページ番号そのままなので
        // 「位置不明」の注記は付けない
        const locLabel = !clickable
            ? `p.${item.page}`
            : item.resolved
                ? (item.via === 'bbox' ? `p.${item.page}（領域推定）` : `p.${item.page}`)
                : `p.${item.page}（位置不明）`;
        meta.textContent = `${polarityLabel} · ${locLabel}`;
        card.appendChild(meta);

        if (clickable) {
            // クリックで該当ハイライト（解決済み）またはページ先頭（縮退）へスクロールし、
            // スクロール先のハイライトを一時強調して見つけやすくする
            card.addEventListener('click', () => {
                session.evidenceCursor = session.evidenceItems.findIndex(i => i.id === item.id);
                // オーバーレイ非表示中は（不可視要素へは scrollIntoView が効かないため）ページ単位で送る
                if (item.resolved && session.highlightEnabled) {
                    // Issue #151（#150 工程0）: tiab:pdf.evidenceJump として計測（根拠カードからのジャンプ）。
                    perfSpanSync('tiab:pdf.evidenceJump', () => session.pdfRenderer?.scrollToHighlight(item.id));
                    session.pdfRenderer?.flashHighlight(item.id);
                } else {
                    session.pdfRenderer?.scrollToPage(item.page);
                }
            });
        } else {
            card.classList.add('ft-annotation-static');
        }

        list.appendChild(card);
    }
}
