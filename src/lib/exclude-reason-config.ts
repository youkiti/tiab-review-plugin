// exclude-reason-config.ts - フルテキスト除外理由リストのプロジェクト設定（Config タブ）
//
// SR のフレームワークは PICO だけではない（scoping review の PCC、質的研究の SPIDER など）。
// 除外理由をコード側に固定していると PICO 以外のレビューで区分が合わないため、
// プロジェクトごとに理由リストを編集できるようにした。
//
// 保存先: Config タブの `fulltext_exclude_reasons` キー（JSON文字列）。
// 未設定のプロジェクトは既定の PICO 7区分（DEFAULT_EXCLUDE_REASON_ITEMS）で動く。
//
// 保存値（key）は Decisions シートの reason 列に入る**過去データの参照キー**なので、
// 一度発番したら変えないこと（ラベルはいつ変えてもよい）。項目を削除しても過去の判定は
// 消えず、表示は excludeReasonLabel のフォールバックで生キーのまま残る。
//
// DOM/chrome API には依存しない（tests/ から直接 import してテストするため）。

import { DEFAULT_EXCLUDE_REASON_ITEMS, type ExcludeReasonItem } from './exclude-reasons';

/** Config タブ fulltext_exclude_reasons に JSON で保存する値 */
export interface ExcludeReasonConfig {
    /** 除外理由リスト。**配列の順序が優先順位**（先頭ほど上位） */
    items: ExcludeReasonItem[];
    /** ISO 8601。更新の識別用 */
    updated_at: string;
    /** 更新者 email */
    updated_by: string;
}

/** 1プロジェクトで持てる理由の上限。多すぎると判定者間で理由が割れて裁定が増える。 */
export const MAX_EXCLUDE_REASON_ITEMS = 12;

/** ラベルの最大長（表示崩れ防止。UI 側のバリデーションで使う） */
export const MAX_REASON_LABEL_LENGTH = 60;

/** 自動発番キーの接頭辞（既定キー population 等と衝突しない形にしている） */
const GENERATED_KEY_PREFIX = 'r';

/**
 * 理由リストのプリセット。
 * 既存データとの互換のため、意味が同じ区分は既定と同じ key を使い回している
 * （例: PCC の Population は 'population'）。
 */
export interface ExcludeReasonPreset {
    id: string;
    /** プリセット名（UI 表示用。i18n せずフレームワーク名をそのまま出す） */
    name: string;
    items: ExcludeReasonItem[];
}

export const EXCLUDE_REASON_PRESETS: readonly ExcludeReasonPreset[] = [
    {
        id: 'pico',
        name: 'PICO（既定）',
        items: DEFAULT_EXCLUDE_REASON_ITEMS.map(i => ({ ...i })),
    },
    {
        id: 'peco',
        name: 'PECO',
        items: [
            { key: 'population', label: 'Population 不適合', labelEn: 'Ineligible population' },
            { key: 'exposure', label: 'Exposure 不適合', labelEn: 'Ineligible exposure' },
            { key: 'comparator', label: 'Comparator 不適合', labelEn: 'Ineligible comparator' },
            { key: 'outcome', label: 'Outcome 不適合', labelEn: 'Ineligible outcome' },
            { key: 'study_design', label: 'Study design 不適合', labelEn: 'Ineligible study design' },
            { key: 'duplicate', label: '重複', labelEn: 'Duplicate report' },
            { key: 'other', label: 'その他', labelEn: 'Other reasons' },
        ],
    },
    {
        id: 'pcc',
        name: 'PCC（scoping review）',
        items: [
            { key: 'population', label: 'Population 不適合', labelEn: 'Ineligible population' },
            { key: 'concept', label: 'Concept 不適合', labelEn: 'Ineligible concept' },
            { key: 'context', label: 'Context 不適合', labelEn: 'Ineligible context' },
            { key: 'source_type', label: '文献タイプ不適合', labelEn: 'Ineligible source type' },
            { key: 'duplicate', label: '重複', labelEn: 'Duplicate report' },
            { key: 'other', label: 'その他', labelEn: 'Other reasons' },
        ],
    },
    {
        id: 'spider',
        name: 'SPIDER（質的研究）',
        items: [
            { key: 'sample', label: 'Sample 不適合', labelEn: 'Ineligible sample' },
            { key: 'phenomenon', label: 'Phenomenon of Interest 不適合', labelEn: 'Ineligible phenomenon of interest' },
            { key: 'design', label: 'Design 不適合', labelEn: 'Ineligible design' },
            { key: 'evaluation', label: 'Evaluation 不適合', labelEn: 'Ineligible evaluation' },
            { key: 'research_type', label: 'Research type 不適合', labelEn: 'Ineligible research type' },
            { key: 'duplicate', label: '重複', labelEn: 'Duplicate report' },
            { key: 'other', label: 'その他', labelEn: 'Other reasons' },
        ],
    },
];

