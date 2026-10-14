/** 担当セットを分割しない選択の保存。画面の更新は呼び出し側で行う。 */
import { createDefaultAssignmentConfig } from './assignment-set';
import { saveAssignmentConfig } from './sheets-api';
import type { AssignmentConfig } from './types';

export async function dismissAssignment(spreadsheetId: string): Promise<AssignmentConfig> {
    const config: AssignmentConfig = {
        ...createDefaultAssignmentConfig(),
        status: 'dismissed', dismissedAt: new Date().toISOString(),
    };
    await saveAssignmentConfig(spreadsheetId, config);
    return config;
}
