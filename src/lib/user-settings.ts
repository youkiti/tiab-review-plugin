/** 個人の表示設定の定義・既定値・ストレージ境界（UI・通信には依存しない）。 */
export interface UserSettings {
    autoNavigateAfterDecision: boolean;
    showRecordCountBelow: boolean;
    termFilterUseAnd: boolean;
    treatMlAsManual: boolean;
    abstractSubsectionBreakEnabled: boolean;
    abstractSubsectionHeadings: string[];
    // Issue #154: 以下は既存のセッション内表示設定。ストレージへは保存しない。
    showAiHighlights: boolean;
    aiDecisionFilter: Record<string, { include: boolean; exclude: boolean; maybe?: boolean }>;
}

// 抄録サブセクション見出しのデフォルト
// 構造化抄録で見かける代表的な見出しを「コロン付き」の形でデフォルト提供。
// 大文字小文字は区別するため、各バリアントを別エントリとして列挙する。
export const DEFAULT_ABSTRACT_SUBSECTION_HEADINGS: string[] = [
    'Background:', 'BACKGROUND:',
    'Introduction:', 'INTRODUCTION:',
    'Objective:', 'OBJECTIVE:',
    'Objectives:', 'OBJECTIVES:',
    'Aim:', 'AIM:',
    'Aims:', 'AIMS:',
    'Purpose:', 'PURPOSE:',
    'Method:', 'METHOD:',
    'Methods:', 'METHODS:',
    'Materials and Methods:', 'MATERIALS AND METHODS:',
    'Design:', 'DESIGN:',
    'Setting:', 'SETTING:',
    'Participants:', 'PARTICIPANTS:',
    'Patients:', 'PATIENTS:',
    'Intervention:', 'INTERVENTION:',
    'Interventions:', 'INTERVENTIONS:',
    'Main Outcome Measures:', 'MAIN OUTCOME MEASURES:',
    'Outcomes:', 'OUTCOMES:',
    'Results:', 'RESULTS:',
    'Findings:', 'FINDINGS:',
    'Discussion:', 'DISCUSSION:',
    'Conclusion:', 'CONCLUSION:',
    'Conclusions:', 'CONCLUSIONS:',
];

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = Object.freeze({
    autoNavigateAfterDecision: true,
    showRecordCountBelow: true,
    termFilterUseAnd: true,
    treatMlAsManual: true,
    abstractSubsectionBreakEnabled: false,
    abstractSubsectionHeadings: DEFAULT_ABSTRACT_SUBSECTION_HEADINGS,
    showAiHighlights: true,
    aiDecisionFilter: {},
});

// Issue #154: 既存の6キーと値の形を維持する。一時的なAI表示状態は保存しない。
export const USER_SETTINGS_STORAGE_KEYS = [
    'autoNavigateAfterDecision',
    'showRecordCountBelow',
    'termFilterUseAnd',
    'treatMlAsManual',
    'abstractSubsectionBreakEnabled',
    'abstractSubsectionHeadings',
] satisfies (keyof UserSettings)[];

/** 不正な値はキーごとに既定値へ戻し、未知のキーは無視する。 */
export function parseUserSettings(raw: Record<string, unknown>): UserSettings {
    const settings: UserSettings = {
        ...DEFAULT_USER_SETTINGS,
        abstractSubsectionHeadings: [...DEFAULT_USER_SETTINGS.abstractSubsectionHeadings],
        aiDecisionFilter: { ...DEFAULT_USER_SETTINGS.aiDecisionFilter },
    };
    for (const key of USER_SETTINGS_STORAGE_KEYS) {
        const value = raw[key];
        if (key === 'abstractSubsectionHeadings') {
            if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
                // 空配列は「見出しなし」という従来の有効値。画面入力と同じく空行を除く。
                settings[key] = value.map(item => item.trim()).filter(item => item.length > 0);
            }
        } else if (typeof value === 'boolean') {
            settings[key] = value;
        }
    }
    return settings;
}

/** 保存対象だけを返す。storageSet の部分更新により、未知の既存キーを消さない。 */
export function toUserSettingsStorageRecord(settings: UserSettings): Record<string, unknown> {
    return Object.fromEntries(USER_SETTINGS_STORAGE_KEYS.map(key => [
        key,
        key === 'abstractSubsectionHeadings' ? [...settings[key]] : settings[key],
    ]));
}
