import { createLazyFeatureLoader } from '../../../lib/lazy-feature-loader';
import { platform } from '../../../platform';
import { reportFeatureLoadError } from '../../ui/lazy-feature-feedback';

// 本体の読み込みに失敗したときの退避先。対応表（lib/guide/topics.ts）は本体チャンクにだけ
// 入れるため、ここではヘルプのトップ URL を直接持つ。
const HELP_TOP_URL = 'https://youkiti.github.io/tiab-review-plugin/help.html';

/** 「?」の吹き出し本体は初回クリックで読み込む（初期バンドルを増やさない）。 */
const loadGuideFeature = createLazyFeatureLoader(
    () => import(/* webpackChunkName: "guide-feature" */ './index'),
);

/**
 * `[data-help]` 要素（「?」ボタン）のクリックを document で一括して拾う。
 * チーム進捗のヘッダーのように、内側で伝播を止める既存ハンドラの中に置いた「?」でも
 * 拾えるよう、キャプチャ段階で受け取る。
 */
export function setupGuideListeners(): void {
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLElement>('[data-help]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        loadGuideFeature()
            .then(feature => feature.toggleGuidePopover(button))
            .catch(error => {
                reportFeatureLoadError(error, 'guide');
                platform().openExternal(HELP_TOP_URL);
            });
    }, true);
}
