# LLM（Gemini）統合計画（TiAb Review Plugin）

更新日: 2025-12-28

このドキュメントは、既存の TiAb Review Plugin（Google Sheets をDBにした TiAb スクリーニング拡張）へ、Gemini（`gemini-flash-latest` / AI Studio APIキー）を統合するための実装計画です。

---

## 1. 目的 / 前提（今回の合意）

### 合意（Q1〜Q6）

- LLMの位置づけ: **C（自動適用してSheetsへ保存）**
  - ここでの「自動適用」は **LLMの判定を Sheets に自動記録する**（＝人間の判定を勝手に上書きしない）として扱う
- 基準文（PICO等）: **Configシートで共有（A）**
- 実験結果: **上書きせず全部残す**
- LLM出力の保存: **人間の判定と同じ “Decisions” の形式で保存**
  - 「判定をしたモデル、日付を評価者ID（reviewer_id）として保存」方針
  - **LLM判定の reviewer_id は予約名前空間 `llm:` を付与**し、人間の判定とは区別する（例: `llm:gemini-flash-latest@2025-12-28T14:30:00`）
    - 集計（進捗/未判定）・不一致判定・「全レビュアー判定」表示では **LLM判定を人間判定と同じ扱いを**する
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
4) **「基準を最適化」ボタン** を押すと、LLMがコピペした基準からLLM用の適切な組み入れ・除外基準に変換し、保存（共有）

### 3.2 スクリーニング中

- 一括実行ボタンをLLM処理の画面で押すことで一括処理（バッチサイズはいくつかの条件で確認し、デフォルトで決めるが調整可能にする）
- LLMは `probability`（組み入れ確率: 0.0〜1.0）を出力
- `decision`（include/exclude）は **閾値設定に基づき判定**（5.5参照）
  - probability ≥ `llm_include_threshold` → include
  - probability < `llm_include_threshold` → exclude
- 生成された結果は **Decisions シートへ自動で記録**
  - LLMは上書きしないため `append` のみ（バッチサイズごとにまとめて追記）

### 3.3 基準変換処理（最適化機能）

「基準を最適化」ボタン押下時の処理:

```
入力: プロトコルの組み入れ・除外基準（コピペテキスト）
  ↓
処理: LLMが以下を抽出・変換
  - PICO要素の抽出（P/I/C/O）
  - 研究デザイン要件の特定（RCT only, 観察研究含む, etc.）
  - T&Aスクリーニング向けの判定基準文に変換
  ↓
出力:
  - `llm_criteria`（構造化JSON）
  - `llm_screening_prompt`（スクリーニング用プロンプトテンプレート）
```

**保存先:**

- Configシート: `llm_criteria`, `llm_screening_prompt`
- LLM_Executionsシート: `execution_type=prompt_generation` として履歴保存

---

## 4. データ設計（Sheets）

### 4.1 Config シート（Key-Value）

既存: `include_keywords`, `exclude_keywords`, `key_opened` を利用中。
追加（案）: LLM関連の設定を Key-Value として追加する。

例:

- `llm_enabled` = `true|false`
- `llm_model` = `gemini-flash-latest`
- `llm_temperature` = `0` (デフォルト、調整可)
- `llm_thinking` = `"low"` または `"high"`
- `llm_protocol_text` = （プロトコルの組み入れ/除外基準のコピペ原文）
- `llm_criteria` = （PICO/PECO等の基準文。**JSON形式**で保存、詳細は5.3参照）
- `llm_screening_prompt` = （スクリーニング用プロンプトテンプレート。3.3の出力）
- `llm_include_threshold` = `0.30`（probability がこの値以上なら include、未満なら exclude）
- `llm_max_output_tokens`
- `llm_output_language` = `ja`（理由生成の言語）

補足:

- **APIキーはConfigに保存しない**（端末ローカルのみ）
- 既存の `updateConfigKeywords()` と干渉しないよう、LLM関連キーは別関数で読み書きする

### 4.2 Decisions シート（LLM結果の保存）

既存のDecisionsシートをそのまま活用。

- **人間の判定**: `reviewer_id` は email（既存の運用ルール通り）
- **LLM判定**: `reviewer_id` は `llm:{model}@{timestamp}`（ISO 8601）で記録し、**同一実行は同一ID**として扱う
  - 例: `llm:gemini-flash-latest@2025-12-28T14:30:00`
  - 合意「実験結果は全部残す」を守るため、**再実行は timestamp を変えて別IDとして保存（上書きしない）**

