import { dom } from './dom';
import { AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG, getAllAvailableModels, type ModelOption } from '../../../lib/gemini-api';
import { buildModelGroups, filterModelGroups, resolveModelEntry, type ModelGroup } from '../../../lib/llm-model-options';
import { fetchOpenRouterModels } from '../../../lib/openrouter-models';
import { getOpenRouterModels, saveOpenRouterModels, hasOpenRouterApiKey, getSessionOpenRouterApiKey } from '../../../lib/storage';
import { isImeComposing } from '../../../lib/ime-composition';
import { t } from '../../../lib/i18n';
import { showToast } from '../../ui/feedback';
import { updateBatchTargetCount } from './batch/target-count';

let groups: ModelGroup[] = [];
let committedValue = DEFAULT_MODEL_CONFIG.model;
let explicitChange = false;
let query = '';
let activeIndex = -1;
let visibleModels: ModelOption[] = [];
let population = 0;
let refreshInFlight: Promise<boolean> | null = null;

function list(): HTMLUListElement {
    return document.getElementById('llm-model-list') as HTMLUListElement;
}

function displayName(model: ModelOption): string {
    return model.nameKey ? t(model.nameKey) : model.name;
}

function close(): void {
    list().classList.add('hidden');
    dom.llmModelSelect.setAttribute('aria-expanded', 'false');
    dom.llmModelSelect.removeAttribute('aria-activedescendant');
    activeIndex = -1;
}

function updateActive(): void {
    const options = list().querySelectorAll<HTMLElement>('[role="option"]');
    options.forEach((option, index) => option.classList.toggle('active', index === activeIndex));
    const active = options[activeIndex];
    if (active) {
        dom.llmModelSelect.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
    } else {
        dom.llmModelSelect.removeAttribute('aria-activedescendant');
    }
}

