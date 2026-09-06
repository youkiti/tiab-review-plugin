import { createLazyFeatureLoader } from '../../../lib/lazy-feature-loader';
import { t } from '../../../lib/i18n';
import { dom } from '../../dom';
import { getState, subscribe, type Tab } from '../../store';
import { changeTab } from '../../store/compat';
import { hideToast } from '../../ui/feedback';
import { reportFeatureLoadError } from '../../ui/lazy-feature-feedback';

type LlmFeatureModule = typeof import('./index');
let feature: LlmFeatureModule | undefined;
let handleBack: (() => void) | undefined;
let loadDataAndShowScreening: (() => Promise<void>) | undefined;

/** 本体とプロバイダを1チャンクへ集約し、リスナー登録は成功時の一度だけ行う。 */
export const loadLlmFeature = createLazyFeatureLoader(async () => {
    const loaded = await import(/* webpackChunkName: "llm-feature" */ './index');
    if (handleBack) loaded.setHandleBack(handleBack);
    if (loadDataAndShowScreening) loaded.setLoadDataAndShowScreening(loadDataAndShowScreening);
    loaded.setupLlmEventListeners();
    feature = loaded;
    return loaded;
});

export function setHandleBack(fn: () => void): void {
    handleBack = fn;
    feature?.setHandleBack(fn);
}

export function setLoadDataAndShowScreening(fn: () => Promise<void>): void {
    loadDataAndShowScreening = fn;
    feature?.setLoadDataAndShowScreening(fn);
}

/** タブボタンは sidepanel.ts が登録する。セクション内の操作は本体ロード後に登録する。 */
export function setupLlmEventListeners(): void {
    // 初期表示から本体を読み込まないため、ここでのリスナー登録は不要。
}

function showLoading(loading: boolean): void {
    const section = dom.llmSection;
    let status = section.querySelector<HTMLElement>('.llm-feature-status');
    if (loading && !status) {
        status = document.createElement('div');
        status.className = 'llm-feature-status';
        status.setAttribute('role', 'status');
        section.prepend(status);
    }
    section.setAttribute('aria-busy', String(loading));
    if (status) {
        status.textContent = t('llm_featureLoading');
        status.classList.toggle('hidden', !loading);
    }
}

let activation: { promise: Promise<void>; isCurrent: () => boolean } | undefined;

/** 連打を合流し、プロジェクト切替やタブ離脱後の応答を破棄する。 */
export function switchToTab(tab: Tab): Promise<void> {
    hideToast();
    if (tab === 'llm' && activation?.isCurrent()) return activation.promise;
    changeTab(tab);
    if (tab !== 'llm') return Promise.resolve();

    const spreadsheetId = getState().data.spreadsheetId;
    let cancelled = false;
    const unsubscribe = subscribe(next => {
        if (next.ui.view !== 'screening' || next.ui.currentTab !== 'llm'
            || next.data.spreadsheetId !== spreadsheetId) {
            cancelled = true;
        }
    });
    const isCurrent = () => !cancelled;
    showLoading(true);
    const promise = (async () => {
        try {
            const loaded = await loadLlmFeature();
            if (!isCurrent()) return;
            await loaded.initializeLlmSection(isCurrent);
        } catch (error) {
            if (isCurrent()) reportFeatureLoadError(error, 'llm');
        }
    })().finally(() => {
        unsubscribe();
        if (activation?.promise === promise) {
            activation = undefined;
            showLoading(false);
        }
    });
    activation = { promise, isCurrent };
    return promise;
}
