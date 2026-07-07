// fulltext-assignment.ts - フルテキスト担当割り振りの共通ロジック
//
// TiAb の AssignmentConfig / screening_set と対になる、フルテキストフェーズ専用の
// 割り振りモデル。候補プール（FulltextPoolRule で決まる集合）が確定した段階で、
// プール内の文献を ft-group-N に分割し、グループごとに担当レビュアーを割り当てる。
//
// - status 'none'（デフォルト）: 従来どおり全員が全候補を判定する
// - status 'configured': 各レビュアーは自分の担当グループ + 未割り当て文献のみを見る
//   （未割り当て = 割り振り後に候補プールへ新規流入した文献。取りこぼし防止のため全員に見せる）
// - 管理者は常に全候補を見る
//
// 永続化:
// - グループ構成・担当者 → Config シートの fulltext_assignment_* キー（sheets-api.ts）
// - 文献ごとの所属グループ → References シートの fulltext_set 列（screening_set と同型）

import { t } from './i18n';

export interface FulltextAssignmentConfig {
    status: 'none' | 'configured';
    groupCount: number;
    /** setId ('ft-group-1'...) -> 担当レビュアーのメールアドレス */
    reviewerMap: Record<string, string[]>;
    seed?: string;
    generatedAt?: string;
}

export const DEFAULT_FULLTEXT_ASSIGNMENT: FulltextAssignmentConfig = {
    status: 'none',
    groupCount: 2,
    reviewerMap: {},
};

export function createDefaultFulltextAssignment(): FulltextAssignmentConfig {
    return { ...DEFAULT_FULLTEXT_ASSIGNMENT, reviewerMap: {} };
}

function normalizeEmail(email: string): string {
    return (email || '').trim().toLowerCase();
}

export function normalizeFulltextReviewerMap(reviewerMap: Record<string, string[]>): Record<string, string[]> {
    const normalized: Record<string, string[]> = {};
    for (const [setId, reviewers] of Object.entries(reviewerMap || {})) {
        normalized[setId] = Array.from(new Set((reviewers || [])
            .map(normalizeEmail)
            .filter(Boolean)));
    }
    return normalized;
}

/** 指定レビュアーが担当するフルテキストセットID群（未設定時は空） */
export function getFulltextSetsForUser(config: FulltextAssignmentConfig, userEmail: string): Set<string> {
    const assigned = new Set<string>();
    if (config.status !== 'configured') return assigned;

    const normalized = normalizeEmail(userEmail);
    for (const [setId, reviewers] of Object.entries(config.reviewerMap || {})) {
        if ((reviewers || []).some((r) => normalizeEmail(r) === normalized)) {
            assigned.add(setId);
        }
    }
    return assigned;
}

/**
 * 文献のフルテキスト担当セットID
 * 割り振り設定済みで値が空なら 'unassigned'（割り振り後にプールへ入った文献）
 */
export function fulltextSetOf(
    ref: { fulltext_set?: string },
    config: FulltextAssignmentConfig
): string {
    const normalized = (ref.fulltext_set || '').trim();
    if (normalized) return normalized;
    return config.status === 'configured' ? 'unassigned' : '';
}

/**
 * この文献（候補プール内であることが前提）を自分のフルテキスト対象として表示するか
 * - 割り振り未設定: 全員が全候補（従来どおり）
 * - 管理者: 常に表示
 * - 未割り当て文献: 全員に表示（取りこぼし防止）
 */
export function canSeeFulltextRef(
    ref: { fulltext_set?: string },
    config: FulltextAssignmentConfig,
    userEmail: string,
    isAdmin: boolean
): boolean {
    if (config.status !== 'configured') return true;
    if (isAdmin) return true;
    const setId = fulltextSetOf(ref, config);
    if (setId === 'unassigned') return true;
    return getFulltextSetsForUser(config, userEmail).has(setId);
}

/** セットIDの表示名（例: ft-group-2 → グループ2） */
export function getFulltextSetLabel(setId: string): string {
    if (setId === 'unassigned') return t('ftAssign_setUnassigned');
    if (setId.startsWith('ft-group-')) {
        return t('ftAssign_setGroup', setId.replace('ft-group-', ''));
    }
    return setId;
}

/**
 * 候補プール全体をシャッフルして ft-group-1..N へラウンドロビン分配する
 * （TiAb の buildReferenceAssignments と同じシード付きアルゴリズム）
 */
export function buildFulltextSetAssignments(
    refIds: string[],
    groupCount: number,
    seed: string
): Array<{ refId: string; fulltextSet: string }> {
    const shuffled = shuffleWithSeed(refIds, seed);
    return shuffled.map((refId, index) => ({
        refId,
        fulltextSet: `ft-group-${(index % groupCount) + 1}`,
    }));
}

/**
 * 未割り当て文献を既存グループへ追加分配する（再シャッフルなし）
 * 常に現在の件数が最少のグループへ入れて偏りを均す
 */
export function distributeUnassigned(
    unassignedRefIds: string[],
    groupCount: number,
    currentCounts: Map<string, number>,
    seed: string
): Array<{ refId: string; fulltextSet: string }> {
    const counts: Array<{ setId: string; count: number }> = [];
    for (let i = 1; i <= groupCount; i += 1) {
        const setId = `ft-group-${i}`;
        counts.push({ setId, count: currentCounts.get(setId) ?? 0 });
    }
    if (counts.length === 0) return [];

    const shuffled = shuffleWithSeed(unassignedRefIds, seed);
    const assignments: Array<{ refId: string; fulltextSet: string }> = [];
    for (const refId of shuffled) {
        let target = counts[0];
        for (const c of counts) {
            if (c.count < target.count) target = c;
        }
        target.count += 1;
        assignments.push({ refId, fulltextSet: target.setId });
    }
    return assignments;
}

function shuffleWithSeed<T>(items: T[], seed: string): T[] {
    const result = [...items];
    const random = createSeededRandom(seed);
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// assignment.ts と同じ mulberry32 系シード付き乱数
function createSeededRandom(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i += 1) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let stateValue = (h >>> 0) || 1;

    return () => {
        stateValue += 0x6D2B79F5;
        let tValue = stateValue;
        tValue = Math.imul(tValue ^ (tValue >>> 15), tValue | 1);
        tValue ^= tValue + Math.imul(tValue ^ (tValue >>> 7), tValue | 61);
        return ((tValue ^ (tValue >>> 14)) >>> 0) / 4294967296;
    };
}
