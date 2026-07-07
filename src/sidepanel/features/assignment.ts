import type { AssignmentConfig, ReferenceWithStatus } from '../../lib/types';
import { getAssignmentConfig, saveAssignmentConfig, updateReferenceScreeningSets } from '../../lib/sheets-api';
import { t } from '../../lib/i18n';
import { dom } from '../dom';
import { state } from '../state';
import { showLoading, showToast } from '../ui/feedback';
import { setCurrentIndex as syncSetCurrentIndex } from '../store/compat';
import { hideModal, showModal } from '../ui/modal';

const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

let _loadDataAndShowScreening: (() => Promise<void>) | null = null;
let _renderCurrentReference: (() => void) | null = null;
let _wizardOpen = false;

export function setAssignmentDependencies(deps: {
    loadDataAndShowScreening: () => Promise<void>;
    renderCurrentReference: () => void;
}) {
    _loadDataAndShowScreening = deps.loadDataAndShowScreening;
    _renderCurrentReference = deps.renderCurrentReference;
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function normalizeReviewerMap(reviewerMap: Record<string, string[]>): Record<string, string[]> {
    const normalized: Record<string, string[]> = {};

    for (const [setId, reviewers] of Object.entries(reviewerMap)) {
        normalized[setId] = Array.from(new Set((reviewers || [])
            .map(normalizeEmail)
            .filter(Boolean)));
    }

    return normalized;
}

export function createDefaultAssignmentConfig(): AssignmentConfig {
    return { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} };
}

export function getReferenceAssignmentSet(ref: ReferenceWithStatus): string {
    const normalized = (ref.screening_set || '').trim();
    if (normalized) {
        return normalized;
    }
    if (state.assignmentConfig.status === 'configured') {
        return 'unassigned';
    }
    return '';
}

export function getAssignedSetsForUser(config: AssignmentConfig, userEmail: string): Set<string> {
    const assigned = new Set<string>();

    if (config.status !== 'configured') {
        return assigned;
    }

    assigned.add('calibration');
    const normalizedEmail = normalizeEmail(userEmail);

    for (const [setId, reviewers] of Object.entries(config.reviewerMap || {})) {
        if ((reviewers || []).some((reviewer) => normalizeEmail(reviewer) === normalizedEmail)) {
            assigned.add(setId);
        }
    }

    return assigned;
}

function getAvailableAssignmentSets(refs: ReferenceWithStatus[], config: AssignmentConfig): Set<string> {
    const setIds = new Set<string>();

    refs.forEach((ref) => {
        const setId = (ref.screening_set || '').trim();
        if (setId) {
            setIds.add(setId);
        }
    });

    if (config.status === 'configured') {
        setIds.add('calibration');
        for (let i = 1; i <= config.groupCount; i += 1) {
            setIds.add(`group-${i}`);
        }
        if (refs.some((ref) => !ref.screening_set || !ref.screening_set.trim())) {
            setIds.add('unassigned');
        }
    }

    return new Set(Array.from(setIds).sort((a, b) => {
        if (a === 'calibration') return -1;
        if (b === 'calibration') return 1;
        if (a === 'unassigned') return 1;
        if (b === 'unassigned') return -1;
        return a.localeCompare(b, undefined, { numeric: true });
    }));
}

export function getAssignmentSetLabel(setId: string): string {
    if (setId === 'calibration') {
        return t('assignment_setCalibration');
    }
    if (setId === 'unassigned') {
        return t('assignment_setUnassigned');
    }
    if (setId.startsWith('group-')) {
        return t('assignment_setGroup', setId.replace('group-', ''));
    }
    return setId;
}

export function initializeAssignmentState(
    refs: ReferenceWithStatus[],
    config: AssignmentConfig,
    userEmail: string,
    isAdmin: boolean
): ReferenceWithStatus[] {
    const normalizedConfig: AssignmentConfig = {
        ...createDefaultAssignmentConfig(),
        ...config,
        reviewerMap: normalizeReviewerMap(config.reviewerMap || {}),
    };

    state.setAssignmentConfig(normalizedConfig);

    const availableSets = getAvailableAssignmentSets(refs, normalizedConfig);
    state.setAssignmentSets(availableSets);

    if (isAdmin) {
        state.setSelectedAssignmentSets(new Set(availableSets));
        return refs;
    }

    if (normalizedConfig.status !== 'configured') {
        state.setSelectedAssignmentSets(new Set());
        return refs;
    }

    const assignedSets = getAssignedSetsForUser(normalizedConfig, userEmail);
    state.setSelectedAssignmentSets(new Set(assignedSets));

    const visibleRefs = refs.filter((ref) => assignedSets.has(getReferenceAssignmentSet(ref)));

    if (visibleRefs.length === 0 && refs.length > 0) {
        showToast(t('assignment_noAssignedGroup'));
    }

    return visibleRefs;
}

