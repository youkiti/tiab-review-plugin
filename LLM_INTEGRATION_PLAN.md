# LLM（Gemini）統合計画（TiAb Review Plugin）

更新日: 2025-12-30

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
    - 集計（進捗/未判定）は **人間判定のみ**で計算し、LLMは別メトリクス（LLM進捗）として表示する
- APIキー: **端末に保存（chrome.storage.local, 暗号化）**、Sheets には保存しない（保存しない選択肢を提示）
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
5) LLM_Executions シートが存在しない場合は初期設定時に自動作成する

### 3.2 LLM処理の実行タイミング

> [!IMPORTANT]
> **LLM処理はユーザーの手動スクリーニング完了後に実行する**
>
> - LLM結果を事前に見せると automation bias が生じるため
> - 目標: 「1人がASReview（機械学習）、もう1人がLLM」で1人省力化を実現
> - 参考: https://arxiv.org/html/2510.06708v1
> - 進捗/未判定の集計は人間判定のみで行い、LLM進捗は別メトリクスで表示する

**実行フロー（2段階方式）:**

1. ユーザーが手動スクリーニングを完了
2. LLM処理タブで一括実行ボタンを押す
3. LLMは `include_probability`（組み入れ確率: 0.0〜1.0）+ `reasons` + `evidence` を出力
4. **Phase 1: 生データ保存**
   - 結果は **Decisions シートへ追記**
   - `note` 列に include_probability/reasons/evidence をJSON形式で保存
   - **`decision` 列は `pending`**（まだ確定していない状態）
5. **実行完了後**に閾値調整UIが表示され、ユーザーが閾値を変えながら件数を**プレビュー**
6. **Phase 2: 閾値確定**
   - 「確定」ボタン押下で `decision`（include/exclude）を一括更新
   - 後日、閾値を変更して「再確定」も可能（既存の `decision` を上書き）

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
- `llm_include_threshold` = `0.30`（include_probability がこの値以上なら include、未満なら exclude）
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
  - **冪等性**: `execution_id`（= reviewer_id）+ `ref_id` の既存行がある場合は **update** し、なければ append（LLM実行の再送・再試行に対応）

#### 2段階保存方式

**Phase 1: 一括実行時（生データ保存）**

| ref_id  | reviewer_id                                     | decision          | reason | note                                 |
| ------- | ----------------------------------------------- | ----------------- | ------ | ------------------------------------ |
| ref_001 | `llm:gemini-flash-latest@2025-12-30T10:00:00` | **pending** | (空)   | `{"include_probability":0.72,...}` |

- `note` 列に include_probability/reasons/evidence をJSON形式で保存
- `decision` 列は**`pending`**（まだ確定していない状態）
  - `pending` は LLMの途中状態として扱い、手動スクリーニングの進捗・未判定集計には含めない

**Phase 2: 閾値確定時**

| ref_id  | reviewer_id                                     | decision          | reason    | note                                 |
| ------- | ----------------------------------------------- | ----------------- | --------- | ------------------------------------ |
| ref_001 | `llm:gemini-flash-latest@2025-12-30T10:00:00` | **include** | RCTである | `{"include_probability":0.72,...}` |

- `include_probability >= 閾値` → include, それ以外 → exclude
- `decision` 列を**一括更新**（update）
- `reason` 列には reasons の要約を設定

**再確定時（閾値変更）:**

- 同じ `reviewer_id` のレコードに対して `decision` 列を**上書き**
- `note` の include_probability から再計算するので、再実行は不要

#### pending 扱い（LLMのみ）

- `pending` は Phase 1 の一時状態としてのみ使用し、人間判定には使わない
- 手動スクリーニングの進捗・未判定集計は**人間判定のみ**で計算する
- 「未判定」フィルタは人間判定のみで判定し、LLMの `pending` は除外する
- 同一 `ref_id` に人間判定が存在する場合、LLMの `pending` は一覧上の未判定表示に影響しない
- LLM処理タブでは `pending` / include / exclude の件数を別表示する

**LLM出力スキーマ:**

```json
{
  "name": "tiab_probability",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["include_probability", "reasons", "evidence"],
    "properties": {
      "include_probability": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "description": "タイトル・抄録レベルで最終的に組み入れになり得る確率（0-1）。閾値判定はUI側で行う。"
      },
      "reasons": {
        "type": "array",
        "minItems": 1,
        "description": "この確率になった理由（短文の配列）。",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "evidence": {
        "type": "array",
        "minItems": 1,
        "description": "ハイライト用の根拠。quoteは原文からの正確な部分文字列（title/abstract内で完全一致）。",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["field", "quote", "start_char", "end_char"],
          "properties": {
            "field": {
              "type": "string",
              "enum": ["title", "abstract"],
              "description": "抜粋元フィールド。"
            },
            "quote": {
              "type": "string",
              "minLength": 1,
              "description": "原文からの正確な抜粋（そのまま一致する連続した部分文字列）。"
            },
            "start_char": {
              "type": "integer",
              "minimum": 0,
              "description": "field内テキスト（titleまたはabstract）の0始まり開始位置。"
            },
            "end_char": {
              "type": "integer",
              "minimum": 0,
              "description": "field内テキストの終了位置（排他的; ハイライト範囲は [start_char, end_char)）。"
            }
          }
        }
      }
    }
  }
}
```

