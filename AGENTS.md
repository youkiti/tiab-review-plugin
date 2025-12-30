# TiAb Review Plugin - AGENTS.md

# CRITICAL PROTOCOLS (ABSOLUTE PRIORITY)

以下のルールは、いかなる状況でも最優先で遵守すること：

1. **ブランチ強制**: コードを変更する前には必ず `git branch` を確認し、作業用ブランチを作成すること。`main`・`master`・`develop` での作業は禁止。
2. **10ステップ報告**: 処理が10ステップ経過するごとに、必ず作業を一時停止し、`notify_user` で進捗を報告すること。
3. **日本語化**: ユーザーに提示するアーティファクト（計画書・タスク・確認事項）は、作成時に必ず日本語で記述すること。
4. **不要ファイル・ブランチの削除**: テストなどで作成したファイルやブランチは不要になった時点で削除すること。
5. **言語規定**: 思考プロセスは英語で行う。ユーザーへのレスポンス、アーティファクト、コミットメッセージ、コード内のコメントは必ず日本語で記述すること。（システムエラーやログの引用は原文のままでよい）
6. **自動化の限界と報告**: ツール実行が複数回失敗した場合や、権限不足・環境固有の問題に直面した場合は、執拗に再試行せず、直ちにユーザーに状況を報告し手動対応を依頼すること。
7. **品質保証**: コード修正完了時は、必ずLint（構文チェック）と関連テストを実行し、PASSすることを確認してからユーザーへ報告すること。
8. **既存テストの保護**: 修正により既存のテストが失敗した場合、テストコードを安易に修正してはならない。まず実装のバグを疑い、テスト修正が必要な場合は、それが「意図した仕様変更」であることをユーザーに確認すること。
9. **機密情報の保護**: パスワード、APIキー、トークンなどの機密情報を、ログ・アーティファクト・チャットの応答などに絶対に出力しないこと。`.env`の取り扱いに注意すること。
10. **ドキュメントの同期**: 機能や仕様を変更した際は、コードの修正だけでなく、関連するドキュメント（README、API仕様書、主要なコメント等）も必ず同期して更新すること。
11. **作業中断時のロールバック**: エラーや中断によりタスクを終了する場合、ユーザーの明示的な指示がない限り、修正途中の不安定な状態を残さず、作業開始前のクリーンな状態に復元すること。

## プロジェクト概要

**Title & Abstract (TiAb) Review Plugin** は、Systematic Review における文献スクリーニングを効率化するChrome拡張機能です。

Google スプレッドシートを共有データベースとして使用し、複数のレビュアーがタイトル・抄録レベルでの文献評価（include/exclude/maybe）を行えるツールを開発します。

## 技術スタック

- **フロントエンド**: Chrome Extension (Manifest V3)
  - Popup / Side Panel UI
  - Content Scripts (ページからのメタデータ抽出用、将来拡張)
- **認証**: Google OAuth 2.0 (`chrome.identity.getAuthToken`)
- **バックエンド**: Google Sheets API (読み取り・追記)
- **言語**: TypeScript, HTML, CSS

## Manifest要件（要件抜粋）

- `permissions`: `identity`, `storage`
- `host_permissions`: `https://sheets.googleapis.com/*`
- `oauth2`: `client_id`, `scopes`（Sheets APIの最小スコープ）
- `side_panel`: サイドパネル利用時に定義
- `commands`: ショートカット定義（単一キーはUI内で処理）

## データ設計

### スプレッドシート構造

1つのスプレッドシートをレビュー単位で作成し、以下のタブを用意:

#### References タブ（文献マスタ）