function render(): void {
    const ul = list();
    ul.replaceChildren();
    visibleModels = [];
    for (const group of filterModelGroups(groups, query, displayName)) {
        const section = document.createElement('li');
        section.setAttribute('role', 'presentation');
        const heading = document.createElement('div');
        heading.className = 'model-combobox-heading';
        heading.id = `llm-model-group-${ul.childElementCount}`;
        heading.textContent = group.labelKey ? t(group.labelKey) : group.label;
        section.appendChild(heading);
        const items = document.createElement('ul');
        items.setAttribute('role', 'group');
        items.setAttribute('aria-labelledby', heading.id);
        for (const model of group.models) {
            const index = visibleModels.length;
            visibleModels.push(model);
            const option = document.createElement('li');
            option.id = `llm-model-option-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(model.id === committedValue));
            option.dataset.modelId = model.id;
            const title = document.createElement('div');
            title.textContent = `${model.id === committedValue ? '✓ ' : ''}${displayName(model)}`;
            if (model.custom) {
                const badge = document.createElement('span');
                badge.className = 'model-combobox-badge';
                badge.textContent = t('llm_customModelBadge');
                title.appendChild(badge);
            }
            const id = document.createElement('small');
            id.textContent = model.id;
            option.append(title, id);
            option.addEventListener('click', () => commit(model.id));
            items.appendChild(option);
        }
        section.appendChild(items);
        ul.appendChild(section);
    }
    if (visibleModels.length === 0) {
        const empty = document.createElement('li');
        empty.setAttribute('role', 'presentation');
        empty.textContent = t('llm_noMatchingModels');
        ul.appendChild(empty);
    }
    activeIndex = -1;
    updateActive();
}

function open(search = ''): void {
    query = search;
    list().classList.remove('hidden');
    dom.llmModelSelect.setAttribute('aria-expanded', 'true');
    render();
}

/** 保存設定の復元でも、次の入力を取り消した際の戻り先を更新する。 */
export function setSelectedModel(value: string): void {
    committedValue = value;
    dom.llmModelSelect.value = value;
    close();
}

function validate(explicit: boolean): boolean {
    const value = dom.llmModelSelect.value.trim();
    const result = resolveModelEntry(value, groups.flatMap(group => group.models.map(model => model.id)), explicit);
    if ('revert' in result) {
        dom.llmModelSelect.value = committedValue;
        if (result.warn) {
            showToast(t('llm_unknownModel', value), 4000);
        }
        close();
        return false;
    }
    const changed = result.accept !== committedValue;
    committedValue = result.accept;
    dom.llmModelSelect.value = result.accept;
    close();
    return changed;
}

function commit(value: string, explicit = true): void {
    dom.llmModelSelect.value = value;
    explicitChange = explicit;
    try {
        dom.llmModelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
        explicitChange = false;
    }
}

export function wireModelCombobox(): void {
    const input = dom.llmModelSelect;
    const button = document.getElementById('llm-model-toggle') as HTMLButtonElement;
    const container = input.closest('.model-combobox')!;
    input.addEventListener('change', event => {
        const explicit = explicitChange;
        explicitChange = false;
        // 同じ確定値へのネイティブ通知も、後続のリスナーには渡さない。
        if (!validate(explicit)) {
            event.stopImmediatePropagation();
        }
    }, true);
    input.addEventListener('click', () => open());
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('blur', () => commit(input.value, false));
    input.addEventListener('keydown', event => {
        if (isImeComposing(event)) {
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (list().classList.contains('hidden')) {
                open();
            }
            const count = visibleModels.length;
            if (count > 0) {
                activeIndex = activeIndex < 0
                    ? event.key === 'ArrowDown' ? 0 : count - 1
                    : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
                updateActive();
            }
        } else if (event.key === 'Enter') {
            event.preventDefault();
            commit(visibleModels[activeIndex]?.id ?? input.value);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            input.value = committedValue;
            close();
        }
    });
    // 候補を押す途中の blur/change で候補リストが消えないようにする。
    list().addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
        if (list().classList.contains('hidden')) {
            input.focus();
            open();
        } else {
            close();
        }
    });
    document.addEventListener('click', event => {
        if (event.target instanceof Node && !container.contains(event.target)) {
            close();
        }
    });
}

/** 候補だけを更新し、入力中・選択済みのモデルIDは変更しない。 */
export async function populateModelSelect(isCurrent: () => boolean = () => true): Promise<void> {
    const generation = ++population;
    const [models, cache] = await Promise.all([getAllAvailableModels(), getOpenRouterModels()]);
    if (!isCurrent() || generation !== population) {
        return;
    }
    groups = buildModelGroups(AVAILABLE_MODELS, models.filter(model => model.custom), cache?.models ?? []);
    render();
    await updateBatchTargetCount(() => isCurrent() && generation === population);
}

/** 取得失敗時は保存済み一覧を維持し、キー検証の成功状態にも影響させない。 */
export async function refreshOpenRouterModels(force = false, isCurrent: () => boolean = () => true): Promise<void> {
    try {
        // 合流先が取得を省略した場合も、キー検証後の強制更新は実行する。
        if (refreshInFlight) {
            const saved = await refreshInFlight;
            if (saved) {
                if (isCurrent()) await populateModelSelect(isCurrent);
                return;
            }
            if (!force) return;
        }
        if (!refreshInFlight) {
            refreshInFlight = (async () => {
                if (!force) {
                    const configured = !!getSessionOpenRouterApiKey() || await hasOpenRouterApiKey();
                    const cache = await getOpenRouterModels();
                    if (!configured || (cache && Date.now() - cache.fetchedAt <= 24 * 60 * 60 * 1000)) {
                        return false;
                    }
                }
                const models = await fetchOpenRouterModels();
                await saveOpenRouterModels(models);
                return true;
            })().finally(() => { refreshInFlight = null; });
        }
        // 通信と保存だけを共有し、描画は呼び出しごとの有効性で判定する。
        const saved = await refreshInFlight;
        if (saved && isCurrent()) await populateModelSelect(isCurrent);
    } catch {
        console.warn('OpenRouter モデル一覧を更新できませんでした。保存済みの一覧を保持します。');
    }
}
