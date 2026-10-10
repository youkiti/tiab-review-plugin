// 構造化出力を使うプロバイダで共通のプロンプトを組み立てる。

export function buildScreeningPrompt(title: string, abstract: string, screeningPrompt: string, outputLanguage: string): string {
    // strict json_schema が出力形式を強制するため、OpenRouter 版と違い
    // "## 出力指示" の JSON フォーマット指定ブロックは不要。意味的な注意事項のみ残す。
    return `${screeningPrompt}

## 対象文献

**タイトル:**
${title}

**抄録:**
${abstract || '(抄録なし)'}

## 注意事項
- include_probability は組み入れ基準に合致する確率（0.0=完全に除外, 1.0=確実に組入）
- reasons は判断理由の短文を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で記述する
- quote は title または abstract 内の正確な部分文字列でなければならない
- evidence が無い場合でも空配列 [] を出力する（フィールド省略不可）`;
}

export function buildCriteriaPrompt(protocolText: string, outputLanguage: string): string {
    const langLabel = outputLanguage === 'ja' ? '日本語' : outputLanguage;
    return `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
${protocolText}

## 注意事項
- criteria.template は "pico" | "peco" | "spider" | "custom" のいずれかを選択する
- criteria.fields は template に応じて必要なフィールドのみ埋める
  (P: 対象患者/集団, I: 介入, E: 曝露, C: 比較対照, O: アウトカム,
   S: サンプル/セッティング, PI: 関心現象, D: 研究デザイン, R: 研究タイプ)
- 各フィールドは${langLabel}で簡潔に記述する
- screening_prompt はタイトル・抄録レベルのスクリーニング用プロンプトテンプレート
  (${langLabel}) とし、各要素のチェック方法を具体的に記述する
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;
}
