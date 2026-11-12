// 全文タブの TypeSafe 判定で、PDF の本文抽出と送信記録を調整する。
import { prepareFulltextForTypeSafe } from '../../../lib/pdf-text-extract';
import { judgeFulltextViaTypeSafe, TypeSafeInputTooLongError } from '../../../lib/typesafe-fulltext';
import { PdfReadError, PdfNoTextError, LlmCallError, classifyFulltextAiFailure } from '../../../lib/fulltext-ai-failures';
import { t } from '../../../lib/i18n';
import type { ExcludeReasonItem } from '../../../lib/exclude-reasons';

export async function judgeTypeSafePdf(
    bytes: Uint8Array,
    params: { model: string; title: string; screeningPrompt: string; reasonItems: readonly ExcludeReasonItem[] }
) {
    const { extractPdfText } = await import(/* webpackChunkName: "pdf-image-only" */ '../../../lib/pdf-image-only');
    let extracted: Awaited<ReturnType<typeof extractPdfText>>;
    try {
        extracted = await extractPdfText(bytes);
    } catch (err) {
        throw new PdfReadError(err);
    }
    if (extracted.imageOnly) {
        throw new PdfNoTextError(t('ftPage_aiErrNoText'));
    }
    const prepared = prepareFulltextForTypeSafe(extracted.text);
    try {
        const result = await judgeFulltextViaTypeSafe({ ...params, fullText: prepared.text, outputLanguage: 'ja' });
        return {
            ...result,
            evidenceTruncated: false,
            note: {
                exclude_reason_probabilities: result.reasonProbabilities,
                fulltext_chars_sent: prepared.text.length,
                fulltext_truncated: prepared.truncated,
                references_removed: prepared.referencesRemoved,
            },
        };
    } catch (err) {
        if (err instanceof TypeSafeInputTooLongError) {
            throw new TypeSafeInputTooLongError(t('ftPage_aiErrInputTooLong'));
        }
        throw classifyFulltextAiFailure(err) === 'other' ? new LlmCallError(err) : err;
    }
}