#### LLMの追加情報（probability等）の保存先

Decisionsの列追加はせず、以下を推奨:

- `note` に JSON で格納（UI側で整形表示）
  - 例: `{"type":"llm","execution_id":"llm:...","model":"gemini-flash-latest","probability":0.72,"rationale":"...","prompt_version":"v1"}`
- `reason` は `exclude` の短い理由に使用（`include` は空でもよい）

### 4.3 LLM_Executions シート（実行履歴）

基準変換（prompt_generation）と一括実行（batch_screening）の両方の履歴を保存。

| カラム                | 型     | 例                                              | 説明                                                      |
| --------------------- | ------ | ----------------------------------------------- | --------------------------------------------------------- |
| `execution_id`      | string | `llm:gemini-flash-latest@2025-12-28T14:30:00` | 一意のID（Decisionsの `reviewer_id`と一致させて紐づけ） |
| `execution_type`    | string | `prompt_generation` / `batch_screening`     | **実行種別**                                        |
| `timestamp`         | string | `2025-12-28T14:30:00`                         | 実行日時（ISO 8601）                                      |
| `model`             | string | `gemini-flash-latest`                         | 使用モデル                                                |
| `criteria_snapshot` | JSON   | `{"template":"pico",...}`                     | 実行時の基準（完全なJSON）                                |
| `screening_prompt`  | string | （生成されたプロンプト）                        | **スクリーニング用プロンプト**                      |
| `include_threshold` | number | `0.30`                                        | 実行時のinclude閾値                                       |
| `target_count`      | number | `150`                                         | 対象件数（batch_screening時）                             |
| `include_count`     | number | `80`                                          | include判定数                                             |
| `exclude_count`     | number | `70`                                          | exclude判定数                                             |

**execution_type:**

- `prompt_generation`: 基準変換処理（3.3）
- `batch_screening`: 一括スクリーニング実行（3.2）

**用途:**

- 異なる基準での再実行を区別
- 実験結果の比較・監査
- 「実験結果は全部残す」の合意を実現

---

## 5. フロントエンド設計（UI）

### 5.1 タブナビゲーション

サイドパネルを**2タブ構成**に変更（アイコンベース）:

```
┌─────────────────────────────────────┐
│  TiAb Review        [📄][🤖]  0/0  │  ← ヘッダー + タブ切替
├─────────────────────────────────────┤
│  [📄 スクリーニング]                │  ← 現行のscreening-section
│  [🤖 LLM処理]                      │  ← 新規追加
└─────────────────────────────────────┘
```

- `📄` = スクリーニングタブ（デフォルト表示）
- `🤖` = LLM処理タブ

### 5.2 LLM処理タブ構成

**処理フロー順に配置**: APIキー → 詳細設定 → レビュー基準（入力→変換→出力） → 一括実行

```
┌─────────────────────────────────────┐
│ LLM処理                             │
├─────────────────────────────────────┤
│ 🔑 Gemini APIキー                   │
│ [••••••••••••••••] [👁]             │
│ ✓ 設定済み（端末に保存）            │
├─────────────────────────────────────┤
│ ⚙️ 詳細設定                         │
│   Include閾値: [0.30]               │
│   モデル: [gemini-flash-latest ▼]   │
│   出力言語: [日本語 ▼]              │
├─────────────────────────────────────┤
│ 📋 レビュー基準                     │
│                                     │
│ 【入力】プロトコルからコピペ:       │
│ ┌─────────────────────────────────┐ │
│ │ Inclusion criteria:             │ │
│ │ - Adults aged 18+ with T2DM     │ │
│ │ - Randomized controlled trials  │ │
│ │ Exclusion criteria:             │ │
│ │ - Pregnancy, ...                │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [💡 基準を最適化]                   │
│                                     │
│ 【出力】最適化されたスクリーニング基準:│
│ ┌─────────────────────────────────┐ │
│ │ P: 18歳以上の2型糖尿病患者      │ │
│ │ I: メトホルミン                 │ │
│ │ C: プラセボまたは無治療         │ │
│ │ O: HbA1c, 体重変化              │ │
│ │ 研究デザイン: RCTのみ           │ │
│ └─────────────────────────────────┘ │
│ ※ 出力結果は編集可能               │
│                                     │
│ [💾 保存]                           │
│ ✓ Configシートへ自動保存           │
├─────────────────────────────────────┤
│ 🚀 一括実行                         │
│ バッチサイズ: [50 ▼]                  │
│ 対象: 未判定のみ / 全件                │
│                                     │
│ [▶️ 一括実行開始]                    │
│ 進捗: 0/150 (0%)                    │
│ ██████████░░░░░░░░░░                 │
└─────────────────────────────────────┘
```

