import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「fulltext-page」（全文の判定ページ（PDF を開く別タブ src/fulltext/））。
 * このページはサイドパネルとは別の画面で、ランナーも別に組み立てる（src/fulltext/guide-feature.ts）。
 * 手順の対象は src/fulltext/fulltext.html の data-tour。
 */

/** このツアー固有のイベント名。全文の判定ページが emitGuideEvent で送る（送出元は src/fulltext/decision-controller.ts）。 */
export type FulltextPageEvent =
    | 'fulltext-decision-saved' // 判定（Include / Exclude / Maybe）の保存に成功した
    | 'fulltext-exclude-chosen'; // Exclude を選び、除外理由の欄を出した（理由が選ばれるまで保存はされない）
/**
 * このツアー固有の条件名。計算は src/fulltext/guide-conditions.ts（サイドパネル側の
 * conditions/fulltext-page.ts は、サイドパネルでは評価されないので全部偽を返す）。
 */
export type FulltextPageCondition =
    | 'reason-select-shown' // 除外理由の選択肢が画面に出ている
    | 'reason-select-hidden'; // 除外理由の選択肢が出ていない（Exclude が選ばれていない）

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'fulltext-page');

export const FULLTEXT_PAGE_TOUR: TourFor<FulltextPageEvent, FulltextPageCondition> = {
    id: 'fulltext-page',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'participant',
    page: 'fulltext',
    steps: [
        {
            id: 'biblio',
            target: 'ft-biblio',
            textKey: stepKey(BASE, 'biblio'),
            advance: { type: 'next' },
        },
        {
            id: 'pdf',
            target: 'ft-pdf-toolbar',
            textKey: stepKey(BASE, 'pdf'),
            advance: { type: 'next' },
        },
        {
            id: 'criteria',
            target: 'ft-criteria-btn',
            textKey: stepKey(BASE, 'criteria'),
            advance: { type: 'next' },
        },
        {
            // 押すと判定が保存され（Include / Maybe）、Exclude は理由の欄が出る。実データが変わるので押さずに次へも進める
            id: 'decision',
            target: 'ft-decision-buttons',
            textKey: stepKey(BASE, 'decision'),
            advance: { type: 'events', events: ['fulltext-decision-saved', 'fulltext-exclude-chosen'], optional: true },
            scroll: 'if-hidden',
        },
        {
            // 除外理由の欄が出ていないとき（まだ Exclude を選んでいない）は、何をすると出るかだけを伝える
            id: 'reason-info',
            target: 'ft-decision-buttons',
            textKey: stepKey(BASE, 'reason-info'),
            advance: { type: 'next' },
            skipIf: 'reason-select-shown',
            scroll: 'if-hidden',
        },
        {
            // 理由を選ぶと保存して次の候補へ進む（実データが変わる）ので、押さずに次へも進める
            id: 'reason',
            target: 'ft-reason-area',
            textKey: stepKey(BASE, 'reason'),
            advance: { type: 'events', events: ['fulltext-decision-saved'], optional: true },
            skipIf: 'reason-select-hidden',
            scroll: 'if-hidden',
        },
        {
            id: 'context',
            target: 'ft-context',
            textKey: stepKey(BASE, 'context'),
            advance: { type: 'next' },
        },
        {
            id: 'evidence',
            target: 'ft-annotations',
            textKey: stepKey(BASE, 'evidence'),
            advance: { type: 'next' },
        },
        {
            id: 'navigate',
            target: 'ft-nav',
            textKey: stepKey(BASE, 'navigate'),
            advance: { type: 'next' },
        },
        {
            id: 'finish',
            target: 'ft-help',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
