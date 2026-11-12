// 全文タブの Decisions 判定で、失敗文言と保存する確率を調整する。
import { judgeFulltextViaGeminiDecision, GeminiDecisionInputTooLongError } from '../../../lib/gemini-decision-fulltext';
import { PdfTooLargeError, LlmCallError, classifyFulltextAiFailure } from '../../../lib/fulltext-ai-failures';
import { t } from '../../../lib/i18n';
import type { ExcludeReasonItem } from '../../../lib/exclude-reasons';
export {
    buildGeminiDecisionFulltextPromptRecord,
    GEMINI_DECISION_FULLTEXT_INCLUDE_THRESHOLD,
    GEMINI_DECISION_FULLTEXT_PROMPT_VERSION,
} from '../../../lib/gemini-decision-fulltext';

export async function judgeGeminiDecisionPdf(
    bytes: Uint8Array,
    params: { model: string; title: string; screeningPrompt: string; reasonItems: readonly ExcludeReasonItem[] }
) {
    try {
        const result = await judgeFulltextViaGeminiDecision({ ...params, bytes, outputLanguage: 'ja' });
        return {
            ...result,
            evidenceTruncated: false,
            note: { exclude_reason_probabilities: result.reasonProbabilities },
        };
    } catch (err) {
        // 上限超えは AI 呼び出しの失敗に数える（共有の分類関数に名前の判定を足さず、サイドパネルの初期 JS を増やさない）。
        if (err instanceof GeminiDecisionInputTooLongError) {
            throw new LlmCallError(err, t('ftPage_aiErrDecisionInputTooLong'));
        }
        if (err instanceof PdfTooLargeError) {
            throw new PdfTooLargeError(t('ftPage_aiErrDecisionPdfTooLarge'));
        }
        throw classifyFulltextAiFailure(err) === 'other' ? new LlmCallError(err) : err;
    }
}
