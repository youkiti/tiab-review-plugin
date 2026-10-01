import { state } from '../../state';
import {
    parseSavedStoppingRule,
    type SavedStoppingRule,
    type StoppingRuleKind,
} from '../../../lib/ml/stopping-restore';

function storageKey(): string {
    return `mlStoppingRule_${state.spreadsheetId}`;
}

/**
 * 停止基準の設定をブラウザに保存（プロジェクトごと）
 *
 * `ruleType` を渡すと、どの基準を選んだかも保存する（再訪時に同じ基準を復元するため）。
 * 省略すると従来どおり `confirmed` と `threshold` だけを保存する。
 */
export async function saveStoppingRuleToStorage(threshold: number, ruleType?: StoppingRuleKind): Promise<void> {
    await chrome.storage.local.set({
        [storageKey()]: ruleType ? { confirmed: true, threshold, ruleType } : { confirmed: true, threshold }
    });
}

/**
 * 停止基準の設定をブラウザから読み込み（プロジェクトごと）
 */
export async function loadStoppingRuleFromStorage(): Promise<SavedStoppingRule> {
    const key = storageKey();
    const result = await chrome.storage.local.get([key]);
    return parseSavedStoppingRule(result[key]);
}
