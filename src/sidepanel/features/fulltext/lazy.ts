import { createLazyFeatureLoader } from '../../../lib/lazy-feature-loader';
import { t } from '../../../lib/i18n';
import { dom } from '../../dom';
import { getState, subscribe } from '../../store';
import { changeTab } from '../../store/compat';
import { hideToast } from '../../ui/feedback';
import { reportFeatureLoadError } from '../../ui/lazy-feature-feedback';

type FulltextFeatureModule = typeof import('./tab');
let feature: FulltextFeatureModule | undefined;

/** 本体を1チャンクへ集約し、リスナー登録は成功時の一度だけ行う。 */
export const loadFulltextFeature = createLazyFeatureLoader(async () => {
    const loaded = await import(/* webpackChunkName: "fulltext-feature" */ './tab');
    loaded.setupFulltextTabListeners();
    feature = loaded;
    return loaded;
});

/** タブボタンは sidepanel.ts が登録する。セクション内の操作は本体ロード後に登録する。 */
export function setupFulltextTabListeners(): void {
    // 初期表示から本体を読み込まないため、ここでのリスナー登録は不要。
}

function showLoading(loading: boolean): void {
    const section = dom.fulltextSection;
    let status = section.querySelector<HTMLElement>('.fulltext-feature-status');
    if (loading && !status) {
        status = document.createElement('div');
        status.className = 'fulltext-feature-status';
        status.setAttribute('role', 'status');
        section.prepend(status);
    }
    section.setAttribute('aria-busy', String(loading));
    if (status) {
        status.textContent = t('fulltext_featureLoading');
        status.classList.toggle('hidden', !loading);
    }
}

let activation: { promise: Promise<void>; isCurrent: () => boolean } | undefined;

/**
 * フルテキストタブを開く（sidepanel.ts のタブボタン・「全文タブへ進む」ボタンの両方から呼ぶ）。
 * 連打を合流し、タブ離脱・プロジェクト切替後の応答は破棄する。
 *
 * 現在の本体（features/fulltext/tab.ts）に、本体を読む前に判定できる「そもそも使えない」
 * ガード（件数・設定によるブロック）は無いため、ここでの事前判定は行わない。
 */
export function activateFulltextTab(): Promise<void> {
    hideToast();
    if (activation?.isCurrent()) return activation.promise;
    const spreadsheetId = getState().data.spreadsheetId;
    changeTab('fulltext');
    let cancelled = false;
    const unsubscribe = subscribe(next => {
        if (next.ui.view !== 'screening' || next.ui.currentTab !== 'fulltext'
            || next.data.spreadsheetId !== spreadsheetId) {
            cancelled = true;
        }
    });
    const isCurrent = () => !cancelled;
    showLoading(true);
    const promise = (async () => {
        try {
            const loaded = await loadFulltextFeature();
            if (!isCurrent()) return;
            loaded.initializeFulltextSection(isCurrent);
        } catch (error) {
            if (isCurrent()) reportFeatureLoadError(error, 'fulltext');
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

/**
 * 結果ビュー（features/fulltext/results.ts）の判定者チェックボックス選択の現在値。
 * features/manuscript.ts（初期バンドルに残る）が論文用テキスト生成の集計に使う。
 * 本体が未ロードなら null（フルテキストタブを一度も開いていない＝全員集計、既定と同じ）。
 */
export function getFulltextEnabledJudges(): Set<string> | null {
    return feature?.getEnabledJudgesSnapshot() ?? null;
}
