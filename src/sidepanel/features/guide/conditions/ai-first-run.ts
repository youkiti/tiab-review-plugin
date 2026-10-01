/**
 * ツアー「ai-first-run」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/ai-first-run.ts の AiFirstRunCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 *
 * AI タブの状態は、画面側が持つ DOM の表示状態（sidepanel.html の要素）から読む。
 * AI タブ本体は遅延チャンクで、その内部の状態を直接 import できないため。
 */
import type { AiFirstRunCondition } from '../../../../lib/guide/tours/ai-first-run';

/** 要素があり、hidden クラスが付いていない（表示対象になっている）か */
function isShown(id: string): boolean {
    const element = document.getElementById(id);
    return element !== null && !element.classList.contains('hidden');
}

export function computeAiFirstRunConditions(): Record<AiFirstRunCondition, boolean> {
    // 選んでいるモデルのプロバイダ行（`.emphasized`）のチップが「設定済み」（`.ok`）になっているか。
    // チップは AI タブを開くたび、キーの保存・削除のたびに更新される（features/llm/api-key.ts）
    const keyReady = document.querySelector('#llm-providers-card .provider-row.emphasized .provider-chip.ok') !== null;
    const hasPrompt = isShown('screening-prompt-input');
    const hasThreshold = isShown('threshold-section');
    return {
        'ai-tab-open': isShown('llm-section'),
        'ai-key-ready': keyReady,
        'ai-has-prompt': hasPrompt,
        'ai-no-prompt': !hasPrompt,
        'ai-has-threshold': hasThreshold,
        'ai-no-threshold': !hasThreshold,
    };
}
