/**
 * ハイライトキーワード管理モジュール
 */

import { t } from '../../../lib/i18n';
import { dom } from '../../dom';
import { state } from '../../state';
import { updateConfigKeywords, PRESET_RCT, PRESET_SR } from '../../../lib/sheets-api';
import { showToast, updateSaveStatus } from '../../ui/feedback';
import { addTermFilter } from './filters';

// 外部レンダリング関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;

export function setKeywordDependencies(deps: {
    renderCurrentReference: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
}

/**
 * キーワード設定UIを表示
 */
export function renderKeywords() {
    renderKeywordList('include', state.highlightKeywords.include);
    renderKeywordList('exclude', state.highlightKeywords.exclude);
}

/**
 * キーワードリストをレンダリング（共通処理）
 */
function renderKeywordList(type: 'include' | 'exclude', keywords: string[]) {
    const container = type === 'include' ? dom.includeKeywordsListDiv : dom.excludeKeywordsListDiv;
    container.innerHTML = '';

    for (const word of keywords) {
        if (!word) continue;

        const span = document.createElement('span');
        span.className = `keyword-tag ${type}`;

        // タグの構造: [テキスト] [削除ボタン]
        span.innerHTML = `
            <span class="keyword-text" title="${t('keyword_clickToFilter')}">${word}</span>
            <span class="remove-keyword" title="${t('keyword_delete')}">×</span>
        `;

        // タグ本体クリックでフィルター適用
        span.querySelector('.keyword-text')?.addEventListener('click', () => {
            // フィルターに追加
            addTermFilter(word, type);
            showToast(t('filter_applyToast', word));
        });

        // ×ボタンクリックでキーワード削除
        span.querySelector('.remove-keyword')?.addEventListener('click', (e) => {
            e.stopPropagation();
            removeKeyword(type, word);
        });
        container.appendChild(span);
    }
}

/**
 * キーワードを追加
 */
export async function addKeyword(type: 'include' | 'exclude') {
    const input = type === 'include' ? dom.newIncludeInput : dom.newExcludeInput;
    const word = input.value.trim();

    if (!word) return;

    // 重複チェック
    const list = type === 'include' ? state.highlightKeywords.include : state.highlightKeywords.exclude;
    if (list.includes(word)) {
        input.value = '';
        return;
    }

    // 追加
    if (type === 'include') {
        state.addIncludeKeyword(word);
    } else {
        state.addExcludeKeyword(word);
    }

    input.value = '';
    renderKeywords();
    if (_renderCurrentReference) _renderCurrentReference(); // ハイライト即時反映

    // 自動保存
    await saveKeywordsAuto();
}

/**
 * キーワードを削除
 */
export async function removeKeyword(type: 'include' | 'exclude', word: string) {
    if (type === 'include') {
        state.removeIncludeKeyword(word);
    } else {
        state.removeExcludeKeyword(word);
    }
    renderKeywords();
    if (_renderCurrentReference) _renderCurrentReference(); // ハイライト即時反映

    // 自動保存
    await saveKeywordsAuto();
}

/**
 * プリセットを適用
 */
export async function applyPreset(type: 'RCT' | 'SR') {
    if (!confirm(t('keyword_presetConfirm', type))) {
        return;
    }

    const preset = type === 'RCT' ? PRESET_RCT : PRESET_SR;

    // 値渡しでコピー
    state.setHighlightKeywords({
        include: [...preset.include],
        exclude: [...preset.exclude]
    });

    renderKeywords();
    if (_renderCurrentReference) _renderCurrentReference();

    // 自動保存
    await saveKeywordsAuto();

    showToast(t('keyword_presetApplied', type));
}

/**
 * 設定をConfigシートに自動保存
 */
export async function saveKeywordsAuto() {
    try {
        updateSaveStatus('saving');

        await updateConfigKeywords(state.spreadsheetId, state.highlightKeywords);

        updateSaveStatus('saved');

        // 3秒後にステータスをデフォルトに戻す
        setTimeout(() => {
            if (dom.saveStatus.classList.contains('saved')) {
                updateSaveStatus('default');
            }
        }, 3000);

    } catch (error) {
        console.error('Failed to save keywords:', error);
        updateSaveStatus('error');
    }
}
