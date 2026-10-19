// 論文用の記述は採用された判定と実送信設定から組み立てる。
import type { Decision } from './types';
import { getModelGenerationSettings, sentGenerationSettings } from './model-generation-settings';
import { PROMPT_VERSION } from './prompt-templates';

function noteVersions(note: string): { model?: string; prompt?: string } {
    try {
        const parsed = JSON.parse(note);
        if (parsed?.type === 'llm') {
            return {
                model: typeof parsed.model_version === 'string' ? parsed.model_version : undefined,
                prompt: typeof parsed.prompt_version === 'string' ? parsed.prompt_version : undefined,
            };
        }
    } catch {
        // 過去の自由記述メモには版の記録がない。
    }
    return {};
}

export function buildManuscriptAiSentence(decisions: readonly Decision[], total: number, threshold: number): string {
    const judged = decisions.filter(d => (d.screening_phase ?? 'tiab') === 'tiab'
        && d.reviewer_id.startsWith('llm:') && d.decision !== 'pending');
    if (!judged.length) {
        return '';
    }
    const models = new Map<string, Set<string>>();
    const prompts = new Set<string>();
    for (const decision of judged) {
        const body = decision.reviewer_id.slice(4);
        const at = body.lastIndexOf('@');
        const model = at > 0 ? body.slice(0, at) : body;
        const versions = models.get(model) ?? new Set<string>();
        const note = noteVersions(decision.note ?? '');
        if (note.model) {
            versions.add(note.model);
        }
        prompts.add(note.prompt || PROMPT_VERSION);
        models.set(model, versions);
    }
    const descriptions = [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, versions]) => {
        const config = getModelGenerationSettings(model);
        const sent = sentGenerationSettings(model, config);
        const settings: string[] = [];
        if (sent.temperature !== undefined) {
            settings.push(`temperature ${sent.temperature}`);
        }
        if (sent.topP !== undefined) {
            settings.push(`top-p ${sent.topP}`);
        }
        if (sent.thinkingLevel) {
            settings.push(`thinking level ${sent.thinkingLevel.toLowerCase()}`);
        }
        if (sent.reasoning_effort) {
            settings.push(`${config.provider === 'anthropic' ? 'effort' : 'reasoning effort'} ${sent.reasoning_effort}`);
        }
        const version = versions.size ? ` [model version reported by the API: ${[...versions].sort().join(', ')}]` : '';
        return model + version + (settings.length ? ` (${settings.join(', ')})` : '');
    });
    const count = new Set(judged.map(d => d.ref_id)).size;
    const coverage = count === total ? 'all records' : `${count} of the ${total} records`;
    return `A large language model (${descriptions.join('; ')}) screened ${coverage} against the same eligibility criteria as an additional independent screener (inclusion threshold ${threshold}), using TiAb Review's screening prompt version ${[...prompts].sort().join(', ')}.`;
}
