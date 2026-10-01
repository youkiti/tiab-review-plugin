import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「duplicate-review」（重複の確認）。
 * 手動タブの下部にある「重複の確認」セクションと、重複候補の比較画面（アプリのダイアログ）を案内する。
 * 比較画面の中の要素（比較の表、3つの選択ボタン、一括適用）も対象にする（ダイアログの前面に枠とカードが出る）。
 * 統合は片方の文献を論理削除する操作なので、比較画面を開く手順と選ぶ手順を `optional` にする。
 * 一括適用は全組に一度に効くので、押せない説明だけの手順にする。
 */

/** このツアー固有のイベント名 */
export type DuplicateReviewEvent =
    | 'duplicates-rescanned' // 「重複を再スキャン」が成功し、未確認件数の読み直しまで済んだ
    | 'duplicate-review-opened' // 重複候補の比較画面を開いた
    | 'duplicate-review-closed' // 重複候補の比較画面を閉じた
    | 'duplicate-pair-resolved'; // 比較画面で1組の判定（左を残す／右を残す／別々の文献）が確定した
/** このツアー固有の条件名。計算は sidepanel/features/guide/conditions/duplicate-review.ts */
export type DuplicateReviewCondition =
    | 'duplicate-manual-tab-open' // 手動タブを開いている
    | 'no-duplicate-candidates' // 未確認の重複候補が0件と分かっている
    | 'duplicate-candidates-present' // 未確認の重複候補が0件ではない（件数が未取得の間も含む）
    | 'duplicate-modal-closed' // 比較画面が開いていない
    | 'duplicate-no-hint-needed'; // 比較画面を一度開いた、または見る候補が無い

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'duplicate-review');

export const DUPLICATE_REVIEW_TOUR: TourFor<DuplicateReviewEvent, DuplicateReviewCondition> = {
    id: 'duplicate-review',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    steps: [
        {
            id: 'open-tab',
            target: 'duplicate-tab-manual',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-screening'] },
            skipIf: 'duplicate-manual-tab-open',
        },
        {
            id: 'section',
            target: 'duplicate-section',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'section'),
            advance: { type: 'next' },
        },
        {
            id: 'rescan',
            target: 'duplicate-rescan',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'rescan'),
            advance: { type: 'events', events: ['duplicates-rescanned'], optional: true },
        },
        {
            id: 'no-candidates',
            target: 'duplicate-section',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'no-candidates'),
            advance: { type: 'next' },
            skipIf: 'duplicate-candidates-present',
        },
        {
            id: 'open-review',
            target: 'duplicate-open',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'open-review'),
            advance: { type: 'events', events: ['duplicate-review-opened'], optional: true },
            skipIf: 'no-duplicate-candidates',
        },
        {
            id: 'compare',
            target: 'duplicate-compare',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'compare'),
            advance: { type: 'next' },
            skipIf: 'duplicate-modal-closed',
        },
        {
            id: 'choose',
            target: 'duplicate-actions',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'choose'),
            advance: { type: 'events', events: ['duplicate-pair-resolved'], optional: true },
            skipIf: 'duplicate-modal-closed',
        },
        {
            id: 'bulk',
            target: 'duplicate-bulk',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'bulk'),
            advance: { type: 'next' },
            blockTarget: true,
            skipIf: 'duplicate-modal-closed',
        },
        {
            id: 'not-opened',
            target: 'duplicate-open',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'not-opened'),
            advance: { type: 'next' },
            skipIf: 'duplicate-no-hint-needed',
        },
        {
            id: 'after-review',
            target: 'duplicate-section',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'after-review'),
            advance: { type: 'next' },
            skipIf: 'no-duplicate-candidates',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
