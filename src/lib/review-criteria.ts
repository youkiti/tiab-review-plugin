// review-criteria.ts - レビュー基準（組入・除外基準）の唯一の定義（純粋関数）
//
// 複数人でTiAb/フルテキストのスクリーニングを行う際、プロトコル文書を都度開かなくても
// 組入・除外基準を参照できるよう、拡張機能内に常設表示する機能の基盤モジュール。
// Config タブの review_criteria キーに JSON で保存する値の型・パース・シリアライズと、
// 「基準が更新されたら通知すべきか」の判定をここに集約する。
// DOM/chrome API には依存しない（tests/ から直接 import してテストするため）。

import { getStandardCriteriaFields } from './gemini-api';
import type { LlmCriteria } from './types';

/** レビュー基準（Config タブの review_criteria キーに JSON で保存） */
export interface ReviewCriteria {
    text: string;        // 組入・除外基準の本文（自由記述。改行あり）
    updated_at: string;  // ISO 8601。更新通知の判定キー
    updated_by: string;  // 更新者 email
}

/**
 * Config タブの review_criteria 値（JSON文字列）をパースする。
 *
 * - 空文字・undefined・null → null（基準未設定）
 * - JSON として妥当なオブジェクトで text が非空文字列 → その値を採用する。
 *   updated_at / updated_by が無い・文字列でない場合は空文字にフォールバックする。
 * - JSON として妥当だが text が空 or 文字列でない → null（空の基準を表示しても意味がない）
 * - JSON パースに失敗したが raw が非空 → 後方互換／手編集救済として raw 全体を text と
 *   みなし、updated_at / updated_by は空文字で返す。Config シートは人がセルを直接
 *   編集できるため、JSON でない素のテキストが書き込まれていても捨てずに表示する意図。
 */
export function parseReviewCriteria(raw: string | undefined | null): ReviewCriteria | null {
    if (!raw) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { text: raw, updated_at: '', updated_by: '' };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.text !== 'string' || obj.text.length === 0) return null;

    return {
        text: obj.text,
        updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
        updated_by: typeof obj.updated_by === 'string' ? obj.updated_by : '',
    };
}

/** ReviewCriteria を Config タブへ保存する JSON 文字列に変換する */
export function serializeReviewCriteria(criteria: ReviewCriteria): string {
    return JSON.stringify(criteria);
}

/**
 * 基準モーダルを自動表示すべきかを判定する。
 *
 * - criteria が null（基準未設定）→ false
 * - lastSeenUpdatedAt が null（このプロジェクトで一度も見ていない）→ true
 * - criteria.updated_at が空文字（更新時刻が分からない手編集値）→ false。
 *   一度見た後は「前回見た版と違うか」の差分が検出できないため、以後は通知しない。
 * - lastSeenUpdatedAt と criteria.updated_at が異なる → true（基準が更新された）
 * - それ以外（既に見た版と同じ）→ false
 */
export function needsCriteriaNotice(criteria: ReviewCriteria | null, lastSeenUpdatedAt: string | null): boolean {
    if (criteria === null) return false;
    if (lastSeenUpdatedAt === null) return true;
    if (criteria.updated_at === '') return false;
    return lastSeenUpdatedAt !== criteria.updated_at;
}

/**
 * LLM 基準構造化フィールド（PICO/PECO/SPIDER）の日英ラベル。
 * features/llm/criteria.ts の表示・review-criteria.ts の llmCriteriaToText 双方から
 * 参照する唯一の定義（以前は features/llm/criteria.ts にローカル定義されていた）。
 */
export const CRITERIA_FIELD_LABELS: Record<string, { ja: string; en: string }> = {
    P: { ja: '対象患者/集団', en: 'Population' },
    I: { ja: '介入', en: 'Intervention' },
    E: { ja: '曝露', en: 'Exposure' },
    C: { ja: '比較対照', en: 'Comparator' },
    O: { ja: 'アウトカム', en: 'Outcome' },
    S: { ja: 'サンプル/セッティング', en: 'Sample/Setting' },
    PI: { ja: '関心現象', en: 'Phenomenon of Interest' },
    D: { ja: '研究デザイン', en: 'Design' },
    R: { ja: '研究タイプ', en: 'Research Type' },
};

/**
 * AI タブの構造化基準（PICO/PECO/SPIDER）を、人間向けの1本の自由記述テキストへ変換する。
 *
 * - criteria が null → 空文字
 * - getStandardCriteriaFields(template) の順で標準フィールドを並べ、標準フィールドに
 *   無いカスタムキーは後ろに続ける（features/llm/criteria.ts の renderOptimizedCriteria
 *   と同じ並べ方）
 * - 1行1フィールドで `P (対象患者/集団): <値>` の形式（japanese=false なら英語ラベル）
 * - 値が空のフィールドは出力しない（「指定なし」の行が並ぶより読みやすいため）
 */
export function llmCriteriaToText(criteria: LlmCriteria | null, japanese: boolean): string {
    if (criteria === null) return '';

    // llm_criteria は Config シートの値を JSON.parse しただけで検証されていないため
    // （getLlmConfig 参照）、人が Config を手編集して fields 無しの値を書き込んだ場合に
    // 備えて空オブジェクトへフォールバックする。
    const fields = criteria.fields || {};

    const displayedKeys = new Set<string>();
    const fieldEntries: Array<[string, string]> = [];
    for (const key of getStandardCriteriaFields(criteria.template)) {
        fieldEntries.push([key, fields[key] || '']);
        displayedKeys.add(key);
    }
    for (const [key, value] of Object.entries(fields)) {
        if (!displayedKeys.has(key)) {
            fieldEntries.push([key, value]);
        }
    }

    const lines: string[] = [];
    for (const [key, value] of fieldEntries) {
        if (!value) continue;
        const label = CRITERIA_FIELD_LABELS[key];
        const fieldLabel = label ? `${key} (${japanese ? label.ja : label.en})` : key;
        lines.push(`${fieldLabel}: ${value}`);
    }
    return lines.join('\n');
}
