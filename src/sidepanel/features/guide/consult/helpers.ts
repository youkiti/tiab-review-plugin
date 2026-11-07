// 相談の小窓の、DOM に依存しない判定と組み立て（押せるかの理由・失敗の文言キー・ツアーの対応・環境情報）。
import { GUIDE_TOPICS, type GuideTourId } from '../../../../lib/guide/topics';
import { CONSULT_MODELS, type ConsultProviderId } from '../../../../lib/help-consult/model';
import type { ConsultFailureKind, HelpSection } from '../../../../lib/help-consult/types';
import type { IssueEnvironment } from '../../../../lib/help-consult/issue-draft';

export function consultDisabledReason(input: {
    loaded: boolean; provider: ConsultProviderId | null; batchRunning: boolean; question: string; running: boolean;
}): string | null {
    if (!input.loaded) return 'guideExt_consult_loadFailed';
    if (input.running) return 'guideExt_consult_running';
    if (!input.provider) return 'guideExt_consult_no_key';
    if (input.batchRunning) return 'guideExt_consult_batchRunning';
    if (!input.question.trim()) return 'guideExt_consult_empty';
    return null;
}

export function failureMessageKey(kind: ConsultFailureKind): string {
    return `guideExt_consult_${kind}`;
}

export function initialHelpSection(sections: readonly HelpSection[], anchor: string): HelpSection | undefined {
    const exact = sections.find(section => section.id === anchor);
    if (exact) return exact;
    // 章の見出しへ飛ぶトピックでは、小節を借りずに章そのものへのリンクを出す。
    const chapter = sections.find(section => section.sectionId === anchor);
    return chapter ? { ...chapter, id: anchor, title: chapter.sectionTitle, when: [], body: '' } : undefined;
}

export function sectionTourIds(sectionId: string, availableIds: readonly GuideTourId[]): GuideTourId[] {
    return [...new Set(Object.values(GUIDE_TOPICS)
        .filter(topic => topic.helpAnchor === sectionId && 'tourId' in topic)
        .map<GuideTourId | undefined>(topic => ('tourId' in topic ? topic.tourId : undefined))
        .filter((id): id is GuideTourId => !!id && availableIds.includes(id)))];
}

export function buildConsultEnvironment(input: {
    version: string; uiLang: string; tab: string; topicId: string;
    provider: ConsultProviderId | null; configuredProviders: readonly ConsultProviderId[]; errorText?: ConsultFailureKind;
}): IssueEnvironment {
    return {
        version: input.version, platform: 'extension', uiLang: input.uiLang,
        screen: `${input.tab} / ${input.topicId}`, provider: input.provider ?? 'none',
        model: input.provider ? CONSULT_MODELS[input.provider] : 'none',
        configuredProviders: input.configuredProviders, errorText: input.errorText,
    };
}
