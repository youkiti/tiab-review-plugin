import type { LlmConfig } from '../../../lib/types';
import { t } from '../../../lib/i18n';

export function modelMigrationNoticeKey(projectId: string, config: LlmConfig): string | null {
    return config.llm_model_migrated_from
        ? JSON.stringify([projectId, config.llm_model_migrated_from, config.llm_model]) : null;
}

const displayed = new Set<string>();

export function showModelMigrationNotice(projectId: string, config: LlmConfig, anchor: HTMLElement): void {
    const key = modelMigrationNoticeKey(projectId, config);
    const existing = document.getElementById('llm-model-migration-note');
    if (existing?.dataset.migrationKey === key) {
        return;
    }
    existing?.remove();
    if (!key || displayed.has(key)) {
        return;
    }
    const note = document.createElement('p');
    note.id = 'llm-model-migration-note';
    note.dataset.migrationKey = key;
    note.className = 'model-key-note warn';
    note.setAttribute('role', 'status');
    note.textContent = t('llm_modelMigrationNotice', [config.llm_model_migrated_from!, config.llm_model]);
    anchor.insertAdjacentElement('afterend', note);
    displayed.add(key);
}
