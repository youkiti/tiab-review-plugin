/**
 * ツアーの提案の帯（画面の上部に出す小さな帯）の見た目。サイドパネルのタブの提案と、
 * 全文の判定ページの初回の提案が同じ見た目・同じ data-guide-action（start / dismiss）になるよう、ここで組み立てる。
 * 帯を出す場所・出すかどうかの判定・押したときの処理は、画面ごとの入口が持つ。
 */
import { t } from '../lib/i18n';
import type { TourDefinition } from '../lib/guide/tours';

/** ボタンを作る。data-guide-action に action を付け、クリックで onClick を呼ぶ。 */
export function createGuideButton(action: string, label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.guideAction = action;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

/** ツアーの見出しと「表示しない」「ツアーで進める」の2つのボタンだけの帯を作る。 */
export function buildTourSuggestBand(
    options: { id: string; tour: TourDefinition; onDismiss: () => void; onStart: () => void },
): HTMLElement {
    const { id, tour, onDismiss, onStart } = options;
    const band = document.createElement('div');
    band.id = id;
    band.className = 'guide-suggest-banner guide-tab-suggest';
    band.dataset.guideTour = tour.id;

    const title = document.createElement('div');
    title.className = 'guide-suggest-title';
    title.textContent = t(tour.titleKey);

    const actions = document.createElement('div');
    actions.className = 'guide-suggest-dismissals';
    actions.append(
        createGuideButton('dismiss', t('guide_tabSuggestDismiss'), 'btn btn-outline btn-xsmall', onDismiss),
        createGuideButton('start', t('guide_tabSuggestStart'), 'btn btn-primary btn-xsmall', onStart),
    );
    band.append(title, actions);
    return band;
}