/** プリセットを id で引く（未知の id は undefined） */
export function findExcludeReasonPreset(id: string): ExcludeReasonPreset | undefined {
    return EXCLUDE_REASON_PRESETS.find(p => p.id === id);
}

/**
 * Config タブ fulltext_exclude_reasons の値（JSON文字列）をパースする。
 *
 * - 空文字・undefined・null → null（未設定＝既定の7区分を使う）
 * - JSON パース失敗・形が違う・有効な項目が0件 → null
 *   （壊れた設定で「選択肢が1つも無い」画面になるより、既定に戻すほうが安全）
 * - key / label が非空文字列の項目だけを採用し、key が重複する場合は先勝ちで捨てる
 * - labelEn が無い項目は空文字（表示時に label で代替される）
 */
export function parseExcludeReasonConfig(raw: string | undefined | null): ExcludeReasonConfig | null {
    if (!raw) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.items)) return null;

    const seen = new Set<string>();
    const items: ExcludeReasonItem[] = [];
    for (const rawItem of obj.items) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        const key = typeof item.key === 'string' ? item.key.trim() : '';
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        if (!key || !label || seen.has(key)) continue;
        seen.add(key);
        items.push({
            key,
            label,
            labelEn: typeof item.labelEn === 'string' ? item.labelEn.trim() : '',
        });
    }

    if (items.length === 0) return null;

    return {
        items,
        updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
        updated_by: typeof obj.updated_by === 'string' ? obj.updated_by : '',
    };
}

/** ExcludeReasonConfig を Config タブへ保存する JSON 文字列に変換する */
export function serializeExcludeReasonConfig(config: ExcludeReasonConfig): string {
    return JSON.stringify(config);
}

/** 設定（未設定なら null）から、実際に使う理由リストを決める */
export function resolveExcludeReasonItems(
    config: ExcludeReasonConfig | null | undefined
): readonly ExcludeReasonItem[] {
    if (!config || config.items.length === 0) return DEFAULT_EXCLUDE_REASON_ITEMS;
    return config.items;
}

/**
 * 新規項目の内部キーを自動発番する（r1, r2, ...）。
 * 既存キーと衝突しない最小の番号を返す。過去データの参照キーになるため、
 * 一度使ったキーは項目を消しても再利用したくない場合は existingKeys に渡すこと。
 */
export function nextExcludeReasonKey(existingKeys: readonly string[]): string {
    const used = new Set(existingKeys);
    for (let n = 1; ; n++) {
        const key = `${GENERATED_KEY_PREFIX}${n}`;
        if (!used.has(key)) return key;
    }
}

/** 編集内容の検証結果。ok が false のとき message を UI に出す。 */
export interface ExcludeReasonValidation {
    ok: boolean;
    message: string;
}

/**
 * 編集中の理由リストを保存してよいか検証する。
 *
 * - 1件以上あること（0件だと除外の理由が選べなくなる）
 * - 上限件数を超えないこと
 * - 全項目にラベルがあること／ラベルが長すぎないこと
 * - ラベルが重複しないこと（判定者が同じ意味の選択肢で迷い、理由が割れる原因になる）
 */
export function validateExcludeReasonItems(items: readonly ExcludeReasonItem[]): ExcludeReasonValidation {
    if (items.length === 0) {
        return { ok: false, message: '除外理由は1件以上必要です' };
    }
    if (items.length > MAX_EXCLUDE_REASON_ITEMS) {
        return { ok: false, message: `除外理由は${MAX_EXCLUDE_REASON_ITEMS}件までです` };
    }
    if (items.some(i => i.label.trim() === '')) {
        return { ok: false, message: '空のラベルがあります' };
    }
    if (items.some(i => i.label.trim().length > MAX_REASON_LABEL_LENGTH)) {
        return { ok: false, message: `ラベルは${MAX_REASON_LABEL_LENGTH}文字までです` };
    }
    const labels = items.map(i => i.label.trim());
    if (new Set(labels).size !== labels.length) {
        return { ok: false, message: '同じラベルの項目が複数あります' };
    }
    const keys = items.map(i => i.key);
    if (new Set(keys).size !== keys.length) {
        return { ok: false, message: '内部キーが重複しています' };
    }
    return { ok: true, message: '' };
}
