// ヘルプの相談の小窓（拡張版のサイドパネルだけ）。「?」の吹き出しから遅延チャンク help-consult として読む。
import { t } from '../../../../lib/i18n';
import { platform } from '../../../../platform';
import { state } from '../../../state';
import { showModal, hideModal } from '../../../ui/modal';
import { showToast } from '../../../ui/feedback';
import { GUIDE_TOPICS, HELP_PAGE_URL, type GuideTopicId, type GuideTourId } from '../../../../lib/guide/topics';
import { loadHelpSections } from '../../../../lib/help-consult/load';
import { searchHelpSections } from '../../../../lib/help-consult/search';
import { consultHelp } from '../../../../lib/help-consult/consult';
import { chooseConsultProvider, CONSULT_MODELS, type ConsultProviderId } from '../../../../lib/help-consult/model';
import { createIssueDraft } from '../../../../lib/help-consult/issue-draft';
import type { HelpSection, ConsultFailureKind } from '../../../../lib/help-consult/types';
import {
    hasGeminiApiKey, hasOpenAiApiKey, hasAnthropicApiKey, hasOpenRouterApiKey,
    getSessionApiKey, getSessionOpenAiApiKey, getSessionAnthropicApiKey, getSessionOpenRouterApiKey,
} from '../../../../lib/storage';
import { buildConsultEnvironment, consultDisabledReason, failureMessageKey, initialHelpSection, sectionTourIds } from './helpers';

