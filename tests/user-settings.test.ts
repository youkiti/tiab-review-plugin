import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_USER_SETTINGS,
    USER_SETTINGS_STORAGE_KEYS,
    parseUserSettings,
    toUserSettingsStorageRecord,
} from '../src/lib/user-settings';

test('個人設定がすべて欠落している場合は既定値へ戻す', () => {
    assert.deepEqual(parseUserSettings({}), DEFAULT_USER_SETTINGS);
});

test('個人設定の正常な値と明示的なfalseを保持する', () => {
    const raw = {
        autoNavigateAfterDecision: false,
        showRecordCountBelow: false,
        termFilterUseAnd: false,
        treatMlAsManual: false,
        abstractSubsectionBreakEnabled: true,
        abstractSubsectionHeadings: ['背景:', '結果:'],
    };
    assert.deepEqual(parseUserSettings(raw), { ...DEFAULT_USER_SETTINGS, ...raw });
});

test('真偽値の不正値は該当キーだけ既定値へ戻し、他の正常な設定は保持する', () => {
    for (const key of USER_SETTINGS_STORAGE_KEYS) {
        if (key === 'abstractSubsectionHeadings') continue;
        for (const value of ['true', 'yes', 0, 1, null, undefined, [], {}]) {
            const raw = { ...toUserSettingsStorageRecord(DEFAULT_USER_SETTINGS), [key]: value };
            raw.abstractSubsectionHeadings = ['独自見出し:'];
            const parsed = parseUserSettings(raw);
            assert.deepEqual(parsed, {
                ...DEFAULT_USER_SETTINGS,
                abstractSubsectionHeadings: ['独自見出し:'],
            });
        }
    }
});

test('文字列配列でない見出しは既定値へ戻す', () => {
    for (const value of ['Background:', 123, null, {}, [1], ['結果:', null]]) {
        assert.deepEqual(parseUserSettings({ abstractSubsectionHeadings: value }), DEFAULT_USER_SETTINGS);
    }
});

test('見出しの空文字と空行を除去し、空配列を有効値として保持する', () => {
    assert.deepEqual(
        parseUserSettings({ abstractSubsectionHeadings: ['背景:', '', '  ', '\t', ' 結果: '] }).abstractSubsectionHeadings,
        ['背景:', '結果:']
    );
    assert.deepEqual(parseUserSettings({ abstractSubsectionHeadings: [] }).abstractSubsectionHeadings, []);
});

test('未知のキーを無視し、元のレコードを書き換えない', () => {
    const raw = { otherSetting: { enabled: true }, autoNavigateAfterDecision: false };
    const before = structuredClone(raw);
    assert.deepEqual(parseUserSettings(raw), { ...DEFAULT_USER_SETTINGS, autoNavigateAfterDecision: false });
    assert.deepEqual(raw, before);
});

test('保存対象の設定は既存の6キーだけで往復できる', () => {
    const settings = {
        ...DEFAULT_USER_SETTINGS,
        autoNavigateAfterDecision: false,
        termFilterUseAnd: false,
        abstractSubsectionBreakEnabled: true,
        abstractSubsectionHeadings: ['背景:', '結論:'],
    };
    const stored = toUserSettingsStorageRecord(settings);
    assert.deepEqual(Object.keys(stored), [
        'autoNavigateAfterDecision', 'showRecordCountBelow', 'termFilterUseAnd',
        'treatMlAsManual', 'abstractSubsectionBreakEnabled', 'abstractSubsectionHeadings',
    ]);
    assert.deepEqual(parseUserSettings(stored), settings);
});

test('セッション内のAI表示状態を保存せず、ストレージの同名キーも読まない', () => {
    const settings = {
        ...DEFAULT_USER_SETTINGS,
        showAiHighlights: false,
        aiDecisionFilter: { 'llm:test': { include: false, exclude: true, maybe: false } },
    };
    const stored = toUserSettingsStorageRecord(settings);
    assert.equal('showAiHighlights' in stored, false);
    assert.equal('aiDecisionFilter' in stored, false);
    assert.deepEqual(parseUserSettings({ ...stored, ...settings }), DEFAULT_USER_SETTINGS);
});

test('パース結果や保存レコードの見出しを変更しても元データと既定値は変わらない', () => {
    const defaults = structuredClone(DEFAULT_USER_SETTINGS);
    const raw = { abstractSubsectionHeadings: ['背景:'] };
    const settings = parseUserSettings(raw);
    settings.abstractSubsectionHeadings.push('結果:');
    settings.aiDecisionFilter.test = { include: false, exclude: false };
    const stored = toUserSettingsStorageRecord(settings);
    (stored.abstractSubsectionHeadings as string[]).push('結論:');
    assert.deepEqual(raw.abstractSubsectionHeadings, ['背景:']);
    assert.deepEqual(settings.abstractSubsectionHeadings, ['背景:', '結果:']);
    assert.deepEqual(DEFAULT_USER_SETTINGS, defaults);
});