export async function loadAssignmentConfig(spreadsheetId: string): Promise<AssignmentConfig> {
    const config = await getAssignmentConfig(spreadsheetId);
    state.setAssignmentConfig(config);
    return config;
}

export function renderAssignmentFilters() {
    dom.assignmentSetListDiv.innerHTML = '';

    if (state.assignmentConfig.status !== 'configured' || state.assignmentSets.size === 0) {
        dom.assignmentFiltersSection.classList.add('hidden');
        return;
    }

    dom.assignmentFiltersSection.classList.remove('hidden');

    state.assignmentSets.forEach((setId) => {
        const count = state.references.filter((ref) => getReferenceAssignmentSet(ref) === setId).length;
        if (!state.isAdmin && count === 0) {
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'source-file-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `assignment-set-${setId}`;
        checkbox.checked = state.selectedAssignmentSets.has(setId);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.addSelectedAssignmentSet(setId);
            } else {
                state.removeSelectedAssignmentSet(setId);
            }
            syncSetCurrentIndex(0);
            if (_renderCurrentReference) {
                _renderCurrentReference();
            }
        });

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = `${getAssignmentSetLabel(setId)} (${count})`;

        wrapper.appendChild(checkbox);
        wrapper.appendChild(label);
        dom.assignmentSetListDiv.appendChild(wrapper);
    });
}

export function renderAssignmentManager() {
    if (!state.isAdmin || !state.spreadsheetId) {
        dom.assignmentSettingsItem.classList.add('hidden');
        return;
    }

    const config = state.assignmentConfig;
    dom.assignmentSettingsItem.classList.remove('hidden');
    dom.assignmentReviewerMap.innerHTML = '';
    dom.assignmentReviewerMap.classList.add('hidden');
    dom.assignmentSaveBtn.classList.add('hidden');
    dom.assignmentResetBtn.classList.add('hidden');
    dom.assignmentBanner.classList.add('hidden');
    if (dom.assignmentReshuffleBtn) {
        dom.assignmentReshuffleBtn.classList.add('hidden');
    }

    if (config.status === 'configured') {
        dom.assignmentSettingsStatus.textContent = t('assignment_settingsConfigured', [String(config.calibrationSize), String(config.groupCount)]);
        dom.assignmentReviewerMap.classList.remove('hidden');
        dom.assignmentSaveBtn.classList.remove('hidden');
        if (dom.assignmentReshuffleBtn) {
            dom.assignmentReshuffleBtn.textContent = t('assignment_settingsReshuffle');
            dom.assignmentReshuffleBtn.classList.remove('hidden');
        }
        renderReviewerInputs(config);
        return;
    }

    // 未設定（none / dismissed）: 設定画面に目立つ案内カードを表示
    dom.assignmentSettingsStatus.textContent = '';
    dom.assignmentBannerDesc.textContent = t('assignment_bannerDesc', String(DEFAULT_ASSIGNMENT_CONFIG.calibrationSize));
    dom.assignmentBanner.classList.remove('hidden');
}

/** 案内カードの「今すぐ分割する」→ ウィザードを強制的に開く */
export async function handleAssignmentBannerOpen() {
    await maybeShowAssignmentWizard('settings', { force: true });
}

function renderReviewerInputs(config: AssignmentConfig) {
    for (let index = 1; index <= config.groupCount; index += 1) {
        const setId = `group-${index}`;
        const groupRow = document.createElement('div');
        groupRow.className = 'assignment-group-row';

        const label = document.createElement('label');
        label.htmlFor = `assignment-reviewers-${setId}`;
        label.textContent = t('assignment_wizardReviewerLabel', String(index));

        const input = document.createElement('input');
        input.type = 'text';
        input.id = label.htmlFor;
        input.dataset.setId = setId;
        input.placeholder = t('assignment_reviewerPlaceholder');
        input.value = (config.reviewerMap[setId] || []).join(', ');

        groupRow.appendChild(label);
        groupRow.appendChild(input);
        dom.assignmentReviewerMap.appendChild(groupRow);
    }
}

