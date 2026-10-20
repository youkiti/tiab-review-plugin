// 論文用の記述は採用された判定と実送信設定から組み立てる。
import type { AssignmentConfig, Decision, LlmExecution, LlmRun, ReferenceWithStatus } from './types';
import type { FulltextResultsSummary } from './fulltext-results-summary';
import { summarizeTeamDecision } from './decision-summary';
import { getModelGenerationSettings } from './model-generation-settings';
import { PROMPT_VERSION } from './prompt-templates';

/** 確定時の記録だけを使い、後から変えた設定で過去の検証を書き換えない。 */
export function buildManuscriptValidationSentence(run: LlmRun): string {
    const compared = run.validation_compared;
    const included = run.validation_human_includes;
    const missed = run.validation_missed;
    const criterion = run.validation_max_miss_rate;
    // 検証の記録が無い Run（この機能より前に確定した Run など）は、比較したかどうかが分からないので何も書かない
    if (!run.validation_evaluated_at) {
        return '';
    }
    if (!compared || !included || missed === undefined || criterion === undefined) {
        return "The model's decisions were not compared with reviewers' decisions within this review.";
    }
    const setAt = Date.parse(run.validation_criterion_set_at || '');
    const createdAt = Date.parse(run.created_at);
    const timing = !Number.isFinite(setAt) || !Number.isFinite(createdAt)
        ? 'not recorded in advance'
        : setAt <= createdAt ? 'specified before the run' : 'specified after the run';
    const missRate = missed / included;
    const failure = missRate > criterion
        ? timing === 'specified before the run'
            ? ', which did not meet the prespecified criterion'
            : ', which did not meet the specified criterion'
        : '';
    return `Before the large language model's decisions were used, they were compared with the reviewers' consensus decisions for ${compared} records (${included} included by the reviewers). ` +
        `At the inclusion threshold of ${run.include_threshold}, the model missed ${missed} of the ${included} included records (miss rate ${(missRate * 100).toFixed(1)}%), against an acceptable miss rate of ${(criterion * 100).toFixed(1)}% that was ${timing}${failure}.`;
}

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

function recordedSettings(model: string, row?: LlmExecution): string {
    if (!row) {
        return 'generation settings not recorded';
    }
    const provider = getModelGenerationSettings(model).provider;
    const modern = Boolean(row.prompt_sha256);
    const typeSafe = provider === 'typesafe' || model.startsWith('typesafe/') || model.startsWith('~typesafe/');
    const sampling = modern || (!typeSafe && (provider === 'gemini' || provider === 'openrouter'));
    const settings: string[] = [];
    if (sampling && row.temperature !== undefined) {
        settings.push(`temperature ${row.temperature}`);
    }
    if (sampling && row.topP !== undefined) {
        settings.push(`top-p ${row.topP}`);
    }
    if (sampling && row.thinkingLevel) {
        settings.push(`thinking level ${row.thinkingLevel.toLowerCase()}`);
    }
    const effort = modern ? row.reasoning_effort
        : provider === 'openai' || provider === 'anthropic' ? 'low' : undefined;
    if (effort) {
        settings.push(`${provider === 'anthropic' ? 'effort' : 'reasoning effort'} ${effort}`);
    }
    return settings.join(', ');
}

export function buildManuscriptAiSentence(
    decisions: readonly Decision[], total: number, threshold: number, executions: readonly LlmExecution[],
): string {
    const judged = decisions.filter(d => (d.screening_phase ?? 'tiab') === 'tiab'
        && d.reviewer_id.startsWith('llm:') && d.decision !== 'pending');
    if (!judged.length) {
        return '';
    }
    const rows = new Map(executions.map(row => [row.execution_id, row]));
    const models = new Map<string, { versions: Set<string>; settings: Set<string> }>();
    const prompts = new Set<string>();
    for (const decision of judged) {
        const body = decision.reviewer_id.slice(4);
        const at = body.lastIndexOf('@');
        const model = at > 0 ? body.slice(0, at) : body;
        const entry = models.get(model) ?? { versions: new Set<string>(), settings: new Set<string>() };
        const note = noteVersions(decision.note ?? '');
        const row = rows.get(decision.reviewer_id);
        if (note.model) {
            entry.versions.add(note.model);
        }
        entry.settings.add(recordedSettings(model, row));
        prompts.add(note.prompt || row?.prompt_version || PROMPT_VERSION);
        models.set(model, entry);
    }
    const descriptions = [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, entry]) => {
        const version = entry.versions.size ? ` [model version reported by the API: ${[...entry.versions].sort().join(', ')}]` : '';
        const settings = [...entry.settings].sort().map(value => value || 'no generation parameters sent').join('; ');
        return model + version + ` (${settings})`;
    });
    const count = new Set(judged.map(d => d.ref_id)).size;
    const coverage = count === total ? 'all records' : `${count} of the ${total} records`;
    return `A large language model (${descriptions.join('; ')}) screened ${coverage} against the same eligibility criteria as an additional independent screener (inclusion threshold ${threshold}), using TiAb Review's screening prompt version ${[...prompts].sort().join(', ')}.`;
}

/** 担当セットの必要人数を満たし、未読除外だけで除外が確定した文献を数える。 */
export function countManuscriptStoppingRuleExclusions(
    refs: ReferenceWithStatus[], reviewerKeys: string[], treatMlAsManual: boolean,
    assignmentConfig: AssignmentConfig | null,
): number {
    return refs.filter(ref => {
        const summary = summarizeTeamDecision(ref, reviewerKeys, treatMlAsManual, assignmentConfig);
        return summary.teamStatus === 'exclude' && summary.excludedByStoppingRule === true;
    }).length;
}

/** 全文のAI評価文に、通常の人判定と採用済みの人の裁定を反映する。 */
export function buildFulltextAiMethodsSentence(
    summary: Pick<FulltextResultsSummary, 'judges' | 'adjudicated'>,
): string {
    const models = [...new Set(summary.judges.filter(j => j.startsWith('llm:')).map(j => {
        const body = j.slice('llm:'.length);
        const at = body.lastIndexOf('@');
        return at > 0 ? body.slice(0, at) : body;
    }))].sort().join(', ');
    if (!models) {
        return '';
    }
    if (summary.judges.some(j => !j.startsWith('llm:'))) {
        return `Retrieved PDFs were additionally assessed by ${models} as an independent screener.`;
    }
    if (summary.adjudicated > 0) {
        const reports = summary.adjudicated === 1 ? 'report' : 'reports';
        return `Full texts were assessed by ${models}; a reviewer adjudicated ${summary.adjudicated} ${reports}, and the remaining decisions were made by the model without human screening.`;
    }
    return `Full texts were assessed by ${models} only, without human screening.`;
}
