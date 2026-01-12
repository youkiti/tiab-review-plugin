// prompt-templates.ts - LLM用プロンプトテンプレート

import type { LlmCriteria } from './types';

/**
 * デフォルトのスクリーニングプロンプト（基準変換前に使用）
 */
export const DEFAULT_SCREENING_PROMPT = `あなたはシステマティックレビューのタイトル・抄録スクリーニングを行う専門家です。

以下の文献について、組み入れ基準に合致する可能性を評価してください。

## 評価のガイドライン

1. **タイトル・抄録レベルでの判断**
   - フルテキストでしか確認できない情報は「不明」として扱う
   - 明確に除外できる場合のみ低確率とする
   - 曖昧な場合は組み入れ側に寄せる（見逃しを避ける）

2. **include_probability の目安**
   - 0.8〜1.0: 明確に基準に合致
   - 0.5〜0.8: 基準に合致する可能性が高い
   - 0.3〜0.5: 基準に合致するか不明確
   - 0.0〜0.3: 明確に基準に合致しない

3. **evidence の抽出**
   - 判断根拠となるテキストを正確に抜粋
   - 開始位置と終了位置は0始まりで指定`;

/**
 * LlmCriteriaからスクリーニングプロンプトを生成
 */
export function generateScreeningPromptFromCriteria(
    criteria: LlmCriteria,
    customPrompt?: string
): string {
    if (customPrompt) {
        return customPrompt;
    }

    let criteriaSection = '';

    if (criteria.template === 'pico') {
        criteriaSection = `## 組み入れ基準 (PICO)

**P (患者/集団):** ${criteria.fields['P'] || '指定なし'}
**I (介入):** ${criteria.fields['I'] || '指定なし'}
**C (比較対照):** ${criteria.fields['C'] || '指定なし'}
**O (アウトカム):** ${criteria.fields['O'] || '指定なし'}`;

        if (criteria.fields['研究デザイン']) {
            criteriaSection += `\n**研究デザイン:** ${criteria.fields['研究デザイン']}`;
        }
        if (criteria.fields['study_design']) {
            criteriaSection += `\n**研究デザイン:** ${criteria.fields['study_design']}`;
        }
    } else if (criteria.template === 'peco') {
        criteriaSection = `## 組み入れ基準 (PECO)

**P (患者/集団):** ${criteria.fields['P'] || '指定なし'}
**E (曝露):** ${criteria.fields['E'] || '指定なし'}
**C (比較対照):** ${criteria.fields['C'] || '指定なし'}
**O (アウトカム):** ${criteria.fields['O'] || '指定なし'}`;
    } else {
        // custom または その他
        criteriaSection = `## 組み入れ基準

`;
        for (const [key, value] of Object.entries(criteria.fields)) {
            criteriaSection += `**${key}:** ${value}\n`;
        }
    }

    return `あなたはシステマティックレビューのタイトル・抄録スクリーニングを行う専門家です。

以下の組み入れ基準に基づいて、文献を評価してください。

${criteriaSection}

## 評価のガイドライン

1. **タイトル・抄録レベルでの判断**
   - フルテキストでしか確認できない情報は「不明」として扱う
   - 明確に除外できる場合のみ低確率とする
   - 曖昧な場合は組み入れ側に寄せる（見逃しを避ける）

2. **各PICO要素のチェック**
   - P: 対象患者/集団が基準に合致するか
   - I: 介入内容が基準に合致するか
   - C: 比較対照の存在（記載がなくても除外しない）
   - O: アウトカムの関連性

3. **include_probability の目安**
   - 0.8〜1.0: すべてのPICO要素が明確に合致
   - 0.5〜0.8: 主要な要素が合致、一部不明
   - 0.3〜0.5: 合致するか判断が難しい
   - 0.0〜0.3: 明確に基準に合致しない

4. **evidence の抽出**
   - 各PICO要素に関連するテキストを抜粋
   - 開始位置と終了位置は0始まりで指定`;
}

/**
 * 基準変換用のプロンプトテンプレート
 */
export const CRITERIA_CONVERSION_PROMPT_TEMPLATE = `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
{{PROTOCOL_TEXT}}

## 出力指示

1. **criteria**: PICO/PECO形式で構造化
   - template: "pico"（または適切な形式）
   - fields: 各要素を簡潔に記述
     - P: 対象患者/集団
     - I: 介入（または E: 曝露）
     - C: 比較対照
     - O: アウトカム
     - 必要に応じて「研究デザイン」等の追加フィールド

2. **screening_prompt**: スクリーニング用のプロンプトテンプレート
   - タイトル・抄録から組み入れ/除外を判断するための詳細な指示
   - 各PICO要素をどのようにチェックするかの具体的なガイダンス

注意:
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;

/**
 * プロンプトバージョン（履歴管理用）
 */
export const PROMPT_VERSION = 'v1.0.0';
