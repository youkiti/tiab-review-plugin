/**
 * レビュー基準（組入・除外基準）モジュール
 *
 * TiAb 画面から、プロトコル文書を都度開かなくても組入・除外基準を参照できるようにする
 * モーダル UI。Config タブの review_criteria キー（src/lib/review-criteria.ts）を表示・編集する。
 *
 * 注意: features/llm/criteria.ts（AI基準最適化＝PICO/PECO構造化基準）とは別物。
 * 混同しないこと。
 */

import { state } from '../state';
import { t } from '../../lib/i18n';
import { showModal, hideModal } from '../ui/modal';
import { showToast } from '../ui/feedback';
import { saveReviewCriteria } from '../../lib/sheets-api';
import { getCriteriaSeenAt, setCriteriaSeenAt } from '../../lib/storage';
import { needsCriteriaNotice, llmCriteriaToText, type ReviewCriteria } from '../../lib/review-criteria';

/**
 * 基準モーダルが今まさに開いているかを DOM から判定する。
 * modal.ts は汎用モーダルで開閉状態を公開しておらず、かつ showModal は
 * currentOnClose を上書きするため、モジュール変数で追跡すると実状態とずれる。
 * 「backdrop が表示されている」かつ「中身が基準モーダルである」の両方を見る。
 */
export function isCriteriaModalOpen(): boolean {
    const backdrop = document.getElementById('modal-backdrop');
    return !!backdrop
        && !backdrop.classList.contains('hidden')
        && !!backdrop.querySelector('.review-criteria-modal');
}

/**
 * 基準モーダルの close ハンドラ。
 * 表示された基準の updated_at を「見た」ものとして記録する（案D通知の既読化）。
 */
function onCriteriaModalClose() {
    void setCriteriaSeenAt(state.spreadsheetId, state.reviewCriteria?.updated_at ?? '');
}

/**
 * ローカル日時の読みやすい表示に整形する。パース不能な場合は元の文字列をそのまま返す。
 */
function formatUpdatedAt(iso: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
}

/**
 * AI タブの出力言語設定が日本語かどうかを判定する（llmCriteriaToText のラベル言語切り替え用）。
 */
function isJapaneseLlmOutput(): boolean {
    return (state.llmConfig.llm_output_language || '').toLowerCase().startsWith('ja');
}

/**
 * レビュー基準モーダルを開く（閲覧モード）。
 * @param options.notice true のとき、基準が更新された旨の帯をモーダル冒頭に表示する（案D）。
 */
export function showReviewCriteriaModal(options: { notice?: boolean } = {}) {
    renderViewMode(options.notice === true);
}

/**
 * キーボードショートカット（'c'）用: モーダルが開いていれば閉じ、閉じていれば開く。
 */
export function toggleReviewCriteriaModal() {
    if (isCriteriaModalOpen()) {
        hideModal();
    } else {
        showReviewCriteriaModal();
    }
}

/**
 * 案D: 基準が更新されていれば自動的にモーダルを表示する。
 * 読み込み完了後に呼ばれる想定（呼び出し側で await せず fire-and-forget する）。
 *
 * 既に何らかのモーダル（担当割り振りウィザード等）が開いている場合は、通知を出さずに
 * 何もせず戻る。loadDataAndShowScreening() は maybeShowAssignmentWizard('load') と
 * この関数を両方 await せず発火するため、ここで描画すると先に開いていたモーダルを
 * showModal の currentOnClose 上書きごと消してしまう。既読化もしない
 * （次回の読み込み時に改めて通知されればよい）。
 */
export async function maybeShowCriteriaNotice(): Promise<void> {
    if (!state.spreadsheetId) return;
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop && !backdrop.classList.contains('hidden')) return;
    const seenAt = await getCriteriaSeenAt(state.spreadsheetId);
    if (needsCriteriaNotice(state.reviewCriteria, seenAt)) {
        showReviewCriteriaModal({ notice: true });
    }
}