function parseReviewerMapFromInputs(container: HTMLElement, groupCount: number): Record<string, string[]> {
    const reviewerMap: Record<string, string[]> = {};

    for (let index = 1; index <= groupCount; index += 1) {
        const setId = `group-${index}`;
        const input = container.querySelector<HTMLInputElement>(`input[data-set-id="${setId}"]`);
        const reviewers = (input?.value || '')
            .split(/[\n,;]/)
            .map(normalizeEmail)
            .filter(Boolean);
        reviewerMap[setId] = Array.from(new Set(reviewers));
    }

    return reviewerMap;
}

export async function handleAssignmentSaveMap() {
    const config = state.assignmentConfig;
    if (config.status !== 'configured') {
        return;
    }

    try {
        showLoading(true);
        const reviewerMap = parseReviewerMapFromInputs(dom.assignmentReviewerMap, config.groupCount);
        const nextConfig: AssignmentConfig = {
            ...config,
            reviewerMap,
        };
        await saveAssignmentConfig(state.spreadsheetId, nextConfig);
        state.setAssignmentConfig(nextConfig);
        showToast(t('assignment_settingsMapSaved'));
    } catch (error) {
        console.error('Assignment map save error:', error);
        showToast(t('assignment_settingsMapError', (error as Error).message));
    } finally {
        showLoading(false);
    }
}

export async function handleAssignmentResetClick() {
    const config = state.assignmentConfig;

    if (config.status === 'configured') {
        return;
    }

    const nextConfig: AssignmentConfig = {
        ...createDefaultAssignmentConfig(),
        status: 'none',
    };

    try {
        showLoading(true);
        await saveAssignmentConfig(state.spreadsheetId, nextConfig);
        state.setAssignmentConfig(nextConfig);
        renderAssignmentManager();
        await maybeShowAssignmentWizard('settings');
    } catch (error) {
        console.error('Assignment reset error:', error);
        showToast(t('assignment_settingsMapError', (error as Error).message));
    } finally {
        showLoading(false);
    }
}

export async function maybeShowAssignmentWizard(
    _source: 'load' | 'import' | 'settings' | 'reshuffle' = 'load',
    options: { force?: boolean } = {}
) {
    if (_wizardOpen) return;
    if (!state.isAdmin || !state.spreadsheetId) return;
    if (!options.force && state.assignmentConfig.status !== 'none') return;
    if (state.references.length === 0) return;

    showAssignmentWizard();
}

export async function handleAssignmentReshuffleClick() {
    if (state.assignmentConfig.status !== 'configured') return;
    if (state.references.length === 0) return;

    if (!window.confirm(t('assignment_reshuffleConfirm'))) {
        return;
    }

    await maybeShowAssignmentWizard('reshuffle', { force: true });
}

