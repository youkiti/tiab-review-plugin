/**
 * PC ブラウザからのアクセス時のみ、拡張版（Chrome Web Store）への誘導バナーを表示する。
 *
 * Web版専用ロジックとして src/webapp/ 配下に置き、src/webapp/index.ts からのみ呼び出す。
 * 拡張版のエントリ（src/sidepanel/sidepanel.ts）からは参照されないため、
 * 拡張版にこのバナーが表示されることは構造的に起こり得ない。
 *
 * 表示条件（すべて満たすときのみ）:
 * - ポインタ精度が高い（マウス操作、`pointer: fine`）
 * - 画面幅が 1024px 以上（PCブラウザ相当のビューポート）
 * - 過去に閉じるボタンで閉じられていない（platform storage: desktopNoticeDismissed）
 *
 * マークアップは #project-section 内にあるため、レビュー画面（#screening-section）が
 * 表示されている間は親要素ごと hidden になり、このバナーが表示されることはない
 * （renderLayout の view 切替に依存。普段のレビュー操作を妨げない）。
 */
import { platform } from '../platform';
import { dom } from '../sidepanel/dom';
import { t } from '../lib/i18n';

const STORAGE_KEY = 'desktopNoticeDismissed';

/** PCブラウザ相当のアクセスかどうかを判定する */
function isDesktopBrowser(): boolean {
    return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 1024;
}

/** 拡張版誘導バナーの表示制御を初期化する（Web版のみから呼び出すこと） */
export async function setupDesktopExtensionNotice(): Promise<void> {
    if (!isDesktopBrowser()) return;

    const stored = await platform().storageGet([STORAGE_KEY]);
    if (stored[STORAGE_KEY]) return;

    dom.desktopExtensionNotice.classList.remove('hidden');
    // data-i18n-title は title 属性のみを設定するため、スクリーンリーダー向けに
    // aria-label も別途設定する（localizeHtml() に data-i18n-aria-label は新設しない方針）
    dom.desktopExtensionNoticeClose.setAttribute('aria-label', t('webapp_desktopNoticeClose'));

    dom.desktopExtensionNoticeClose.addEventListener('click', () => {
        dom.desktopExtensionNotice.classList.add('hidden');
        void platform().storageSet({ [STORAGE_KEY]: true });
    });
}
