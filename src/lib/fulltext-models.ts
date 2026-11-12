// 全文判定で利用できるモデルを、Gemini、TypeSafe の順で選ぶ。
import { filterFulltextGeminiModels } from './gemini-decision-model';

export const FULLTEXT_TYPESAFE_MODEL_IDS = ['jev-1.14.0'] as const;

export function isFulltextTypeSafeModel(id: string): boolean {
    return FULLTEXT_TYPESAFE_MODEL_IDS.some(modelId => modelId === id);
}

export function filterFulltextModels<T extends { id: string; provider: string }>(models: readonly T[]): T[] {
    return [
        ...filterFulltextGeminiModels(models),
        ...models.filter(model => model.provider === 'typesafe' && isFulltextTypeSafeModel(model.id)),
    ];
}