function showAssignmentWizard() {
    const totalCount = state.references.length;
    const isReshuffle = state.assignmentConfig.status === 'configured';
    const initialConfig = isReshuffle
        ? state.assignmentConfig
        : createDefaultAssignmentConfig();
    const groupValues = new Map<string, string>();

    const container = document.createElement('div');
    container.className = 'assignment-wizard';

    const intro = document.createElement('p');
    intro.className = 'assignment-help';
    intro.textContent = t('assignment_wizardIntro');

    const total = document.createElement('p');
    total.className = 'assignment-summary';
    total.textContent = t('assignment_wizardSummary', String(totalCount));

    const form = document.createElement('div');
    form.className = 'assignment-wizard-form';

    const calibrationRow = document.createElement('div');
    calibrationRow.className = 'assignment-form-row';
    const calibrationLabel = document.createElement('label');
    calibrationLabel.htmlFor = 'assignment-calibration-size';
    calibrationLabel.textContent = t('assignment_wizardCalibrationLabel');
    const calibrationInput = document.createElement('input');
    calibrationInput.type = 'number';
    calibrationInput.id = calibrationLabel.htmlFor;
    calibrationInput.min = '0';
    calibrationInput.max = String(totalCount);
    calibrationInput.value = String(Math.min(initialConfig.calibrationSize || 50, totalCount));
    calibrationRow.appendChild(calibrationLabel);
    calibrationRow.appendChild(calibrationInput);

    const groupCountRow = document.createElement('div');
    groupCountRow.className = 'assignment-form-row';
    const groupCountLabel = document.createElement('label');
    groupCountLabel.htmlFor = 'assignment-group-count';
    groupCountLabel.textContent = t('assignment_wizardGroupCountLabel');
    const groupCountInput = document.createElement('input');
    groupCountInput.type = 'number';
    groupCountInput.id = groupCountLabel.htmlFor;
    groupCountInput.min = '1';
    groupCountInput.max = String(Math.max(totalCount, 1));
    groupCountInput.value = String(Math.max(initialConfig.groupCount || 4, 1));
    groupCountRow.appendChild(groupCountLabel);
    groupCountRow.appendChild(groupCountInput);

    const preview = document.createElement('p');
    preview.className = 'assignment-preview';

    const renderPreview = () => {
        const calibrationRaw = parseInt(calibrationInput.value || '', 10);
        const groupCountRaw = parseInt(groupCountInput.value || '', 10);

        if (
            Number.isNaN(calibrationRaw) || calibrationRaw < 0 || calibrationRaw > totalCount
            || Number.isNaN(groupCountRaw) || groupCountRaw < 1
        ) {
            preview.textContent = t('assignment_wizardPreviewInvalid');
            preview.classList.add('assignment-preview--invalid');
            return;
        }

        preview.classList.remove('assignment-preview--invalid');
        const remaining = totalCount - calibrationRaw;

        if (remaining <= 0) {
            preview.textContent = t('assignment_wizardPreviewNoRest', String(calibrationRaw));
            return;
        }

        const perTeam = Math.ceil(remaining / groupCountRaw);
        preview.textContent = t('assignment_wizardPreview', [
            String(calibrationRaw),
            String(remaining),
            String(groupCountRaw),
            String(perTeam),
        ]);
    };

    const reviewerHelp = document.createElement('p');
    reviewerHelp.className = 'assignment-help';
    reviewerHelp.textContent = t('assignment_wizardReviewerHelp');

    const reviewerGrid = document.createElement('div');
    reviewerGrid.className = 'assignment-group-grid';

    const renderReviewerGrid = () => {
        const groupCount = Math.max(parseInt(groupCountInput.value || '0', 10), 1);
        const existingInputs = reviewerGrid.querySelectorAll<HTMLInputElement>('input[data-set-id]');
        existingInputs.forEach((input) => {
            groupValues.set(input.dataset.setId || '', input.value);
        });

        reviewerGrid.innerHTML = '';
        for (let index = 1; index <= groupCount; index += 1) {
            const setId = `group-${index}`;
            const row = document.createElement('div');
            row.className = 'assignment-group-row';

            const label = document.createElement('label');
            label.htmlFor = `assignment-wizard-reviewers-${setId}`;
            label.textContent = t('assignment_wizardReviewerLabel', String(index));

            const input = document.createElement('input');
            input.type = 'text';
            input.id = label.htmlFor;
            input.dataset.setId = setId;
            input.placeholder = t('assignment_reviewerPlaceholder');
            input.value = groupValues.get(setId) || (initialConfig.reviewerMap[setId] || []).join(', ');

            row.appendChild(label);
            row.appendChild(input);
            reviewerGrid.appendChild(row);
        }
    };

    calibrationInput.addEventListener('input', renderPreview);
    groupCountInput.addEventListener('input', () => {
        renderPreview();
        renderReviewerGrid();
    });
    renderPreview();
    renderReviewerGrid();

    form.appendChild(calibrationRow);
    form.appendChild(groupCountRow);

    container.appendChild(intro);
    container.appendChild(total);
    container.appendChild(form);
    container.appendChild(preview);
    container.appendChild(reviewerHelp);
    container.appendChild(reviewerGrid);

    const footer = document.createElement('div');
    footer.className = 'assignment-modal-actions';

    if (!isReshuffle) {
        const noButton = document.createElement('button');
        noButton.className = 'btn btn-outline btn-small';
        noButton.textContent = t('assignment_wizardNo');
        noButton.addEventListener('click', () => {
            void dismissAssignmentWizard();
        });
        footer.appendChild(noButton);
    }

    const createButton = document.createElement('button');
    createButton.className = 'btn btn-primary btn-small';
    createButton.textContent = isReshuffle
        ? t('assignment_settingsReshuffle')
        : t('assignment_wizardCreate');
    createButton.addEventListener('click', () => {
        void saveAssignmentWizard(calibrationInput, groupCountInput, reviewerGrid, isReshuffle);
    });

    footer.appendChild(createButton);

    _wizardOpen = true;
    showModal({
        title: t('assignment_wizardTitle'),
        body: container,
        footer,
        onClose: () => {
            _wizardOpen = false;
        },
    });
}