**noteへの保存例:**

```json
{
  "type": "llm",
  "execution_id": "llm:gemini-flash-latest@2025-12-28T14:30:00",
  "model": "gemini-flash-latest",
  "include_probability": 0.72,
  "reasons": ["RCTである", "T2DM患者を対象", "アウトカムにHbA1cを含む"],
  "evidence": [
    {"field": "title", "quote": "randomized controlled trial", "start_char": 45, "end_char": 71},
    {"field": "abstract", "quote": "patients with type 2 diabetes", "start_char": 120, "end_char": 150}
  ],
  "prompt_version": "v1"
}
```

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
- 進捗表示（0/0）は人間判定のみを表示し、LLM進捗はLLM処理タブ内に別表示する

### 5.2 LLM処理タブ構成

**処理フロー順に配置**: APIキー → 詳細設定 → レビュー基準（入力→変換→出力） → 一括実行 → **閾値調整（実行後）**

> [!NOTE]
> Include閾値は**実行前には表示しない**。一括実行完了後に閾値調整UIを表示し、ユーザーが閾値を変えながら「この閾値だとこの件数」と直感的に試せるようにする。

```
┌─────────────────────────────────────┐
│ LLM処理                             │
├─────────────────────────────────────┤
│ 🔑 Gemini APIキー                   │
│ [••••••••••••••••] [👁]             │
│ ✓ 設定済み（端末に保存）            │
├─────────────────────────────────────┤
│ ⚙️ 詳細設定                         │
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
│ バッチサイズ: [50 ▼]               │
│ 対象: 未判定のみ / 全件            │
│                                     │
│ [▶️ 一括実行開始]                   │
│ 進捗: 0/150 (0%)                    │
│ ██████████░░░░░░░░░░                │
└─────────────────────────────────────┘
```

### 5.2.1 閾値調整UI（実行完了後に表示）

一括実行が完了すると、以下のUIが表示される:

```
┌─────────────────────────────────────┐
│ 📊 閾値調整                         │
├─────────────────────────────────────┤
│ ✓ 一括実行完了 (150件処理)          │
│                                     │
│ Include閾値: [0.30] ←───────────→   │
│              0.0              1.0   │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 現在の閾値: 0.30                │ │
│ │ Include: 80件 (53%)             │ │
│ │ Exclude: 70件 (47%)             │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [📈 分布を表示]                     │
│ ┌─────────────────────────────────┐ │
│ │ 0.0-0.2: ████████████ 40件      │ │
│ │ 0.2-0.4: ██████ 25件            │ │
│ │ 0.4-0.6: ████ 20件              │ │
│ │ 0.6-0.8: ██████ 30件            │ │
│ │ 0.8-1.0: ███████ 35件           │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [💾 閾値を確定して保存]             │
│ ※ 確定後、Decisionsに判定が記録    │
└─────────────────────────────────────┘
```

**機能:**

- **スライダー**: 閾値を0.0〜1.0で調整（リアルタイムで件数プレビュー、**Sheetsへの書き込みなし**）
- **分布表示**: include_probability の分布をヒストグラムで可視化
- **確定ボタン**: 選択した閾値でinclude/excludeを確定し、Decisionsの `decision` 列を一括更新
- **再確定ボタン**: 確定後に閾値を変更して再度「確定」すると、既存の `decision` を上書き

**理由の確認:**

閾値付近の文献については、`reasons` と `evidence` を確認することで「なぜこのinclude_probabilityなのか」を理解できる。これにより、閾値を変更するたびに再実行する必要がなくなる。

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

補足:

- 保存時はアプリ側で暗号化し、復号用パスフレーズはセッションのみ保持する
- UIで「保存しない（毎回入力）」を選べるようにし、保存時は注意喚起を表示する

### 5.5 閾値設定

LLMが出力する `include_probability`（組み入れ確率）から `decision` への変換ロジック:

- include_probability ≥ `llm_include_threshold` → include
- include_probability < `llm_include_threshold` → exclude

| 設定                      | デフォルト値 | 用途                                      |
| ------------------------- | ------------ | ----------------------------------------- |
| `llm_include_threshold` | `0.30`     | この値以上で include、未満で exclude 判定 |

> [!IMPORTANT]
> **閾値は実行後に調整する**（5.2.1参照）
>
> - 実行前には閾値を設定しない
> - LLMはinclude_probabilityのみを出力し、閾値判定はUI側で行う
> - ユーザーは閾値を変えながら件数を確認し、最適な閾値を選択できる

