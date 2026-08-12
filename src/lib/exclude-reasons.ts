// exclude-reasons.ts - フルテキスト除外理由（PRISMA区分）の唯一の定義（純粋関数）
//
// 除外理由は「1. Population 不適合 … 7. その他」の**並び順そのものが優先順位**で、
// 複数当てはまる場合は番号の小さい理由を選ぶ運用にしている。理由が判定者ごとに割れると
// あとで裁定（不一致解消）が必要になるため、選択肢を減らして割れにくくするのが狙い。
//
// 以前は同じ並びが6か所（fulltext.html の option / fulltext.ts の REASON_VALUES と
// EXCLUDE_REASON_LABELS / fulltext-results.ts の REASON_LABELS / gemini-fulltext.ts の enum /
// manuscript.ts の REASON_LABELS_EN（英語ラベル））に複製されていた。
// 優先順位に意味を持たせる以上、並びは1か所で定義すること。
// DOM/i18n には依存しない。

/** 除外理由（PRISMA区分）。**配列の順序が優先順位**（先頭ほど上位）。 */
export const EXCLUDE_REASON_VALUES = [
    'population',
    'intervention',
    'comparator',
    'outcome',
    'study_design',
    'duplicate',
    'other',
] as const;

export type ExcludeReason = typeof EXCLUDE_REASON_VALUES[number];

/** 表示ラベル（fulltext.html の option テキストと一致させること） */
export const EXCLUDE_REASON_LABELS: Record<ExcludeReason, string> = {
    population: 'Population 不適合',
    intervention: 'Intervention 不適合',
    comparator: 'Comparator 不適合',
    outcome: 'Outcome 不適合',
    study_design: 'Study design 不適合',
    duplicate: '重複',
    other: 'その他',
};

/**
 * PRISMA フロー図・論文用テキスト（manuscript.ts）向けの英語ラベル。
 * Record<ExcludeReason, string> で型付けしているので、理由を1つ足したときに
 * 英語ラベルの追加漏れは typecheck で落ちる（静かに劣化しない）。
 */
export const EXCLUDE_REASON_LABELS_EN: Record<ExcludeReason, string> = {
    population: 'Ineligible population',
    intervention: 'Ineligible intervention',
    comparator: 'Ineligible comparator',
    outcome: 'Ineligible outcome',
    study_design: 'Ineligible study design',
    duplicate: 'Duplicate report',
    other: 'Other reasons',
};

/** 表示用ラベル（未知のキーはそのまま返す。空文字は「理由なし」の意味で空のまま） */
export function excludeReasonLabel(reason: string): string {
    return EXCLUDE_REASON_LABELS[reason as ExcludeReason] ?? reason;
}

/**
 * 優先順位（小さいほど上位）。未知の理由・空文字は最下位扱いにする。
 * 未知の値でも順序が安定するよう、必ず有限値を返すこと（集計が NaN で壊れないため）。
 */
export function excludeReasonRank(reason: string): number {
    const idx = (EXCLUDE_REASON_VALUES as readonly string[]).indexOf(reason);
    return idx < 0 ? EXCLUDE_REASON_VALUES.length : idx;
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
export function pickPrimaryExcludeReason(reasons: readonly string[]): string {
    let best = '';
    let bestRank = Number.POSITIVE_INFINITY;
    for (const raw of reasons) {
        const reason = (raw || '').trim();
        if (!reason) continue;
        const rank = excludeReasonRank(reason);
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
