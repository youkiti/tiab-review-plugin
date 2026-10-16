/** 公開一覧のモデルと、100万トークンあたりの米ドル単価。 */
export interface OpenRouterModel {
    id: string;
    name?: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
}

export interface OpenRouterModelsCache {
    models: OpenRouterModel[];
    fetchedAt: number;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function price(value: unknown): number | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function perMillion(value: number | undefined): number | undefined {
    if (value === undefined || value < 0) {
        return undefined;
    }
    const rounded = Math.round(value * 1e6 * 1e6) / 1e6;
    return Number.isFinite(rounded) ? rounded : undefined;
}

/** 認証不要の公開一覧から、テキストを入出力できるモデルを取得する。 */
export async function fetchOpenRouterModels(fetchImpl: typeof fetch = globalThis.fetch): Promise<OpenRouterModel[]> {
    const response = await fetchImpl('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
        throw new Error(`OpenRouter モデル一覧の取得失敗: ${response.status}`);
    }
    const body = record(await response.json());
    if (!Array.isArray(body.data)) {
        throw new Error('OpenRouter モデル一覧の形式が不正です');
    }
    return body.data.flatMap((entry): OpenRouterModel[] => {
        const model = record(entry);
        if (typeof model.id !== 'string' || !model.id.trim()) {
            return [];
        }
        const pricing = record(model.pricing);
        const input = price(pricing.prompt);
        const output = price(pricing.completion);
        if ((input !== undefined && input < 0) || (output !== undefined && output < 0)) {
            return [];
        }
        const architecture = record(model.architecture);
        for (const modalities of [architecture.input_modalities, architecture.output_modalities]) {
            if (Array.isArray(modalities) && !modalities.includes('text')) {
                return [];
            }
        }
        return [{
            id: model.id,
            name: typeof model.name === 'string' ? model.name : undefined,
            inputPerMillion: perMillion(input),
            outputPerMillion: perMillion(output),
        }];
    });
}
