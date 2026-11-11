// 週次点検（.github/workflows/weekly-check.yml）が生存確認する組み込みモデル ID の一覧。
// 一覧の元は拡張機能のコードで、ここでは重複をまとめて出どころを付けるだけにする。
// MODEL_ID_MIGRATIONS のキー（旧 ID）は保存済み設定を書き換えるための値なので対象にしない。
import { AVAILABLE_MODELS, TIER_PROBE_MODEL } from '../../src/lib/gemini-api';
import { MODEL_ID_MIGRATIONS } from '../../src/lib/model-migrations';
import { CONSULT_MODELS } from '../../src/lib/help-consult/model';

export type CheckProvider = 'gemini' | 'openai' | 'anthropic' | 'typesafe' | 'openrouter';

export interface ModelToCheck {
    id: string;
    provider: CheckProvider;
    usedBy: string[];
}

export function listModelsToCheck(): ModelToCheck[] {
    const byId = new Map<string, ModelToCheck>();
    const add = (id: string, provider: CheckProvider, usedBy: string): void => {
        const existing = byId.get(id);
        if (existing) {
            if (!existing.usedBy.includes(usedBy)) existing.usedBy.push(usedBy);
            return;
        }
        byId.set(id, { id, provider, usedBy: [usedBy] });
    };

    const providerById = new Map<string, CheckProvider>();
    for (const model of AVAILABLE_MODELS) {
        // ローカル LLM は利用者の環境にあるもので、外部 API では確かめられない
        if (model.provider === 'local_llm') continue;
        providerById.set(model.id, model.provider);
        add(model.id, model.provider, 'AVAILABLE_MODELS');
    }
    for (const target of Object.values(MODEL_ID_MIGRATIONS)) {
        const provider = providerById.get(target);
        if (!provider) throw new Error(`MODEL_ID_MIGRATIONS の移行先が AVAILABLE_MODELS にありません: ${target}`);
        add(target, provider, 'MODEL_ID_MIGRATIONS の移行先');
    }
    for (const [company, id] of Object.entries(CONSULT_MODELS)) {
        const provider = providerById.get(id);
        if (!provider) throw new Error(`CONSULT_MODELS.${company} が AVAILABLE_MODELS にありません: ${id}`);
        add(id, provider, `CONSULT_MODELS.${company}`);
    }
    add(TIER_PROBE_MODEL, 'gemini', 'TIER_PROBE_MODEL');
    return [...byId.values()];
}
