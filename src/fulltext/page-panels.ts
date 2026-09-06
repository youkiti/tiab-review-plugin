// page-panels.ts - 書誌・判定の文脈・レビュー基準モーダルを表示する。
// 状態・判定表示・共通ヘルパーへ一方向に依存する。
// Issue #156: 関数本体と実行順序を保った責務分割。

import { excludeReasonLabel } from '../lib/exclude-reasons';
import { needsCriteriaNotice } from '../lib/review-criteria';
import { getCriteriaSeenAt, setCriteriaSeenAt } from '../lib/storage';
import type { Reference } from '../lib/types';
import { session } from './session';
import {
    findMyTiabDecision,
    AI_DECISION_LABELS,
    findOtherFulltextDecisions,
    buildOtherDecisionsBlock,
} from './decision-controller';

// ---------------------------------------------------------------------------
// レビュー基準（組入・除外基準）モーダル
//
// Config タブの review_criteria を閲覧専用で表示する（src/lib/review-criteria.ts）。
// 編集導線はここには置かない（編集はサイドパネルに一本化し、二重実装を避ける方針）。
// 汎用モーダル（ui/modal.ts）はサイドパネル専用のためこのページには無く、
// ft- プレフィックスの専用モーダルマークアップを fulltext.html に新設している。
// ---------------------------------------------------------------------------

/** レビュー基準モーダルが今開いているか（backdrop の hidden クラスで判定） */
export function isCriteriaModalOpen(): boolean {
    const backdrop = document.getElementById('ft-criteria-backdrop');
    return !!backdrop && !backdrop.classList.contains('hidden');
}

/** パース不能な場合は元の文字列をそのまま返す（review-criteria.ts の formatUpdatedAt と同趣旨） */
function formatCriteriaUpdatedAt(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
}

/** モーダル本文を現在の reviewCriteria から描画する */
function renderCriteriaModalBody(notice: boolean): void {
    const body = document.getElementById('ft-criteria-body');
    if (!body) return;
    body.innerHTML = '';

    if (notice) {
        const banner = document.createElement('div');
        banner.className = 'ft-criteria-notice-banner';
        banner.textContent = 'レビュー基準が更新されました。';
        body.appendChild(banner);
    }

    if (session.reviewCriteria === null) {
        const empty = document.createElement('p');
        empty.className = 'ft-criteria-empty';
        empty.textContent = 'まだレビュー基準が登録されていません。サイドパネル（TiAb画面）の📋ボタンから登録できます。';
        body.appendChild(empty);
        return;
    }

    const textEl = document.createElement('div');
    textEl.className = 'ft-criteria-text';
    // CSS 側の white-space: pre-wrap で改行を表現するため textContent への代入だけでよい
    textEl.textContent = session.reviewCriteria.text;
    body.appendChild(textEl);

    if (session.reviewCriteria.updated_by || session.reviewCriteria.updated_at) {
        const meta = document.createElement('div');
        meta.className = 'ft-criteria-meta';
        const parts: string[] = [];
        if (session.reviewCriteria.updated_by) parts.push(`更新者: ${session.reviewCriteria.updated_by}`);
        if (session.reviewCriteria.updated_at) parts.push(`更新日時: ${formatCriteriaUpdatedAt(session.reviewCriteria.updated_at)}`);
        meta.textContent = parts.join(' / ');
        body.appendChild(meta);
    }
}

/** レビュー基準モーダルを開く。notice=true で「基準が更新されました」の帯を先頭に表示する（案D） */
function openCriteriaModal(notice: boolean): void {
    renderCriteriaModalBody(notice);
    document.getElementById('ft-criteria-backdrop')?.classList.remove('hidden');
}

/**
 * レビュー基準モーダルを閉じる。
 * 閉じた時点で既読化する（サイドパネルと同じキー・同じ関数 setCriteriaSeenAt を使い、
 * 両画面で既読状態を共有する）。
 */
export function closeCriteriaModal(): void {
    const backdrop = document.getElementById('ft-criteria-backdrop');
    if (!backdrop || backdrop.classList.contains('hidden')) return;
    backdrop.classList.add('hidden');
    void setCriteriaSeenAt(session.spreadsheetId, session.reviewCriteria?.updated_at ?? '');
}

/** キーボードショートカット（'c'）用: 開いていれば閉じ、閉じていれば開く */
export function toggleCriteriaModal(): void {
    if (isCriteriaModalOpen()) {
        closeCriteriaModal();
    } else {
        openCriteriaModal(false);
    }
}

/**
 * 案D: 基準が未読または更新後なら自動的にモーダルを表示する。
 * 既読マーカーはサイドパネルと同じキー・同じ関数（storage.ts の get/setCriteriaSeenAt）を
 * 使うため、両画面で既読状態を共有する。
 */
export async function maybeShowCriteriaNotice(): Promise<void> {
    if (!session.spreadsheetId) return;
    const seenAt = await getCriteriaSeenAt(session.spreadsheetId);
    if (needsCriteriaNotice(session.reviewCriteria, seenAt)) {
        openCriteriaModal(true);
    }
}

