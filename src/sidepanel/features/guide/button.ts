import { t } from '../../../lib/i18n';

/**
 * 実行時に描画する領域（チーム進捗パネル・重複の確認セクションなど）に置く「?」ボタンを作る。
 * クリックは lazy.ts が document で拾うので、ここでは `data-help` を付けるだけでよい。
 * localizeHtml は再描画のたびには走らないため、文言はここで直接入れる。
 */
export function createGuideHelpButton(topicId: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'guide-help-btn';
    button.dataset.help = topicId;
    button.textContent = '?';
    button.title = t('guide_helpBtnTitle');
    button.setAttribute('aria-label', t('guide_helpBtnTitle'));
    return button;
}
