// exclude-reasons.ts - フルテキスト除外理由（PRISMA区分）の型・既定値・純粋関数
//
// 除外理由は**並び順そのものが優先順位**で、複数当てはまる場合は番号の小さい理由を選ぶ運用に
// している。理由が判定者ごとに割れるとあとで裁定（不一致解消）が必要になるため、選択肢を
// 減らして割れにくくするのが狙い。
//
// 以前は既定の7区分（Population〜その他）をこのモジュールに固定していたが、PCC（scoping
// review）など PICO 以外のフレームワークでは区分が合わないため、**プロジェクトごとに
// 項目を編集できる**ようにした（Config タブ fulltext_exclude_reasons。
// パース・保存・プリセットは src/lib/exclude-reason-config.ts）。
//
// このモジュールは「理由リスト（ExcludeReasonItem[]）を引数で受け取って計算する純粋関数」だけを
// 持つ。理由リストを省略した場合は既定の7区分（DEFAULT_EXCLUDE_REASON_ITEMS）で動くため、
// 未設定プロジェクトは従来どおりの挙動になる。DOM/i18n には依存しない。

/** 除外理由1件。key はシートに保存する値、label は画面表示、labelEn は論文用テキスト・PRISMA図用。 */
export interface ExcludeReasonItem {
    /** 保存値（Decisions シートの reason 列に入る）。作成後は変更しないこと（過去データが読めなくなる） */
    key: string;
    /** 表示ラベル（日本語想定） */
    label: string;
    /** 英語ラベル。空なら label で代替する */
    labelEn: string;
}

/**
 * 既定（PICO）の除外理由リスト。**唯一の定義源**。配列の順序が優先順位（先頭ほど上位）。
 * 既定区分を増減するときはここだけ触ればよい（EXCLUDE_REASON_VALUES / EXCLUDE_REASON_LABELS /
 * EXCLUDE_REASON_LABELS_EN / ExcludeReason 型はすべてこの配列からの派生値）。
 * `satisfies` により、項目追加時に label / labelEn の入れ忘れは typecheck で落ちる。
 */
const DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE = [
    { key: 'population', label: 'Population 不適合', labelEn: 'Ineligible population' },
    { key: 'intervention', label: 'Intervention 不適合', labelEn: 'Ineligible intervention' },
    { key: 'comparator', label: 'Comparator 不適合', labelEn: 'Ineligible comparator' },
    { key: 'outcome', label: 'Outcome 不適合', labelEn: 'Ineligible outcome' },
    { key: 'study_design', label: 'Study design 不適合', labelEn: 'Ineligible study design' },
    { key: 'duplicate', label: '重複', labelEn: 'Duplicate report' },
    { key: 'other', label: 'その他', labelEn: 'Other reasons' },
] as const satisfies readonly ExcludeReasonItem[];

export type ExcludeReason = typeof DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE[number]['key'];

/** 既定（PICO）の理由リスト。プロジェクト設定が無いときはこれを使う。 */
export const DEFAULT_EXCLUDE_REASON_ITEMS: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE;

/** 既定（PICO）の除外理由キー。**配列の順序が優先順位**（先頭ほど上位）。派生値。 */
export const EXCLUDE_REASON_VALUES: readonly ExcludeReason[] =
    DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE.map(i => i.key);

/** 既定の表示ラベル。派生値。 */
export const EXCLUDE_REASON_LABELS: Record<ExcludeReason, string> = DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE.reduce(
    (acc, i) => ({ ...acc, [i.key]: i.label }),
    {} as Record<ExcludeReason, string>
);

/**
 * PRISMA フロー図・論文用テキスト（manuscript.ts）向けの既定の英語ラベル。派生値。
 * 英語ラベルの追加漏れを防いでいるのはこの Record 型ではない（reduce + キャストで
 * 組み立てているだけなので、この Record<ExcludeReason, string> 自体には typecheck で
 * 漏れを検出する力はない）。保証の出どころは定義源 DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE の
 * `satisfies readonly ExcludeReasonItem[]`（labelEn が必須プロパティ）側。
 */
export const EXCLUDE_REASON_LABELS_EN: Record<ExcludeReason, string> = DEFAULT_EXCLUDE_REASON_ITEMS_SOURCE.reduce(
    (acc, i) => ({ ...acc, [i.key]: i.labelEn }),
    {} as Record<ExcludeReason, string>
);