| 列名        | 説明                 | 必須 |
| ----------- | -------------------- | ---- |
| ref_id      | 文献主キー（UUID）   | ✓   |
| title       | タイトル             | ✓   |
| abstract    | 抄録                 |      |
| year        | 出版年               |      |
| authors     | 著者                 |      |
| journal     | ジャーナル名         |      |
| doi         | DOI                  |      |
| pmid        | PubMed ID            |      |
| url         | URL                  |      |
| source      | 取り込み元DB         |      |
| imported_at | 取り込み日時         |      |
| imported_by | 取り込み者           |      |
| dedupe_key  | 重複検出キー（後述） |      |

#### Decisions タブ（最新判定のみを有効にする判定ログ）

| 列名           | 説明                          | 必須 |
| -------------- | ----------------------------- | ---- |
| decision_id    | 判定ID（UUID）                | ✓   |
| ref_id         | 文献ID（Referencesと結合）    | ✓   |
| reviewer_id    | 判定者（email）               | ✓   |
| decision       | include / exclude / maybe     | ✓   |
| reason         | 除外理由（excludeの場合必須） |      |
| labels         | (廃止)                        |      |
| note           | メモ                          |      |
| decided_at     | 判定日時（ISO 8601）          | ✓   |
| client_version | 拡張機能バージョン            |      |
| source_url     | 判定時に見ていたURL           |      |

**重要**:

- **本人の判定**: 同一 `ref_id` + `reviewer_id` の既存判定は上書き可能（新しい判定で更新）
- **他者の判定**: 他の `reviewer_id` の判定行は上書き禁止
- 判定履歴は保持しない（最新判定のみを有効とする）
- **衝突解決**: 同時編集が発生した場合は `decided_at` の新しい判定を優先

#### Config タブ（プロジェクト設定）

- **include_keywords**: 組み入れハイライト用キーワード（緑）
- **exclude_keywords**: 除外ハイライト用キーワード（赤）

## 機能要件

### MVP（必須機能）

1. **初期設定**

   - スプレッドシートID入力
   - References/Decisionsシート名設定
   - プロジェクト指定（Google Drive上のスプレッドシートを選択、Drive Picker 使用）
   - スプレッドシートが存在しない場合は新規作成（References/Decisions/Configシート自動生成）
   - RISアップロード機能
2. **文献読み込み**

   - Referencesから文献一覧を取得
   - Decisionsから判定状態を算出
3. **スクリーニング画面**

   - 文献情報表示（title, abstract, year, authors, journal, doi/pmid, url）
   - **キーワードハイライト機能**（include=緑, exclude=赤）
   - 判定ボタン（include / exclude / maybe）
   - 除外理由入力（exclude時必須）
   - メモ入力
   - **キーワード編集**（サイドパネルで追加・削除→Configシートへ自動保存）
   - 次の文献へ遷移
4. **判定の記録**

   - Decisionsタブへ判定を保存
   - **新規判定**: `spreadsheets.values.append` で追記
   - **判定更新**: 既存行を検索し `spreadsheets.values.update` で上書き
   - 同一 `ref_id` + `reviewer_id` の行が存在する場合は更新、なければ新規追加
5. **フィルタ・検索**

   - 未判定（自分が未判定）フィルタ
   - decision別フィルタ
   - maybeは未判定とは別カテゴリとして集計
   - title/abstract検索
6. **進捗表示**

   - 自分の判定件数
   - 全体の対象件数（レビュー対象総数）

### キーボードショートカット

- `i` : Include
- `e` : Exclude
- `m` : Maybe
- `n` / `→` : 次へ
- `p` / `←` : 前へ

## 非機能要件

- **パフォーマンス**: 3,000件で快適に動作
- **信頼性**: オフライン中の判定をローカルキューに保持し、オンライン復帰後に同期
- **セキュリティ**: トークンをログ出力しない、最小スコープ

## 運用ルール

- **reviewer_id**: `chrome.identity.getProfileUserInfo()` で取得したemail固定。表示名/匿名IDは使用しない
  - 取得前提: ユーザーはGoogleアカウントにログイン済みで、拡張機能がOAuth同意済み
  - 取得できない場合は作業をブロックし、再ログインと同意を促す
    - UIメッセージ: 「Googleアカウントにログインしてください」
