import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「fulltext-results」（判定後レビュー）。全文タブの「判定後レビュー」（判定者の選択 → PRISMA の集計 →
 * 不一致の解消（裁定・裁定メモ）→ CSV/RIS エクスポート）を案内する。
 * キーの開封は押させない（プロジェクト全体に効くため）。キーが未開封の間は不一致が見えないので、
 * 「開封したらもう一度開く」と伝える手順（key-closed）を置く。
 * 裁定の確定は実データを変えるので optional（押さずに次へ進める）。
 */

/** このツアー固有のイベント名 */
export type FulltextResultsEvent =
    | 'fulltext-results-shown' // 全文タブの表示が「判定後レビュー」になった
    | 'fulltext-conflict-opened' // 不一致の項目（details）を開いた
    | 'fulltext-adjudicated'; // 裁定を確定して保存できた
/**
 * このツアー固有の条件名。条件の計算は sidepanel/features/guide/conditions/fulltext-results.ts。
 * 条件はツアー間で合成されるので、ほかのツアーの条件名と衝突しないよう `results-` を付ける。
 */
export type FulltextResultsCondition =
    | 'results-on-fulltext-tab' // 全文タブを開いている
    | 'results-shown' // 全文タブの表示が「判定後レビュー」
    | 'results-key-opened' // Blind のキーが開封済み
    | 'results-conflict-or-key-closed' // 未解消の不一致が表示されている、またはキー未開封
    | 'results-no-conflict'; // 未解消の不一致が表示されていない（キー未開封を含む）

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'fulltext-results');

export const FULLTEXT_RESULTS_TOUR: TourFor<FulltextResultsEvent, FulltextResultsCondition> = {
    id: 'fulltext-results',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    // suggestOn は付けない（tab-opened-fulltext は fulltext-setup が使っている）
    steps: [
        {
            id: 'open-tab',
            target: 'tab-fulltext',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-fulltext'] },
            skipIf: 'results-on-fulltext-tab',
        },
        {
            id: 'open-results',
            target: 'fulltext-mode-results',
            textKey: stepKey(BASE, 'open-results'),
            advance: { type: 'events', events: ['fulltext-results-shown'] },
            skipIf: 'results-shown',
        },
        {
            id: 'judges',
            target: 'fulltext-judges',
            textKey: stepKey(BASE, 'judges'),
            advance: { type: 'next' },
        },
        {
            id: 'prisma',
            target: 'fulltext-prisma',
            textKey: stepKey(BASE, 'prisma'),
            advance: { type: 'next' },
        },
        // キーの開封はプロジェクト全体に効くので押させず、説明だけにする
        {
            id: 'key-closed',
            target: 'fulltext-prisma',
            textKey: stepKey(BASE, 'key-closed'),
            advance: { type: 'next' },
            skipIf: 'results-key-opened',
        },
        {
            id: 'no-conflict',
            target: 'fulltext-prisma',
            textKey: stepKey(BASE, 'no-conflict'),
            advance: { type: 'next' },
            skipIf: 'results-conflict-or-key-closed',
        },
        {
            id: 'conflicts',
            target: 'fulltext-conflicts',
            textKey: stepKey(BASE, 'conflicts'),
            advance: { type: 'next' },
            skipIf: 'results-no-conflict',
        },
        // 開くと次の手順の対象（裁定のコントロール）が見えるので、optional にしない
        {
            id: 'open-item',
            target: 'fulltext-conflict-item',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'open-item'),
            advance: { type: 'events', events: ['fulltext-conflict-opened'] },
            skipIf: 'results-no-conflict',
        },
        // 裁定の確定は実データを変えるので、押さずに次へも出す
        {
            id: 'adjudicate',
            target: 'fulltext-adjudication',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'adjudicate'),
            advance: { type: 'events', events: ['fulltext-adjudicated'], optional: true },
            skipIf: 'results-no-conflict',
        },
        {
            id: 'export',
            target: 'fulltext-export',
            textKey: stepKey(BASE, 'export'),
            advance: { type: 'next' },
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