const PROVIDER_NAMES: Record<ConsultProviderId, string> = {
    gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(key: string, run: () => void): HTMLButtonElement {
    const node = element('button', t(key), 'btn btn-secondary btn-small');
    node.type = 'button';
    node.addEventListener('click', run);
    return node;
}

async function configuredProviders(): Promise<ConsultProviderId[]> {
    const checks: [ConsultProviderId, () => Promise<boolean>, () => string | null][] = [
        ['gemini', hasGeminiApiKey, getSessionApiKey], ['openai', hasOpenAiApiKey, getSessionOpenAiApiKey],
        ['anthropic', hasAnthropicApiKey, getSessionAnthropicApiKey], ['openrouter', hasOpenRouterApiKey, getSessionOpenRouterApiKey],
    ];
    const present = await Promise.all(checks.map(async ([id, saved, session]) => {
        // 保存領域が読めない社は未設定として扱い、検索と下書きは使えるままにする。
        try { return session() || await saved() ? id : null; } catch { return null; }
    }));
    return present.filter((id): id is ConsultProviderId => id !== null);
}

/** ツアー本体を別チャンクへ複製しないよう、利用可否と開始処理は呼び出し元から受け取る。 */
export function openHelpConsult(topicId: GuideTopicId, tours: {
    available: () => GuideTourId[]; start: (id: GuideTourId) => Promise<void>;
}): void {
    const lang = t('guide_language') === 'ja' ? 'ja' : 'en';
    const tab = state.currentTab;
    let sections: HelpSection[] = [];
    let loaded = false;
    let loadFailed = false;
    let closed = false;
    let providers: ConsultProviderId[] = [];
    let provider: ConsultProviderId | null = null;
    let usedProvider: ConsultProviderId | null = null;
    let answer: string | undefined;
    let errorKind: ConsultFailureKind | undefined;
    let controller: AbortController | null = null;
    const body = element('div', undefined, 'guide-consult-body');
    const question = element('textarea', undefined, 'guide-consult-question');
    question.id = 'guide-consult-question';
    question.maxLength = 1000;
    question.rows = 3;
    const label = element('label', t('guideExt_consult_question'));
    label.htmlFor = question.id;
    body.append(label, question);
    const searchResults = element('div', undefined, 'guide-consult-results');
    searchResults.setAttribute('aria-live', 'polite');
    const loadStatus = element('p', t('guideExt_consult_loading'));
    const search = button('guideExt_consult_search', () => {
        searchResults.replaceChildren();
        const found = searchHelpSections(sections, question.value, 3);
        if (!found.length) searchResults.append(element('p', t('guideExt_consult_searchEmpty')));
        found.forEach(section => searchResults.append(sectionCard(section)));
    });
    search.disabled = true;
    const searchActions = element('div', undefined, 'guide-consult-actions');
    searchActions.append(search);
    body.append(loadStatus, searchActions, searchResults);

    const notice = element('p');
    const geminiNotice = element('p');
    const reason = element('p');
    reason.id = 'guide-consult-disabled-reason';
    const result = element('div', undefined, 'guide-consult-answer');
    result.setAttribute('aria-live', 'polite');
    const ask = button('guideExt_consult_ask', () => { void askAi(); });
    ask.className = 'btn btn-primary btn-small';
    ask.setAttribute('aria-describedby', reason.id);
    const abort = button('guideExt_consult_abort', () => controller?.abort());
    abort.hidden = true;
    const aiActions = element('div', undefined, 'guide-consult-actions');
    aiActions.append(ask, abort);
    body.append(notice, geminiNotice, aiActions, reason, result);

    const draftLabel = element('label', t('guideExt_consult_draftPreview'));
    const preview = element('textarea', undefined, 'guide-consult-preview');
    preview.id = 'guide-consult-preview';
    draftLabel.htmlFor = preview.id;
    preview.readOnly = true;
    preview.rows = 7;
    let draft = createIssueDraft({ question: '', environment: environment() });
    const issueActions = element('div', undefined, 'guide-consult-actions');
    issueActions.append(
        button('guideExt_consult_github', () => platform().openExternal(draft.url)),
        button('guideExt_consult_copy', () => {
            void Promise.resolve().then(() => navigator.clipboard.writeText(draft.body))
                .catch(() => showToast(t('guideExt_consult_copyFailed')));
        }),
    );
    body.append(element('h3', t('guideExt_consult_unresolved')), draftLabel, preview, issueActions,
        element('p', t('guideExt_consult_noGithub')));

    function environment() {
        return buildConsultEnvironment({ version: platform().getVersionString(), uiLang: lang, tab, topicId,
            provider: usedProvider ?? provider, configuredProviders: providers, errorText: errorKind });
    }

    function updateDraft(): void {
        draft = createIssueDraft({ question: question.value, answer, environment: environment() });
        if (preview.value !== draft.body) preview.value = draft.body;
    }

    function refresh(): void {
        if (closed) return;
        provider = chooseConsultProvider(new Set(providers), state.llmConfig?.llm_model);
        const disabled = consultDisabledReason({ loaded, provider, question: question.value,
            batchRunning: state.batchAbortController !== null, running: controller !== null });
        ask.disabled = disabled !== null;
        reason.textContent = !loaded && !loadFailed ? t('guideExt_consult_loading') : disabled ? t(disabled) : '';
        notice.textContent = provider ? t('guideExt_consult_sendNotice', [PROVIDER_NAMES[provider], CONSULT_MODELS[provider]]) : '';
        geminiNotice.textContent = provider === 'gemini' ? t('llmExt_geminiDataNotice') : '';
        abort.hidden = controller === null;
        question.disabled = controller !== null;
        updateDraft();
    }

    function sectionCard(section: HelpSection): HTMLElement {
        const card = element('div', undefined, 'guide-consult-section');
        card.append(element('strong', section.title));
        if (section.when[0]) card.append(element('p', section.when[0].split('\n')[0]));
        const actions = element('div', undefined, 'guide-consult-actions');
        actions.append(button('guideExt_consult_openHelp', () => platform().openExternal(
            `${HELP_PAGE_URL}?lang=${lang}#${encodeURIComponent(section.id)}`,
        )));
        for (const id of sectionTourIds(section.id, tours.available())) {
            actions.append(button('guideExt_consult_startTour', () => {
                // 開始直前にも利用可否を確認する。
                if (!sectionTourIds(section.id, tours.available()).includes(id)) return;
                hideModal();
                void tours.start(id).catch(() => showToast(t('guideExt_consult_tourFailed')));
            }));
        }
        card.append(actions);
        return card;
    }

    async function askAi(): Promise<void> {
        refresh();
        if (ask.disabled || !provider) return;
        const active = new AbortController();
        controller = active;
        usedProvider = provider;
        answer = undefined;
        errorKind = undefined;
        result.replaceChildren();
        refresh();
        const response = await consultHelp({ question: question.value, lang, sections, providerId: provider, signal: active.signal });
        if (closed) return;
        controller = null;
        if (response.status === 'success') {
            answer = response.answer;
            result.append(element('p', answer), element('p', t('guideExt_consult_accuracy'), 'guide-consult-note'));
            response.sectionIds.forEach(id => {
                const section = sections.find(item => item.id === id);
                if (section) result.append(sectionCard(section));
            });
        } else if (response.status === 'no_match') {
            result.append(element('p', t('guideExt_consult_noMatch')));
        } else {
            errorKind = response.kind;
            result.append(element('p', t(failureMessageKey(response.kind))));
        }
        refresh();
    }

    question.addEventListener('input', () => {
        answer = undefined;
        errorKind = undefined;
        usedProvider = null;
        result.replaceChildren();
        refresh();
    });
    // 一括判定の状態はストア外なので、表示中だけ監視し、送信直前にも確認する。
    const timer = window.setInterval(refresh, 500);
    showModal({ title: t('guideExt_consult_title'), body, onClose: () => {
        closed = true;
        controller?.abort();
        window.clearInterval(timer);
    } });
    refresh();
    question.focus();
    void configuredProviders().then(value => { if (!closed) { providers = value; refresh(); } });
    void loadHelpSections(lang).then(value => {
        if (closed) return;
        sections = value;
        loaded = true;
        loadStatus.textContent = '';
        search.disabled = false;
        const current = initialHelpSection(sections, GUIDE_TOPICS[topicId].helpAnchor);
        if (current) searchResults.append(element('h3', t('guideExt_consult_currentHelp')), sectionCard(current));
        refresh();
    }).catch(() => {
        if (closed) return;
        loadFailed = true;
        loadStatus.textContent = t('guideExt_consult_loadFailed');
        searchResults.append(button('guideExt_consult_openHelp', () => platform().openExternal(`${HELP_PAGE_URL}?lang=${lang}`)));
        refresh();
    });
}
