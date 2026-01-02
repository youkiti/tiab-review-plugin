import { state } from '../../state';
import { mlClient } from '../../../lib/ml/worker-client';
import {
    saveDecision as apiSaveDecision,
    getReferencesWithStatus
} from '../../../lib/sheets-api';
import { Decision } from '../../../lib/types';
import { MlRecord, Label } from '../../../lib/ml/types';
import { renderMlSection, renderMlStats } from './render';
import { showStoppingSettingsDialog, showStoppingReachedDialog } from './stopping';
import { updateStoppingProgress, isStoppingReached } from '../../../lib/ml/stopping-rules';
import { showToast, showLoading } from '../../ui/feedback';

// Map ML Label type
function mapDecisionToLabel(decision: 'include' | 'exclude'): 1 | 0 {
    return decision === 'include' ? 1 : 0;
}

const elements = {
    buttons: {
        include: () => document.getElementById('ml-btn-include'),
        exclude: () => document.getElementById('ml-btn-exclude'),
        skip: () => document.getElementById('ml-btn-skip'),
        stoppingSettings: () => document.getElementById('ml-stopping-settings-btn'),
        back: () => document.getElementById('ml-back-btn'),
    }
};

export function initMlHandlers() {
    // Buttons
    elements.buttons.include()?.addEventListener('click', () => handleMlDecision('include'));
    elements.buttons.exclude()?.addEventListener('click', () => handleMlDecision('exclude'));
    elements.buttons.skip()?.addEventListener('click', () => handleMlNext());

    elements.buttons.stoppingSettings()?.addEventListener('click', () => {
        showStoppingSettingsDialog();
    });

    elements.buttons.back()?.addEventListener('click', () => {
        // Go back to screening tab (handled by external router logic usually, but here simple switch)
        // Assuming there is a global tab switcher, but for now specific back button logic
        document.getElementById('tab-screening')?.click();
    });

    // Subscribe to Worker updates
    mlClient.subscribe((newState) => {
        state.setMlState(newState);
        renderMlStats();

        // If ranking updated, re-render current reference (might change)
        if (state.currentTab === 'ml') {
            // If we are showing 'No more records' or similar, check if new ranking helps
            // But mainly just refresh the view
            // Note: Changing reference under user's eyes might be jarring?
            // ASReview updates ranking in background but doesn't swap current card unless user clicks next?
            // But if we are at list head, the head changes.
            // We should only update if we are not interacting. 
            // For now simple re-render.
            renderMlSection();
        }
    });
}

export async function activateMlTab() {
    state.setCurrentTab('ml');
    renderMlSection();

    // Check if initialization needed
    if (state.mlState.status === 'idle') {
        await initMlWorker();
    }
}

async function initMlWorker() {
    // 1. Prepare records for Worker (mlRecord format)
    // We use all references currently loaded
    const mlRecords = state.references.map(r => ({
        refId: r.ref_id, // Map id to refId
        title: r.title || '',
        abstract: r.abstract || ''
    }));

    // 2. Prepare Labels
    // We need to fetch current labels map
    const labels: Record<string, 1 | 0 | -1> = {};

    // We should use references' status if available
    state.references.forEach(r => {
        if (r.myDecision?.decision === 'include') labels[r.ref_id] = 1;
        else if (r.myDecision?.decision === 'exclude') labels[r.ref_id] = 0;
    });

    mlClient.init(mlRecords, labels);
}

async function handleMlDecision(decision: 'include' | 'exclude') {
    // 1. Identify current record
    const ref = getCurrentMlReference();
    if (!ref) return;

    // 2. Save decision
    const decisionObj: Decision = {
        decision_id: ref.myDecision?.decision_id || crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: state.userEmail,
        decision,
        decided_at: new Date().toISOString(),
        client_version: '0.1.0',
    };
    ref.myDecision = decisionObj;
    ref.status = decision; // Local update

    // API Save (background)
    apiSaveDecision(state.spreadsheetId, decisionObj).catch(err => {
        console.error('Failed to save decision', err);
        showToast('保存に失敗しました'); // Fixed: removed 'error'
    });

    // 3. Update Stopping Rule
    if (state.mlState.stoppingRule) {
        // Pass decision ('include' | 'exclude') directly as expected by updateStoppingProgress
        const newRule = updateStoppingProgress(state.mlState.stoppingRule, decision);
        state.setMlState({
            ...state.mlState,
            stoppingRule: newRule
        });

        // Check stopping condition
        if (isStoppingReached(newRule)) {
            showStoppingReachedDialog(
                (addCount) => {
                    // Extend threshold
                    const extendedRule = { ...newRule, threshold: newRule.threshold + addCount };
                    state.setMlState({
                        ...state.mlState,
                        stoppingRule: extendedRule
                    });
                    renderMlStats();
                    handleMlNext(); // Continue to next
                },
                () => {
                    // Finish
                    showToast('スクリーニングを終了します');
                    // Maybe redirect or show summary?
                }
            );
            return; // Don't move next automatically if dialog shown?
            // Actually ASReview shows dialog. User chooses.
        }
    }

    // 4. Update Worker (NB model)
    const labels: Record<string, 1 | 0 | -1> = {};
    labels[ref.ref_id] = mapDecisionToLabel(decision);
    mlClient.updateLabels(labels);

    // 5. Move next
    handleMlNext();
}

function handleMlNext() {
    // Advance index to next UNLABELED item in ranking
    moveToNextUnlabeled();
    renderMlSection();
}

function moveToNextUnlabeled() {
    const ranking = state.mlState.ranking;
    if (!ranking || ranking.length === 0) {
        // Fallback to simple index increment of state.references?
        // But render uses ranking.
        return;
    }

    let currentIndex = state.mlState.currentIndex;

    // Start searching from current + 1
    // But we need to check if current item is labeled.
    // The ranking might change asynchronously.
    // Strategy: scan ranking from top (0) until we find an unlabeled item.
    // This ensures we always pick the highest prob unlabeled item.

    let foundIndex = -1;
    for (let i = 0; i < ranking.length; i++) {
        const refId = ranking[i];
        const ref = state.references.find(r => r.ref_id === refId);
        if (ref) {
            // Check if labeled by ME
            // We use ref.status or ref.myDecision
            const isLabeled = ref.myDecision && ref.myDecision.decision !== 'pending';
            if (!isLabeled) {
                foundIndex = i;
                break;
            }
        }
    }

    if (foundIndex !== -1) {
        state.setMlState({
            ...state.mlState,
            currentIndex: foundIndex
        });
    } else {
        // All labeled?
        // Keep index at end or show finished?
        state.setMlState({
            ...state.mlState,
            currentIndex: ranking.length
        });
    }
}

function getCurrentMlReference() {
    const ranking = state.mlState.ranking;
    const index = state.mlState.currentIndex;

    if (ranking.length > 0) {
        if (index >= ranking.length) return null;
        const refId = ranking[index];
        return state.references.find(r => r.ref_id === refId) || null;
    }

    // Fallback
    if (state.references.length > 0 && index < state.references.length) {
        return state.references[index];
    }
    return null;
}