- **競合時の優先順位**: 同時編集が発生した場合は `decided_at` の新しい判定を優先（Last Write Wins）
- **アクセス制御**: 編集権限が必要。対象スプレッドシートはGoogle Drive上で管理
- **判定理由**: 任意入力。バリデーションは行わない

## インポート規約

- **必須列**: `title`
- **欠損値**: 空白として取り込み
- **abstract制限**: 15,000文字を超える場合は超過分を切り取り（通常の抄録は500-2000文字程度）

### dedupe_key 生成ロジック

重複検出キーは以下のルールで生成:

```
dedupe_key = normalize(title).substring(0, 100) + "|" + year + "|" + normalize(firstAuthorLastName)
```

- `normalize()`: 小文字化、記号除去、空白正規化
- `year` または `firstAuthorLastName` が欠損の場合は空文字として扱う
- DOI が存在する場合は DOI を優先使用（完全一致）

### RIS インポートフィールドマッピング

| RIS タグ     | References 列 | 備考                   |
| ------------ | ------------- | ---------------------- |
| TI / T1      | title         | 必須                   |
| AB / N2      | abstract      |                        |
| PY / Y1      | year          | 年部分のみ抽出         |
| AU / A1      | authors       | セミコロン区切りで結合 |
| JO / JF / T2 | journal       | 優先順位: JO > JF > T2 |
| DO           | doi           |                        |
| AN（PubMed） | pmid          | ソースがPubMedの場合   |
| UR / L1      | url           |                        |
| DB           | source        |                        |

### オフライン同期の方針

- **キュー永続化**:
  - **小規模（100件未満）**: `chrome.storage.local` を使用（5MB制限）
  - **大規模**: IndexedDB を使用（容量制限なし）
- **冪等性**: `decision_id` を固定し、再送時は同一IDとして扱う
- **同期順序**: `decided_at` の昇順で送信し、失敗時は次回再試行
- **衝突解決**: 同一 `ref_id` + `reviewer_id` の既存行がある場合は更新（最新判定を有効）

### エラーハンドリング

- **OAuth失効**: 再ログイン促進（`chrome.identity.removeCachedAuthToken` 後に再取得）、作業続行不可の明示、オフラインキューへ退避
- **権限不足**: 権限不足メッセージ＋シート共有設定への導線、読み取り専用モードへフォールバック
- **クォータ超過**: 指数バックオフ（初回1秒、最大32秒）でリトライ、手動再試行ボタン

### セキュリティガイドライン

- **トークンのサニタイズ**: ログ出力前に `token.substring(0, 8) + '...'` で省略
- **本番ビルド**: `console.log` を除去（webpack/esbuild の drop 設定）
- **ストレージ方針**: センシティブデータは可能な限りメモリ/セッションに置き、永続化が必要な場合は保存前にアプリ側で暗号化

### ローカルデータ管理

- **キャッシュクリア**: シート切り替え時に自動削除
- **ログイン切替**: emailごとに別ストレージキーで分離

## ディレクトリ構造（推奨）

```
tiab-review-plugin/
├── .agent/
│   └── AGENTS.md
├── src/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── background/
│   │   └── service-worker.ts  # バックグラウンドスクリプト
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── sidepanel/             # サイドパネルUI（推奨）
│   │   ├── sidepanel.html
│   │   ├── sidepanel.ts
│   │   └── sidepanel.css
│   ├── lib/
│   │   ├── sheets-api.ts      # Google Sheets API ラッパー
│   │   ├── auth.ts            # 認証関連
│   │   ├── storage.ts         # ローカルストレージ
│   │   ├── ris-parser.ts      # RIS ファイルパーサー
│   │   └── types.ts           # 型定義
│   └── utils/
│       └── uuid.ts
├── dist/                       # ビルド出力
├── package.json
├── tsconfig.json
└── README.md
```