function renderViewMode(notice: boolean) {
    const criteria = state.reviewCriteria;
    const body = document.createElement('div');
    body.className = 'review-criteria-modal';

    if (notice) {
        const banner = document.createElement('div');
        banner.className = 'review-criteria-notice-banner';
        banner.textContent = t('criteria_updatedNotice');
        body.appendChild(banner);
    }

    if (criteria === null) {
        const empty = document.createElement('p');
        empty.className = 'review-criteria-empty';
        empty.textContent = state.isAdmin ? t('criteria_emptyAdmin') : t('criteria_emptyNonAdmin');
        body.appendChild(empty);
    } else {
        const textEl = document.createElement('div');
        textEl.className = 'review-criteria-text';
        // CSS 側の white-space: pre-wrap で改行を表現するため、textContent への代入だけで
        // XSS対策・改行表現の両方が完結する（escapeHtml + innerHTML と完全に等価で単純）。
        textEl.textContent = criteria.text;
        body.appendChild(textEl);

        if (criteria.updated_by || criteria.updated_at) {
            const meta = document.createElement('div');
            meta.className = 'review-criteria-meta';
            const parts: string[] = [];
            if (criteria.updated_by) parts.push(t('criteria_updatedByLabel', criteria.updated_by));
            if (criteria.updated_at) parts.push(t('criteria_updatedAtLabel', formatUpdatedAt(criteria.updated_at)));
            meta.textContent = parts.join(' / ');
            body.appendChild(meta);
        }
    }

    const footer = document.createElement('div');
    footer.className = 'review-criteria-modal-actions';

    // 編集ボタンは管理者のみ（基準がレビュアー間で勝手に書き換わる事故を防ぐため）
    if (state.isAdmin) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary btn-small';
        editBtn.textContent = criteria === null ? t('criteria_registerButton') : t('criteria_editButton');
        editBtn.onclick = () => renderEditMode(criteria);
        footer.appendChild(editBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-outline btn-small';
    closeBtn.textContent = t('common_close');
    closeBtn.onclick = () => hideModal();
    footer.appendChild(closeBtn);

    showModal({
        title: t('criteria_modalTitle'),
        body,
        footer,
        onClose: onCriteriaModalClose,
    });
}

function renderEditMode(criteria: ReviewCriteria | null) {
    const body = document.createElement('div');
    body.className = 'review-criteria-modal review-criteria-edit';

    const textarea = document.createElement('textarea');
    textarea.className = 'review-criteria-textarea';
    textarea.rows = 12;
    textarea.value = criteria?.text ?? '';
    textarea.placeholder = t('criteria_textareaPlaceholder');
    body.appendChild(textarea);

    // AIタブの構造化基準から取り込む（AIタブで基準を先に作った場合の逆方向コピペ省略）
    if (state.llmConfig.llm_criteria) {
        const importBtn = document.createElement('button');
        importBtn.className = 'btn btn-outline btn-small review-criteria-import-btn';
        importBtn.textContent = t('criteria_importFromAiButton');
        importBtn.onclick = () => {
            if (textarea.value.trim() !== '' && !confirm(t('criteria_importConfirmOverwrite'))) {
                return;
            }
            textarea.value = llmCriteriaToText(state.llmConfig.llm_criteria, isJapaneseLlmOutput());
        };
        body.appendChild(importBtn);
    }

    const footer = document.createElement('div');
    footer.className = 'review-criteria-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline btn-small';
    cancelBtn.textContent = t('common_cancel');
    cancelBtn.onclick = () => renderViewMode(false);
    footer.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-small';
    saveBtn.textContent = t('common_save');
    saveBtn.onclick = () => void handleSaveCriteria(textarea, saveBtn, cancelBtn);
    footer.appendChild(saveBtn);

    showModal({
        title: t('criteria_modalEditTitle'),
        body,
        footer,
        onClose: onCriteriaModalClose,
    });
}

async function handleSaveCriteria(
    textarea: HTMLTextAreaElement,
    saveBtn: HTMLButtonElement,
    cancelBtn: HTMLButtonElement
) {
    const originalLabel = saveBtn.textContent ?? '';
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = t('common_saving');

    try {
        const criteria: ReviewCriteria = {
            text: textarea.value,
            updated_at: new Date().toISOString(),
            updated_by: state.userEmail,
        };
        await saveReviewCriteria(state.spreadsheetId, criteria);
        state.setReviewCriteria(criteria);
        // 自分の保存分は即座に既読化する（自分の編集で自分に更新通知が出ないようにするため）
        await setCriteriaSeenAt(state.spreadsheetId, criteria.updated_at);
        showToast(t('criteria_saved'));
        renderViewMode(false);
    } catch (error) {
        console.error('[review-criteria] handleSaveCriteria error:', error);
        showToast(t('criteria_saveError', (error as Error).message));
        // 失敗時はモーダルを閉じず、入力内容を保持したままボタンだけ復帰させる
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = originalLabel;
    }
}