---

## 6. 実装ファイル（変更対象）

### 6.1 フロントエンド

| ファイル                         | 変更内容                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/sidepanel/sidepanel.html` | タブナビ追加、LLM処理タブ（APIキー・詳細設定・レビュー基準・一括実行）                   |
| `src/sidepanel/sidepanel.css`  | タブ・設定フォーム・進捗バーのスタイル                                                   |
| `src/sidepanel/sidepanel.ts`   | タブ切替、設定読み書き、一括実行ロジック、進捗表示、LLM判定の表示/集計（人間判定と分離） |

### 6.2 データ層（Sheets API）

| ファイル                  | 変更内容                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/sheets-api.ts` | `getLlmConfig()`, `updateLlmConfig()`, `saveLlmExecution()`, `getLlmExecutions()`, `appendDecisions()`（LLM用一括追記）追加。 |
| `src/lib/types.ts`      | `LlmConfig`, `LlmExecution`, `LlmCriteria` 型定義追加、`DecisionStatus` に `pending` を追加（LLMのみ）                        |

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



7. Gemini APIのコードスニペット


この例では、`object`、`array`、`string`、`integer` などの基本的な JSON スキーマ型を使用して、テキストから構造化データを抽出する方法を示します。

[Python](https://ai.google.dev/gemini-api/docs/structured-output?hl=ja&example=recipe#python)[JavaScript](https://ai.google.dev/gemini-api/docs/structured-output?hl=ja&example=recipe#javascript)[Go](https://ai.google.dev/gemini-api/docs/structured-output?hl=ja&example=recipe#go)[REST](https://ai.google.dev/gemini-api/docs/structured-output?hl=ja&example=recipe#rest)

```
import{GoogleGenAI}from"@google/genai";
import{z}from"zod";
import{zodToJsonSchema}from"zod-to-json-schema";

constingredientSchema=z.object({
name:z.string().describe("Name of the ingredient."),
quantity:z.string().describe("Quantity of the ingredient, including units."),
});

constrecipeSchema=z.object({
recipe_name:z.string().describe("The name of the recipe."),
prep_time_minutes:z.number().optional().describe("Optional time in minutes to prepare the recipe."),
ingredients:z.array(ingredientSchema),
instructions:z.array(z.string()),
});

constai=newGoogleGenAI({});

constprompt=`
Please extract the recipe from the following text.
The user wants to make delicious chocolate chip cookies.
They need 2 and 1/4 cups of all-purpose flour, 1 teaspoon of baking soda,
1 teaspoon of salt, 1 cup of unsalted butter (softened), 3/4 cup of granulated sugar,
3/4 cup of packed brown sugar, 1 teaspoon of vanilla extract, and 2 large eggs.
For the best part, they'll need 2 cups of semisweet chocolate chips.
First, preheat the oven to 375°F (190°C). Then, in a small bowl, whisk together the flour,
baking soda, and salt. In a large bowl, cream together the butter, granulated sugar, and brown sugar
until light and fluffy. Beat in the vanilla and eggs, one at a time. Gradually beat in the dry
ingredients until just combined. Finally, stir in the chocolate chips. Drop by rounded tablespoons
onto ungreased baking sheets and bake for 9 to 11 minutes.
`;

constresponse=awaitai.models.generateContent({
model:"gemini-2.5-flash",
contents:prompt,
config:{
responseMimeType:"application/json",
responseJsonSchema:zodToJsonSchema(recipeSchema),
},
});

constrecipe=recipeSchema.parse(JSON.parse(response.text));
console.log(recipe);
```

**レスポンスの例:**

```
{
"recipe_name":"Delicious Chocolate Chip Cookies",
"ingredients":[
{
"name":"all-purpose flour",
"quantity":"2 and 1/4 cups"
},
{
"name":"baking soda",
"quantity":"1 teaspoon"
},
{
"name":"salt",
"quantity":"1 teaspoon"
},
{
"name":"unsalted butter (softened)",
"quantity":"1 cup"
},
{
"name":"granulated sugar",
"quantity":"3/4 cup"
},
{
"name":"packed brown sugar",
"quantity":"3/4 cup"
},
{
"name":"vanilla extract",
"quantity":"1 teaspoon"
},
{
"name":"large eggs",
"quantity":"2"
},
{
"name":"semisweet chocolate chips",
"quantity":"2 cups"
}
],
"instructions":[
"Preheat the oven to 375°F (190°C).",
"In a small bowl, whisk together the flour, baking soda, and salt.",
"In a large bowl, cream together the butter, granulated sugar, and brown sugar until light and fluffy.",
"Beat in the vanilla and eggs, one at a time.",
"Gradually beat in the dry ingredients until just combined.",
"Stir in the chocolate chips.",
"Drop by rounded tablespoons onto ungreased baking sheets and bake for 9 to 11 minutes."
]
}
```
