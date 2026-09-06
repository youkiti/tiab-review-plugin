import { createMlFeatureLoader } from '../../../lib/ml-lazy-loader';
import { t } from '../../../lib/i18n';
import { canUseCmhStopping, CMH_DEFAULTS } from '../../../lib/ml/cmh-defaults';
import { state } from '../../state';
import { dom } from '../../dom';
import { subscribe } from '../../store';
import { changeTab } from '../../store/compat';
import { showToast } from '../../ui/feedback';

type MlFeatureModule = typeof import('./actions') & typeof import('./render');
let feature: MlFeatureModule | undefined;

// Issue #155: actions と render は splitChunks:false 下では中身が重複するため、同じ
// webpackChunkName で1チャンクに統合する。両方揃ってから一度だけ配線し、失敗したimportは
// 次回再試行する。
export const loadMlFeature: () => Promise<MlFeatureModule> = createMlFeatureLoader(async () => {
    const [actions, render] = await Promise.all([
        import(/* webpackChunkName: "ml-feature" */ './actions'),
        import(/* webpackChunkName: "ml-feature" */ './render'),
    ]);
    actions.initMlHandlers();
    feature = { ...actions, ...render };
    return feature;
});

function showLoading(loading: boolean): void {
    const section = dom.mlSection;
    let status = section.querySelector<HTMLElement>('.ml-feature-status');
    if (loading && !status) {
        status = document.createElement('div');
        status.className = 'ml-feature-status';
        status.setAttribute('role', 'status');
        section.prepend(status);
    }
    section.setAttribute('aria-busy', String(loading));
    if (status) {
        status.textContent = t('ml_featureLoading');
        status.classList.toggle('hidden', !loading);
    }
}

let activation: { promise: Promise<boolean>; isCurrent: () => boolean } | undefined;

/** 初回タブ操作を受け取り、連打は合流、離脱した操作は完了しても画面を戻さない。 */
export function activateMlTab(): Promise<boolean> {
    if (activation?.isCurrent()) return activation.promise;
    // Issue #155: 件数ガードはチャンク・Workerの読込より前に判定する。ここで弾けば
    // タブも変えず、空の「ML機能を読み込んでいます…」表示も出さない。
    const totalRecords = state.references.length;
    if (!canUseCmhStopping(totalRecords)) {
        showToast(t('ml_minRecordsError', [String(CMH_DEFAULTS.minRecords), String(totalRecords)]), 5000);
        return Promise.resolve(false);
    }
    const previousTab = state.currentTab;
    const spreadsheetId = state.spreadsheetId;
    let cancelled = false;
    changeTab('ml');
    showLoading(true);
    const unsubscribe = subscribe(next => {
        if (next.ui.view !== 'screening' || next.ui.currentTab !== 'ml'
            || next.data.spreadsheetId !== spreadsheetId) {
            cancelled = true;
        }
    });
    const isCurrent = () => !cancelled;
    const promise = (async () => {
        try {
            const loaded = await loadMlFeature();
            if (!isCurrent()) return false;
            const success = await loaded.activateMlTab(isCurrent);
            if (!success && isCurrent()) changeTab(previousTab);
            return success;
        } catch (error) {
            if (isCurrent()) changeTab(previousTab);
            throw error;
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

/** チャンク読込失敗か、それ以外（Worker初期化失敗・拡張コンテキスト無効化時のstorageアクセス失敗など）かで文言を分ける。 */
export function reportMlLoadError(error: unknown): void {
    const isChunkLoadError = error instanceof Error
        && (error.name === 'ChunkLoadError' || /Loading chunk/i.test(error.message));
    if (isChunkLoadError) {
        showToast(t('ml_featureLoadFailed'), 5000);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    showToast(t('ml_activationFailed', [message]), 5000);
}

function delegate(action: (loaded: MlFeatureModule) => void): void {
    if (feature) {
        action(feature);
    } else {
        void loadMlFeature().then(action).catch(reportMlLoadError);
    }
}

export function handleMlSearchInput(): void {
    delegate(loaded => loaded.handleMlSearchInput());
}

export function addMlKeyword(type: 'include' | 'exclude'): void {
    delegate(loaded => loaded.addMlKeyword(type));
}

export function renderMlSection(): void {
    // 設定変更による再描画だけで、未使用のMLを読み込まない。
    feature?.renderMlSection();
}

export function handleMlKeydown(event: KeyboardEvent): void {
    // preventDefaultをイベント中に呼べるよう、読込済みの本体へ同期的に委譲する。
    if (!feature || activation || state.currentTab !== 'ml') return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (!['i', 'e', 'arrowleft', 'k', 'arrowright', 'j'].includes(event.key.toLowerCase())) return;
    feature.handleMlKeydown(event);
}
