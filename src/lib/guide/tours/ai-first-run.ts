import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「ai-first-run」（AI 判定の初回）。
 * AI タブを開き、モデル・API キー・レビュー基準・対象を整えて一括実行し、閾値を確定するまでを案内する。
 * 費用がかかる・実データが変わる操作（キーの保存、基準の最適化・保存、一括実行、閾値の確定）の手順は
 * optional（押さずに次へ進める）にして、ツアーを見ただけで API の利用料や書き込みが起きないようにする。
 */

/** このツアー固有のイベント名（features/llm/** の各操作が成功して確定した後に emitGuideEvent で投げる）。 */
export type AiFirstRunEvent =
    | 'ai-key-saved' // API キーの確認と保存に成功した
    | 'ai-criteria-optimized' // 基準の最適化に成功し、プロンプトが画面に出た
    | 'ai-criteria-saved' // 基準（プロンプト）をシートへ保存した
    | 'ai-batch-finished' // 一括実行が（中断せずに）終わった
    | 'ai-threshold-confirmed'; // 閾値を確定して保存した
/** このツアー固有の条件名。計算は sidepanel/features/guide/conditions/ai-first-run.ts。 */
export type AiFirstRunCondition =
    | 'ai-tab-open' // AI タブを開いている
    | 'ai-key-ready' // 選んでいるモデルのプロバイダのキーが設定済み
    | 'ai-has-prompt' // 最適化されたプロンプトの欄が出ている
    | 'ai-no-prompt'
    | 'ai-has-threshold' // 閾値の確定欄が出ている（実行の結果がある）
    | 'ai-no-threshold';

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'ai-first-run');

export const AI_FIRST_RUN_TOUR: TourFor<AiFirstRunEvent, AiFirstRunCondition> = {
    id: 'ai-first-run',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-llm',
    steps: [
        {
            id: 'open-tab',
            target: 'tab-llm',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-llm'] },
            skipIf: 'ai-tab-open',
        },
        {
            id: 'model',
            target: 'ai-model',
            textKey: stepKey(BASE, 'model'),
            advance: { type: 'next' },
        },
        {
            id: 'keys',
            target: 'ai-keys',
            textKey: stepKey(BASE, 'keys'),
            advance: { type: 'events', events: ['ai-key-saved'], optional: true },
            skipIf: 'ai-key-ready',
        },
        {
            id: 'protocol',
            target: 'ai-protocol',
            textKey: stepKey(BASE, 'protocol'),
            advance: { type: 'next' },
        },
        {
            id: 'optimize',
            target: 'ai-optimize',
            textKey: stepKey(BASE, 'optimize'),
            advance: { type: 'events', events: ['ai-criteria-optimized'], optional: true },
        },
        {
            id: 'prompt',
            target: 'ai-prompt',
            textKey: stepKey(BASE, 'prompt'),
            advance: { type: 'events', events: ['ai-criteria-saved'], optional: true },
            skipIf: 'ai-no-prompt',
            scroll: 'start', // 基準の表示・プロンプト・保存ボタンまで縦に長いので、上端へ寄せてカードを下に出す
        },
        {
            // プロンプトがまだ無いときの代わりの手順（飛ばしっぱなしにせず、何をすれば出るかを伝える）
            id: 'prompt-wait',
            target: 'ai-optimized',
            textKey: stepKey(BASE, 'prompt-wait'),
            advance: { type: 'next' },
            skipIf: 'ai-has-prompt',
        },
        {
            id: 'batch-settings',
            target: 'ai-batch-settings',
            textKey: stepKey(BASE, 'batch-settings'),
            advance: { type: 'next' },
        },
        {
            id: 'batch-run',
            target: 'ai-batch-run',
            textKey: stepKey(BASE, 'batch-run'),
            advance: { type: 'events', events: ['ai-batch-finished'], optional: true },
        },
        {
            id: 'threshold',
            target: 'ai-threshold',
            textKey: stepKey(BASE, 'threshold'),
            advance: { type: 'events', events: ['ai-threshold-confirmed'], optional: true },
            skipIf: 'ai-no-threshold',
        },
        {
            // 実行の結果がまだ無いときの代わりの手順
            id: 'threshold-wait',
            target: 'ai-batch-run',
            textKey: stepKey(BASE, 'threshold-wait'),
            advance: { type: 'next' },
            skipIf: 'ai-has-threshold',
        },
        {
            id: 'history',
            target: 'ai-history',
            textKey: stepKey(BASE, 'history'),
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