**ボタン動作:**

- **基準を最適化**: プロトコルのコピペテキストをLLMがPICO形式+スクリーニング用プロンプトに変換（3.3参照）
  - 入力欄の内容をLLMで解析し、出力欄に構造化された基準を表示
  - 実行履歴: `LLM_Executions`に `execution_type=prompt_generation`として保存
- **保存**: 出力欄の内容（編集後含む）をConfigシートに保存
- **一括実行開始**: 保存済みの基準で対象レコードにLLM判定をバッチ実行（3.2参照）
  - 実行履歴: `LLM_Executions`に `execution_type=batch_screening`として保存

**バッチサイズ選択肢:**

- 10, 25, 50（デフォルト）, 100, 全件

#### バッチサイズの定義（実装上の意味）

- **バッチサイズ = 1回の「保存（Sheets追記）」単位の件数**として扱う（例: 50件ごとにDecisionsへまとめてappend）
- Geminiへの判定要求は **1文献=1リクエスト**（MVP）を基本とし、必要なら将来「複数文献を1リクエスト」に拡張する

### 5.3 テンプレート設計（初期: PICO）

初期実装は **PICO** のみ。将来拡張可能な設計:

| テンプレート    | フィールド     |
| --------------- | -------------- |
| PICO            | P, I, C, O     |
| PECO (将来)     | P, E, C, O     |
| SPIDER (将来)   | S, PI, D, E, R |
| カスタム (将来) | 自由定義       |

**データ保存形式** (`llm_criteria`) — 全てJSON形式:

**PICO例:**

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

**カスタム例（将来）:**

```json
{
  "template": "custom",
  "fields": {
    "inclusion": "組み入れ基準のテキスト",
    "exclusion": "除外基準のテキスト"
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

### 5.5 閾値設定

LLMが出力する `probability`（組み入れ確率）から `decision` への変換ロジックは **3.2** を参照。

| 設定                      | デフォルト値 | 用途                                      |
| ------------------------- | ------------ | ----------------------------------------- |
| `llm_include_threshold` | `0.30`     | この値以上で include、未満で exclude 判定 |

---

## 6. 実装ファイル（変更対象）

### 6.1 フロントエンド

| ファイル                         | 変更内容                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/sidepanel/sidepanel.html` | タブナビ追加、LLM処理タブ（APIキー・詳細設定・レビュー基準・一括実行）                   |
| `src/sidepanel/sidepanel.css`  | タブ・設定フォーム・進捗バーのスタイル                                                   |
| `src/sidepanel/sidepanel.ts`   | タブ切替、設定読み書き、一括実行ロジック、進捗表示、LLM判定の表示/集計（人間判定と分離） |

### 6.2 データ層（Sheets API）

| ファイル                  | 変更内容                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/sheets-api.ts` | `getLlmConfig()`, `updateLlmConfig()`, `saveLlmExecution()`, `getLlmExecutions()`, `appendDecisions()`（LLM用一括追記）追加。 |
| `src/lib/types.ts`      | `LlmConfig`, `LlmExecution`, `LlmCriteria` 型定義追加                                                                                                                                           |

### 6.3 LLM連携（新規）

| ファイル                              | 変更内容                                               |
| ------------------------------------- | ------------------------------------------------------ |
| `src/lib/gemini-api.ts` [NEW]       | Gemini API呼び出し（基準変換、スクリーニング判定）     |
| `src/lib/llm-processor.ts` [NEW]    | バッチ処理ロジック、進捗管理、結果保存                 |
| `src/lib/prompt-templates.ts` [NEW] | プロンプトテンプレート（基準変換用、スクリーニング用） |

### 6.4 ストレージ

| ファイル                                | 変更内容                                       |
| --------------------------------------- | ---------------------------------------------- |
| `src/lib/storage.ts` (既存または新規) | `chrome.storage.local` でのAPIキー保存・取得 |

### 6.5 Manifest（host_permissions）

| ファイル              | 変更内容                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/manifest.json` | `host_permissions` に `https://generativelanguage.googleapis.com/*` を追加（Gemini API呼び出し用） |
