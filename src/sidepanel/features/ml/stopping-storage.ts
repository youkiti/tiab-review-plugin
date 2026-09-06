import { state } from '../../state';

/**
 * 停止基準の設定をブラウザに保存（プロジェクトごと）
 */
export async function saveStoppingRuleToStorage(threshold: number): Promise<void> {
    const key = `mlStoppingRule_${state.spreadsheetId}`;
    await chrome.storage.local.set({
        [key]: { confirmed: true, threshold }
    });
}