## 型定義

```typescript
// types.ts

export interface Reference {
  ref_id: string;           // UUID
  title: string;
  abstract?: string;
  year?: number;
  authors?: string;
  journal?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  source?: string;
  imported_at?: string;     // ISO 8601
  imported_by?: string;     // email
  dedupe_key?: string;
}

export interface Decision {
  decision_id: string;      // UUID
  ref_id: string;
  reviewer_id: string;      // email
  decision: 'include' | 'exclude' | 'maybe';
  reason?: string;          // exclude時必須
  // labels?: string[];     // 廃止 (互換性のため残存するが使用しない)
  note?: string;
  decided_at: string;       // ISO 8601
  client_version?: string;
  source_url?: string;
}

export interface ReviewerState {
  email: string;
  spreadsheetId: string;
  lastSyncedAt?: string;
  offlineQueue: Decision[];
}

export type DecisionStatus = 'pending' | 'include' | 'exclude' | 'maybe';

export interface ReferenceWithStatus extends Reference {
  myDecision?: Decision;
  status: DecisionStatus;
}
```

## API設計

### Google Sheets API 使用方法

```typescript
// 読み取り
GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}

// 追記（判定記録）
POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append
```

### 判定保存フロー

```typescript
async function saveDecision(decision: Decision): Promise<void> {
  const existingRow = await findDecisionRow(decision.ref_id, decision.reviewer_id);
  
  if (existingRow) {
    // 既存行を更新
    await sheetsApi.values.update({
      spreadsheetId,
      range: `Decisions!A${existingRow.rowIndex}:K${existingRow.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [decisionToRow(decision)] } // labelsは空文字で保存
    });
  } else {
    // 新規追加
    await sheetsApi.values.append({
      spreadsheetId,
      range: 'Decisions!A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [decisionToRow(decision)] }
    });
  }
}
```

### 運用フロー要約

- **保存**: 同一 `ref_id` + `reviewer_id` がある場合は `update`、なければ `append`
- **参照**: `ref_id` + `reviewer_id` ごとに1件のみ存在（設計上重複なし）
- **整合性**: 判定更新は1行に集約し、判定履歴は保持しない

### OAuth スコープ

```
# 読み書き（必須）
https://www.googleapis.com/auth/spreadsheets

# ユーザー情報取得（reviewer_id 用）
https://www.googleapis.com/auth/userinfo.email

# Drive/Pickers を使う場合（必須）
https://www.googleapis.com/auth/drive.file
```

> **Note**:
>
> - スプレッドシート新規作成は `spreadsheets.create` を使用（Drive API 不要）。
> - Google Drive上のファイル選択UIは Picker/Drive API と `drive.file` が必須。

## 開発ワークフロー

1. `npm install` - 依存関係インストール
2. `npm run build` - TypeScriptビルド
3. `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダ選択
4. 開発中は `npm run watch` でホットリロード

### テスター向け配布

```bash
npm run build:zip
```

このコマンドは以下を実行:

1. プロダクションビルド
2. `dist.zip` を作成
3. Google Drive（`G:\マイドライブ\00SRWS-PSG\app\tiab review plugin\dist.zip`）へ自動コピー

テスターはGoogle Driveの共有リンクから常に最新版をダウンロード可能。

## 注意事項

- **フルテキスト対応は対象外**（PDFアップロード、PDFビューア等は実装しない）
- **排他制御は不要**（追記型設計のため）
- **重複解決は手動**（自動重複解決は将来拡張）
- **AI推薦は対象外**（将来拡張として検討可能）

## 参考リンク

- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [chrome.identity API](https://developer.chrome.com/docs/extensions/reference/identity/)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [OAuth 2.0 for Chrome Extensions](https://developer.chrome.com/docs/extensions/mv3/tut_oauth/)
