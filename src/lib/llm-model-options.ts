import { findModelConfig, type ModelOption } from './gemini-api';
import type { OpenRouterModel } from './openrouter-models';

export interface ModelGroup {
    label: string;
    labelKey?: string;
    models: ModelOption[];
}

/** 一覧外のモデルIDは、Enter で明示的に確定したときだけ受け付ける。 */
export function resolveModelEntry(
    value: string,
    candidateIds: readonly string[],
    explicit: boolean,
): { accept: string } | { revert: true; warn: boolean } {
    const id = value.trim();
    if (id && (candidateIds.includes(id) || (explicit && findModelConfig(id) !== null))) {
        return { accept: id };
    }
    return { revert: true, warn: explicit && id.length > 0 };
}

/** 組み込み・登録モデルを優先し、取得した一覧を独立したグループにする。 */
export function buildModelGroups(
    builtIn: readonly ModelOption[],
    custom: readonly ModelOption[],
    fetched: readonly OpenRouterModel[],
): ModelGroup[] {
    const ids = new Set(builtIn.map(model => model.id));
    const models = [...builtIn];
    for (const model of custom) {
        if (model.custom && !ids.has(model.id)) {
            models.push(model);
            ids.add(model.id);
        }
    }
    const remote: ModelOption[] = [];
    for (const model of fetched) {
        if (!ids.has(model.id)) {
            remote.push({
                id: model.id,
                name: model.name || model.id,
                provider: 'openrouter',
                config: { temperature: 0 },
            });
            ids.add(model.id);
        }
    }
    return [
        { label: 'Gemini', models: models.filter(model => model.provider === 'gemini') },
        { label: 'OpenRouter', models: models.filter(model => model.provider === 'openrouter') },
        { label: 'OpenRouter', labelKey: 'llm_fetchedModels', models: remote },
        { label: 'OpenAI', models: models.filter(model => model.provider === 'openai') },
        { label: 'Anthropic', models: models.filter(model => model.provider === 'anthropic') },
        { label: 'TypeSafe', models: models.filter(model => model.provider === 'typesafe') },
    ].filter(group => group.models.length > 0);
}

/** 表示名は呼び出し側で翻訳し、ID とともに部分一致で検索する。 */
export function filterModelGroups(
    groups: readonly ModelGroup[],
    query: string,
    displayName: (model: ModelOption) => string = model => model.name,
): ModelGroup[] {
    const search = query.trim().toLowerCase();
    return groups.map(group => ({
        ...group,
        models: group.models.filter(model => !search
            || model.id.toLowerCase().includes(search)
            || displayName(model).toLowerCase().includes(search)),
    })).filter(group => group.models.length > 0);
}