export function wireCriteriaModal(): void {
    document.getElementById('ft-criteria-btn')?.addEventListener('click', () => toggleCriteriaModal());
    document.getElementById('ft-criteria-close-btn')?.addEventListener('click', () => closeCriteriaModal());
    document.getElementById('ft-criteria-footer-close-btn')?.addEventListener('click', () => closeCriteriaModal());
    // backdrop 自体のクリックのみで閉じる（中身のパネルへのクリックで閉じないよう target を見る）
    document.getElementById('ft-criteria-backdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeCriteriaModal();
    });
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

/**
 * PDFペイン上部に書誌情報を表示する。
 * 表示中PDFの本文（タイトル・著者・誌名・年）と突き合わせて、
 * 誤ったPDFが保存されていないかをレビュアーが判断できるようにする。
 */
export function renderBiblio(ref: Reference): void {
    const bar = document.getElementById('ft-biblio');
    const titleEl = document.getElementById('ft-biblio-title');
    const metaEl = document.getElementById('ft-biblio-meta');
    const idsEl = document.getElementById('ft-biblio-ids');
    if (!bar || !titleEl || !metaEl || !idsEl) return;

    titleEl.textContent = ref.title || '(タイトルなし)';

    // 著者 · 誌名 year;vol(issue):pages
    const metaParts: string[] = [];
    if (ref.authors) metaParts.push(ref.authors);
    let cite = '';
    if (ref.journal) cite += ref.journal;
    if (ref.year) cite += (cite ? ' ' : '') + ref.year;
    let loc = '';
    if (ref.volume) loc += ref.volume;
    if (ref.issue) loc += `(${ref.issue})`;
    if (ref.pages) loc += `:${ref.pages}`;
    if (loc) cite += (cite ? ';' : '') + loc;
    if (cite) metaParts.push(cite);
    metaEl.textContent = metaParts.join(' · ');

    // DOI / PMID リンク
    idsEl.replaceChildren();
    if (ref.doi) {
        const link = document.createElement('a');
        link.href = `https://doi.org/${encodeURIComponent(ref.doi)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `DOI: ${ref.doi}`;
        idsEl.appendChild(link);
    }
    if (ref.pmid) {
        const link = document.createElement('a');
        link.href = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `PMID: ${ref.pmid}`;
        idsEl.appendChild(link);
    }
    idsEl.classList.toggle('hidden', idsEl.children.length === 0);

    bar.classList.remove('hidden');
}

/**
 * 右ペインの「抄録・自分のTiAb判定」折りたたみを描画する。
 * 表示中PDFと抄録の突き合わせ（取り違え確認）と、
 * TiAb時に何を根拠に通したかの文脈想起を助ける。開閉状態は文献をまたいで維持する。
 * Blind解除後は他レビュアーのフルテキスト判定もここに出す（不一致の見直し用）。
 */
export function renderContextPanel(ref: Reference): void {
    const body = document.getElementById('ft-context-body');
    if (!body) return;
    body.replaceChildren();

    const tiab = findMyTiabDecision(ref.ref_id);
    const tiabRow = document.createElement('div');
    tiabRow.className = 'ft-context-tiab';
    if (tiab) {
        tiabRow.dataset.decision = tiab.decision;
        const parts = [`自分のTiAb判定: ${AI_DECISION_LABELS[tiab.decision] ?? tiab.decision}`];
        // TiAb の除外理由は既定PICOキー（フルテキスト用カスタムリストとは別物）で保存されているため、
        // excludeReasonItems（フルテキスト用リスト）で引くと解決できず生キーが出る。
        // 引数を省略して既定リスト（DEFAULT_EXCLUDE_REASON_ITEMS）で引く。
        if (tiab.reason) parts.push(excludeReasonLabel(tiab.reason));
        if (tiab.note) parts.push(tiab.note);
        tiabRow.textContent = parts.join(' · ');
    } else {
        tiabRow.textContent = '自分のTiAb判定: なし';
    }
    body.appendChild(tiabRow);

    // Blind解除後のみ他レビュアーの判定を出す（Blind中は見出しごと出さない）
    const others = findOtherFulltextDecisions(ref.ref_id);
    if (session.keyOpened) {
        body.appendChild(buildOtherDecisionsBlock(others));
    }
    // 折りたたみ見出しにも件数を出す。畳んだままだと相手の判定があることに気付けないため
    const summary = document.getElementById('ft-context-summary');
    if (summary) {
        summary.textContent = session.keyOpened
            ? `抄録・自分のTiAb判定・他レビュアーの判定 (${others.length})`
            : '抄録・自分のTiAb判定';
    }

    const abs = document.createElement('div');
    abs.className = 'ft-context-abstract';
    abs.textContent = ref.abstract || '（抄録なし）';
    body.appendChild(abs);
}
