# LLM（Gemini）統合計画（TiAb Review Plugin）

更新日: 2025-12-28

このドキュメントは、既存の TiAb Review Plugin（Google Sheets をDBにした TiAb スクリーニング拡張）へ、Gemini（`gemini-flash-latest` / AI Studio APIキー）を統合するための実装計画です。

---

## 1. 目的 / 前提（今回の合意）

### 合意（Q1–Q6）

- LLMの位置づけ: **C（自動適用してSheetsへ保存）**
  - ここでの「自動適用」は **LLMの判定を Sheets に自動記録する**（＝人間の判定を勝手に上書きしない）として扱う
- 基準文（PICO等）: **Configシートで共有（A）**
- 実験結果: **上書きせず全部残す**
- LLM出力の保存: **人間の判定と同じ “Decisions” の形式で保存**
  - 「判定をしたモデル、日付を評価者ID（reviewer_id）として保存」方針
- APIキー: **端末に保存（chrome.storage.local）**、Sheets には保存しない
- 呼び出しAPI: **AI Studio APIキー + `generativelanguage.googleapis.com` + `gemini-flash-latest`**
- 外部送信: title/abstract を Gemini へ送信する（OK）
- 基本的にバッチを使って、全件一括処理を行う。

### 非ゴール（今回やらない）

- フルテキスト/ PDF 解析
- 完全自動（人間の判定を自動で include/exclude に確定し続ける運用）に必要な監査・承認ワークフローの整備

---

## 2. 現状のアーキテクチャ（要点）

- UI: Side Panel（`src/sidepanel/*`）が実質メイン画面
- 認証: `chrome.identity.getAuthToken`（Google OAuth）→ Sheets/Drive API を `fetch`
- DB: Google Sheets（References/Decisions/Config）
- 判定保存: `ref_id + reviewer_id` が既に存在すれば update、無ければ append（`src/lib/sheets-api.ts:saveDecision`）

---

## 3. 追加するLLM機能（ユーザーフロー）

### 3.1 初回セットアップ

1) Side Panel に「LLM処理」を追加
2) ユーザーが **Gemini APIキー** を入力（任意で「端末に保存」）
   入力は設定リンクから、設定のリンクは全部の画面の右上に入れるようにする
3) Config シートにプロトコルの組み入れ、除外基準をコピペして保存
4) LLMにより、コピペした組み入れ、除外基準から、LLM用の適切な組み入れ、除外基準に変換 、保存（共有）

### 3.2 スクリーニング中

- 一括実行ボタンをLLM処理の画面で押すことで一括処理（バッチサイズはいくつかの条件で確認し、デフォルトで決めるが調整可能にする）
- LLMは以下を返す（表示＋保存）
  - `probability`（確率）
  - `should_include`（true/false）
  - （内部的には既存UIのため）`decision`（include/exclude/maybe）
- 生成された結果は **Decisions シートへ自動で記録**

---

## 4. データ設計（Sheets）

### 4.1 Config シート（Key-Value）

既存: `include_keywords`, `exclude_keywords`, `key_opened` を利用中。
追加（案）: LLM関連の設定を Key-Value として追加する。

例:

- `llm_enabled` = `true|false`
- `llm_model` = `gemini-flash-latest`
- llm_temperature = 0 (デフォルト、調整可)
- llm_thinking = `"low"` または `"high"`
- `llm_criteria` = （PICO/PECO等の基準文。改行含むテキスト可）
- `llm_prompt_template` = （テンプレを置く場合）
- `llm_include_threshold` = `0.70`（probability >= なら include）
- `llm_exclude_threshold` = `0.30`（probability <= なら exclude）
- `llm_max_output_tokens`
- `llm_output_language` = `ja`（理由生成の言語）

補足:

- **APIキーはConfigに保存しない**（端末ローカルのみ）
- 既存の `updateConfigKeywords()` と干渉しないよう、LLM関連キーは別関数で読み書きする