/**
 * 数字キーで選べる上限。理由リストはこれより多くても保存・選択できるが、
 * 数字キーのショートカットは先頭9件までしか割り当てられない（1〜9）。
 */
export const MAX_REASON_HOTKEYS = 9;

/**
 * 1プロジェクトで持てる理由の上限。多すぎると判定者間で理由が割れて裁定が増える。
 * retiredKeys（exclude-reason-config.ts の ExcludeReasonConfig.retiredKeys）はこの上限に数えない。
 */
export const MAX_EXCLUDE_REASON_ITEMS = 15;

/** ラベルの最大長（表示崩れ防止。UI 側のバリデーション・Config パース時の切り詰めで使う） */
export const MAX_REASON_LABEL_LENGTH = 50;

/** 表示用ラベル（未知のキーはそのまま返す。空文字は「理由なし」の意味で空のまま） */
export function excludeReasonLabel(
    reason: string,
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    return items.find(i => i.key === reason)?.label ?? reason;
}

/**
 * 英語ラベル（PRISMA フロー図・論文用テキスト）。
 * 英語ラベル未入力の項目は日本語ラベルで代替する（空欄で英語出力が消えるより読める）。
 * 未知のキーはそのまま返す。
 */
export function excludeReasonLabelEn(
    reason: string,
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    const item = items.find(i => i.key === reason);
    if (!item) return reason;
    return item.labelEn.trim() || item.label;
}

/**
 * 優先順位（小さいほど上位）。未知の理由・空文字は最下位扱いにする。
 * 未知の値でも順序が安定するよう、必ず有限値を返すこと（集計が NaN で壊れないため）。
 */
export function excludeReasonRank(
    reason: string,
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): number {
    const idx = items.findIndex(i => i.key === reason);
    return idx < 0 ? items.length : idx;
}

/**
 * 判定者ごとにばらついた除外理由から、代表として1つ選ぶ。
 *
 * 「複数当てはまるときは番号の小さい方」という入力時の運用と同じ規則で決める。
 * 以前は「最初に見つかった非空の理由」を採用していたため、**判定者の列挙順**で
 * PRISMA の内訳が変わっていた（誰が先に判定したかで結果が動く）。
 *
 * @returns 最も上位の理由。有効な理由が1つも無ければ空文字。
 */
export function pickPrimaryExcludeReason(
    reasons: readonly string[],
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    let best = '';
    let bestRank = Number.POSITIVE_INFINITY;
    for (const raw of reasons) {
        const reason = (raw || '').trim();
        if (!reason) continue;
        const rank = excludeReasonRank(reason, items);
        if (rank < bestRank) {
            best = reason;
            bestRank = rank;
        }
    }
    return best;
}

/**
 * 除外理由が判定者間で割れているか（＝裁定が必要か）。
 * 空文字（理由未記入）は比較対象から外す。有効な理由が2種類以上あれば true。
 */
export function hasExcludeReasonConflict(reasons: readonly string[]): boolean {
    const set = new Set(reasons.map(r => (r || '').trim()).filter(Boolean));
    return set.size >= 2;
}

/**
 * 「どれにも当てはまらないとき」に落とす先の理由キー。
 *
 * **常に最後の項目**（＝優先順位が最下位）を使う。理由リストが空なら空文字。
 * 「その他」に相当する項目は末尾に置く運用（並び＝優先順位のため）。
 * 'other' というキー名を特別扱いしないこと（カスタム理由には存在しないことがあるうえ、
 * 存在しても末尾にあるとは限らない。位置だけで決める）。
 */
export function fallbackExcludeReasonKey(
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    if (items.length === 0) return '';
    return items[items.length - 1].key;
}

/**
 * AI が返した除外理由キーを、現在の理由リストに載る値へ正規化する。
 * リストに無い値（旧設定の理由・モデルの逸脱出力）はフォールバック理由に寄せる。
 */
export function normalizeExcludeReasonKey(
    reason: string | undefined | null,
    items: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    const value = (reason || '').trim();
    if (value && items.some(i => i.key === value)) return value;
    return fallbackExcludeReasonKey(items);
}
