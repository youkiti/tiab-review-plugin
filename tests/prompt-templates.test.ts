import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScreeningPromptFromCriteria } from '../src/lib/prompt-templates';
import type { LlmCriteria } from '../src/lib/types';

test('PICO の出力は変更前の文面と完全に一致する', () => {
    const criteria: LlmCriteria = {
        template: 'pico',
        fields: {
            P: 'Adults',
            I: 'Exercise',
            C: 'Usual care',
            O: 'Quality of life',
            研究デザイン: 'RCT',
        },
    };
    // 実装変更前の関数を実行して取得した出力を固定する。
    const expected = `あなたはシステマティックレビューのタイトル・抄録スクリーニングを行う専門家です。

以下の組み入れ基準に基づいて、文献を評価してください。

## 組み入れ基準 (PICO)

**P (患者/集団):** Adults
**I (介入):** Exercise
**C (比較対照):** Usual care
**O (アウトカム):** Quality of life
**研究デザイン:** RCT

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

    assert.equal(generateScreeningPromptFromCriteria(criteria), expected);
});

test('PECO は曝露のチェックと PECO の目安・根拠抽出を案内する', () => {
    const prompt = generateScreeningPromptFromCriteria({ template: 'peco', fields: { E: '喫煙' } });
    assert.ok(prompt.includes('各PECO要素のチェック'));
    assert.ok(prompt.includes('E: 曝露内容が基準に合致するか'));
    assert.ok(prompt.includes('すべてのPECO要素が明確に合致'));
    assert.ok(prompt.includes('各PECO要素に関連するテキストを抜粋'));
    assert.ok(!prompt.includes('I: 介入内容'));
    assert.ok(!prompt.includes('PICO'));
});

for (const template of ['spider', 'custom', 'unknown'] as const) {
    test(`${template} は基準の各要素をチェックする`, () => {
        const prompt = generateScreeningPromptFromCriteria({
            template: template as LlmCriteria['template'],
            fields: { S: '患者', PI: '療養経験' },
        });
        assert.ok(prompt.includes('2. **各要素のチェック**\n   - 上記の組み入れ基準の各要素について、タイトル・抄録の記述が合致するかを確認する'));
        assert.ok(prompt.includes('すべての要素が明確に合致'));
        assert.ok(prompt.includes('各要素に関連するテキストを抜粋'));
        assert.ok(!prompt.includes('PICO'));
        assert.ok(!prompt.includes('I: 介入内容'));
    });
}

test('customPrompt が指定されていればそのまま返す', () => {
    const customPrompt = '  独自の指示\n改行と末尾の空白も保持する  ';
    assert.equal(
        generateScreeningPromptFromCriteria({ template: 'pico', fields: {} }, customPrompt),
        customPrompt
    );
});