### 4.2 Decisions シート（LLM結果の保存）

既存のDecisionsシートをそのまま活用。`reviewer_id` に `gemini-flash-latest@2025-12-28` のようなモデル+日付を記録。

---

## 5. フロントエンド設計（UI）

### 5.1 タブナビゲーション

サイドパネルを**2タブ構成**に変更（アイコンベース）:

```
┌─────────────────────────────────────┐
│  TiAb Review        [📄][⚙️]  0/0  │  ← ヘッダー + タブ切替
├─────────────────────────────────────┤
│  [📄 スクリーニング]                │  ← 現行のscreening-section
│  [⚙️ LLM設定]                       │  ← 新規追加
└─────────────────────────────────────┘
```

- `📄` = スクリーニングタブ（デフォルト表示）
- `⚙️` = LLM設定タブ

### 5.2 LLM設定タブ構成

```
┌─────────────────────────────────────┐
│ LLM設定                             │
├─────────────────────────────────────┤
│ 🔑 Gemini APIキー                   │
│ [••••••••••••••••] [👁]             │
│ ✓ 設定済み（端末に保存）            │
├─────────────────────────────────────┤
│ 📋 レビュー基準                     │
│ テンプレート: [PICO ▼]             │
│                                     │
│ P (対象):     [__________________] │
│ I (介入):     [__________________] │
│ C (比較対照): [__________________] │
│ O (アウトカム):[__________________]│
│                                     │
│ ✓ Configシートへ自動保存           │
├─────────────────────────────────────┤
│ ▶ 詳細設定                          │
│   Include閾値: [0.70]               │
│   Exclude閾値: [0.30]               │
│   モデル: [gemini-flash-latest ▼]   │
│   出力言語: [日本語 ▼]              │
└─────────────────────────────────────┘
```

### 5.3 テンプレート設計（初期: PICO）

初期実装は **PICO** のみ。将来拡張可能な設計:

| テンプレート  | フィールド     |
| ------------- | -------------- |
| PICO          | P, I, C, O     |
| PECO (将来)   | P, E, C, O     |
| SPIDER (将来) | S, PI, D, E, R |
| カスタム      | 自由テキスト   |

**データ保存形式** (`llm_criteria`):

```json
{
  "template": "pico",
  "fields": {
    "P": "18歳以上の2型糖尿病患者",
    "I": "メトホルミン",
    "C": "プラセボまたは無治療",
    "O": "HbA1c, 体重変化"
  }
}
```

### 5.4 APIキー管理

| 項目   | 仕様                                             |
| ------ | ------------------------------------------------ |
| 保存先 | `chrome.storage.local`                         |
| キー名 | `gemini_api_key`                               |
| 表示   | 入力済み時はマスク（••••）、トグルで表示切替 |
| 共有   | **されない**（端末ローカルのみ）           |

### 5.5 閾値設定（デフォルト）

| 設定                      | デフォルト値 | 説明                           |
| ------------------------- | ------------ | ------------------------------ |
| `llm_include_threshold` | `0.70`     | probability ≥ 0.70 → include |
| `llm_exclude_threshold` | `0.30`     | probability ≤ 0.30 → exclude |
| 中間 (0.30 < p < 0.70)    | → maybe     |                                |

---

## 6. 実装ファイル（変更対象）

| ファイル                         | 変更内容                                       |
| -------------------------------- | ---------------------------------------------- |
| `src/sidepanel/sidepanel.html` | タブナビ追加、LLM設定セクション追加            |
| `src/sidepanel/sidepanel.css`  | タブ・設定フォームのスタイル                   |
| `src/sidepanel/sidepanel.ts`   | タブ切替、設定読み書きロジック                 |
| `src/lib/sheets-api.ts`        | `getLlmConfig()`, `updateLlmConfig()` 追加 |
| `src/lib/types.ts` (任意)      | LLM設定用の型定義                              |