async function dismissAssignmentWizard() {
    try {
        showLoading(true);
        const nextConfig: AssignmentConfig = {
            ...createDefaultAssignmentConfig(),
            status: 'dismissed',
            dismissedAt: new Date().toISOString(),
        };
        await saveAssignmentConfig(state.spreadsheetId, nextConfig);
        state.setAssignmentConfig(nextConfig);
        renderAssignmentManager();
        hideModal();
        showToast(t('assignment_dismissed'));
    } catch (error) {
        console.error('Assignment dismiss error:', error);
        showToast(t('assignment_settingsMapError', (error as Error).message));
    } finally {
        showLoading(false);
    }
}

async function saveAssignmentWizard(
    calibrationInput: HTMLInputElement,
    groupCountInput: HTMLInputElement,
    reviewerGrid: HTMLElement,
    isReshuffle: boolean = false
) {
    const calibrationSize = parseInt(calibrationInput.value || '0', 10);
    const groupCount = parseInt(groupCountInput.value || '0', 10);
    const totalCount = state.references.length;

    if (Number.isNaN(calibrationSize) || calibrationSize < 0 || calibrationSize > totalCount) {
        showToast(t('assignment_wizardValidationCalibration', String(totalCount)));
        return;
    }

    if (Number.isNaN(groupCount) || groupCount < 1) {
        showToast(t('assignment_wizardValidationGroupCount'));
        return;
    }

    try {
        showLoading(true);
        const seed = String(Date.now());
        const assignments = buildReferenceAssignments(state.references, calibrationSize, groupCount, seed);
        const reviewerMap = parseReviewerMapFromInputs(reviewerGrid, groupCount);
        const nextConfig: AssignmentConfig = {
            status: 'configured',
            calibrationSize,
            groupCount,
            reviewerMap,
            seed,
            generatedAt: new Date().toISOString(),
        };

        await updateReferenceScreeningSets(state.spreadsheetId, assignments);
        await saveAssignmentConfig(state.spreadsheetId, nextConfig);
        state.setAssignmentConfig(nextConfig);
        hideModal();
        const toastKey = isReshuffle ? 'assignment_reshuffled' : 'assignment_configured';
        showToast(t(toastKey, [String(calibrationSize), String(groupCount)]), 3000);
        renderAssignmentManager();
        if (_loadDataAndShowScreening) {
            await _loadDataAndShowScreening();
        }
    } catch (error) {
        console.error('Assignment save error:', error);
        showToast(t('assignment_wizardCreateError', (error as Error).message), 4000);
    } finally {
        showLoading(false);
    }
}

function buildReferenceAssignments(
    refs: ReferenceWithStatus[],
    calibrationSize: number,
    groupCount: number,
    seed: string
): Array<{ refId: string; screeningSet: string }> {
    const shuffled = shuffleRefs(refs, seed);
    const assignments: Array<{ refId: string; screeningSet: string }> = [];

    shuffled.forEach((ref, index) => {
        if (index < calibrationSize) {
            assignments.push({ refId: ref.ref_id, screeningSet: 'calibration' });
            return;
        }

        const groupIndex = ((index - calibrationSize) % groupCount) + 1;
        assignments.push({ refId: ref.ref_id, screeningSet: `group-${groupIndex}` });
    });

    return assignments;
}

function shuffleRefs(refs: ReferenceWithStatus[], seed: string): ReferenceWithStatus[] {
    const result = [...refs];
    const random = createSeededRandom(seed);

    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
}

function createSeededRandom(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i += 1) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let stateValue = (h >>> 0) || 1;

    return () => {
        stateValue += 0x6D2B79F5;
        let tValue = stateValue;
        tValue = Math.imul(tValue ^ (tValue >>> 15), tValue | 1);
        tValue ^= tValue + Math.imul(tValue ^ (tValue >>> 7), tValue | 61);
        return ((tValue ^ (tValue >>> 14)) >>> 0) / 4294967296;
    };
}
