// fulltext-pool.ts - フルテキスト候補プールの共通ロジック
//
// 「どの判定主体(voter)の票を採用し、Include何票で候補入りとするか」を
// プロジェクト単位のルール (FulltextPoolRule, Configシートに保存) として扱う。
// サイドパネルの fulltext_candidates フィルタとフルテキストページの
// 候補リストの両方がこのモジュールを使い、同じ集合を見る。

import type { Decision } from './types';
import { isHumanDecision, isMlDecision } from './client-version';
import { t } from './i18n';

export type VoterKind = 'human' | 'ml' | 'llm';

/**
 * フルテキスト候補ルール（Configシート fulltext_pool_rule キーにJSONで保存）
 */
export interface FulltextPoolRule {
    version: 1;
    voters: string[];   // 採用するvoterキー
    threshold: number;  // 候補入りに必要なInclude票数
}

/**
 * Decisionsから発見されたvoter（ルール設定UIの表示用）
 */
export interface VoterInfo {
    key: string;
    kind: VoterKind;
    label: string;
    includeCount: number;  // このvoterがTiAbでIncludeした文献数（voter内最新判定ベース）
}

/**
 * TiAbフェーズの判定か（screening_phase省略時はtiab扱い・後方互換）
 */
export function isTiabDecision(d: Decision): boolean {
    return (d.screening_phase ?? 'tiab') === 'tiab';
}

/**
 * Decision から voter キーを導出する
 * - LLM判定: reviewer_id をそのまま（`llm:{model}@{timestamp}` 形式、実行ごとに別voter）
 * - ML判定: `ml:{email}`（確定/自動を区別しない）
 * - 人間判定: `human:{email}`（client_version不明の旧データも人間扱い）
 */
export function voterKeyOf(d: Decision): string | null {
    const reviewerId = (d.reviewer_id || '').trim();
    if (!reviewerId) return null;
    if (reviewerId.startsWith('llm:')) return reviewerId;
    if (isMlDecision(d.client_version) && !isHumanDecision(d.client_version)) {
        return `ml:${reviewerId}`;
    }
    return `human:${reviewerId}`;
}

export function voterKindOf(key: string): VoterKind {
    if (key.startsWith('llm:')) return 'llm';
    if (key.startsWith('ml:')) return 'ml';
    return 'human';
}

export function voterLabelOf(key: string): string {
    if (key.startsWith('llm:')) return `LLM: ${key.slice('llm:'.length)}`;
    if (key.startsWith('ml:')) return `${key.slice('ml:'.length)} (ML)`;
    return key.slice('human:'.length);
}

/**
 * 1文献分の判定からInclude票数を数える
 *
 * - ルールで採用された voter の TiAb 判定のみ対象
 * - 同一人物の human:/ml: 票は1票に統合（二重計上防止）。
 *   統合時はその人物の最新判定を採る（include→excludeと変えた場合は票なし）
 * - LLM は reviewer_id（実行）ごとに独立した1票
 */
export function countIncludeVotes(decisions: Decision[], rule: FulltextPoolRule): number {
    const selected = new Set(rule.voters);

    // 票主体（人物 or LLM実行）ごとの最新判定
    const latest = new Map<string, Decision>();
    for (const d of decisions) {
        if (!isTiabDecision(d)) continue;
        const key = voterKeyOf(d);
        if (!key || !selected.has(key)) continue;
        const personKey = key.startsWith('llm:') ? key : `person:${(d.reviewer_id || '').trim()}`;
        const existing = latest.get(personKey);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            latest.set(personKey, d);
        }
    }

    let votes = 0;
    for (const d of latest.values()) {
        if (d.decision === 'include') votes++;
    }
    return votes;
}

/**
 * 1文献がフルテキスト候補プールに入るか
 */
export function isInFulltextPool(decisions: Decision[], rule: FulltextPoolRule): boolean {
    return countIncludeVotes(decisions, rule) >= rule.threshold;
}

/**
 * 全判定から voter 一覧を発見する（ルール設定UI用）
 * includeCount は voter × 文献ごとに最新判定を採ってカウントする
 */
export function discoverVoters(decisions: Decision[]): VoterInfo[] {
    // voterKey -> ref_id -> 最新判定
    const byVoter = new Map<string, Map<string, Decision>>();

    for (const d of decisions) {
        if (!isTiabDecision(d)) continue;
        const key = voterKeyOf(d);
        if (!key) continue;
        let byRef = byVoter.get(key);
        if (!byRef) {
            byRef = new Map();
            byVoter.set(key, byRef);
        }
        const existing = byRef.get(d.ref_id);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            byRef.set(d.ref_id, d);
        }
    }

    const voters: VoterInfo[] = [];
    for (const [key, byRef] of byVoter) {
        let includeCount = 0;
        for (const d of byRef.values()) {
            if (d.decision === 'include') includeCount++;
        }
        voters.push({
            key,
            kind: voterKindOf(key),
            label: voterLabelOf(key),
            includeCount,
        });
    }

    // human -> ml -> llm の順、同種内はキー順
    const kindOrder: Record<VoterKind, number> = { human: 0, ml: 1, llm: 2 };
    voters.sort((a, b) =>
        kindOrder[a.kind] - kindOrder[b.kind] || a.key.localeCompare(b.key)
    );
    return voters;
}

/**
 * 保存値の妥当性チェック付きパース（不正値は null）
 */
export function parseFulltextPoolRule(json: string): FulltextPoolRule | null {
    try {
        const parsed = JSON.parse(json) as Partial<FulltextPoolRule>;
        if (
            parsed &&
            Array.isArray(parsed.voters) &&
            parsed.voters.every(v => typeof v === 'string') &&
            typeof parsed.threshold === 'number' &&
            parsed.threshold >= 1
        ) {
            return { version: 1, voters: parsed.voters, threshold: parsed.threshold };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * ルール要約の表示文字列（i18n・例: ja "3票中2票" / en "2 of 3 votes"）
 * $1 = 採用voter数, $2 = 必要Include票数
 */
export function describeRule(rule: FulltextPoolRule): string {
    return t('filter_fulltextRuleSummary', [String(rule.voters.length), String(rule.threshold)]);
}
