import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「fulltext-setup」（全文の準備）。全文タブの最初の段取り（候補ルール・担当・チェックリスト・入手状況・
 * PDF の補い方）を案内する。PDF の一括検索（実際に外部へ問い合わせる）は optional（押さずに次へ進める）。
 */

/** このツアー固有のイベント名 */
export type FulltextSetupEvent =
    | 'fulltext-fetch-finished' // 「フリー全文を一括検索」が最後まで走った（中断した場合は除く）
    | 'fulltext-page-opened'; // 候補カードから全文の判定ページを開いた
/** このツアー固有の条件名。条件の計算は sidepanel/features/guide/conditions/fulltext-setup.ts */
export type FulltextSetupCondition =
    | 'on-fulltext-tab' // 全文タブを開いている
    | 'key-opened' // Blind のキーが開封済み
    | 'key-unopened' // Blind のキーが未開封
    | 'has-fulltext-cards' // 候補一覧に候補カードが出ている
    | 'no-fulltext-cards'; // 候補一覧に候補カードが無い

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'fulltext-setup');

export const FULLTEXT_SETUP_TOUR: TourFor<FulltextSetupEvent, FulltextSetupCondition> = {
    id: 'fulltext-setup',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-fulltext',
    steps: [
        {
            id: 'open-tab',
            target: 'tab-fulltext',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-fulltext'] },
            skipIf: 'on-fulltext-tab',
        },
        {
            id: 'views',
            target: 'fulltext-views',
            textKey: stepKey(BASE, 'views'),
            advance: { type: 'next' },
        },
        // 候補ルールは、キーを開封してから決める（未開封の間は自分の Include を仮の候補として出す）
        {
            id: 'rule',
            target: 'fulltext-rule',
            textKey: stepKey(BASE, 'rule'),
            advance: { type: 'next' },
            skipIf: 'key-unopened',
        },
        {
            id: 'rule-pending',
            target: 'fulltext-rule',
            textKey: stepKey(BASE, 'rule-pending'),
            advance: { type: 'next' },
            skipIf: 'key-opened',
        },
        {
            id: 'assignment',
            target: 'fulltext-assignment',
            textKey: stepKey(BASE, 'assignment'),
            advance: { type: 'next' },
        },
        {
            id: 'checklist',
            target: 'fulltext-checklist',
            textKey: stepKey(BASE, 'checklist'),
            advance: { type: 'next' },
        },
        {
            id: 'fetch',
            target: 'fulltext-retrieval',
            textKey: stepKey(BASE, 'fetch'),
            advance: { type: 'events', events: ['fulltext-fetch-finished'], optional: true },
        },
        // 候補が1件も無いと、次の2つの手順で指す候補カードが無い。何をすれば出るかを伝える
        {
            id: 'no-candidates',
            target: 'fulltext-list',
            textKey: stepKey(BASE, 'no-candidates'),
            advance: { type: 'next' },
            skipIf: 'has-fulltext-cards',
        },
        {
            id: 'missing',
            target: 'fulltext-card',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'missing'),
            advance: { type: 'next' },
            skipIf: 'no-fulltext-cards',
            scroll: 'if-hidden',
        },
        {
            id: 'drive-import',
            target: 'fulltext-drive-import',
            textKey: stepKey(BASE, 'drive-import'),
            advance: { type: 'next' },
            blockTarget: true,
        },
        {
            id: 'open-page',
            target: 'fulltext-card',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'open-page'),
            advance: { type: 'events', events: ['fulltext-page-opened'], optional: true },
            skipIf: 'no-fulltext-cards',
            scroll: 'if-hidden',
        },
        // 全文タブには ❓（ツアー一覧）が無いので、この画面の「?」を指す
        {
            id: 'finish',
            target: 'fulltext-help',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
