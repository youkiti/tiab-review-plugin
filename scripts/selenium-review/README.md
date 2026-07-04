# Selenium 実機レビュー: 論文用テキスト機能

`showManuscriptModal`（TiAb エクスポートメニュー / フルテキスト結果ビューの「論文用テキスト」）を
実ブラウザで開き、Methods / Results / PRISMA の内容チェックとコピー動作を自動検証する。

## 前提

- Python 3.11+ / `pip install selenium`（4.41 以上、chromedriver は Selenium Manager が自動解決）
- `.env` に `LOCAL_OAUTH_CLIENT_ID` を設定済みで `npm run dev` が通ること
- 判定データ入りの既存プロジェクト（スプレッドシート）

## 実行

```powershell
npm run dev
python scripts\selenium-review\review_manuscript.py --sheet "https://docs.google.com/spreadsheets/d/<ID>/edit"
```

オプション:

| フラグ | 説明 |
| --- | --- |
| `--sheet` | スプレッドシート URL か ID（env `TIAB_REVIEW_SHEET` でも可） |
| `--skip-fulltext` | フルテキスト側の検証をスキップ |
| `--lang ja\|en` | Chrome の言語（既定 ja） |
| `--output-dir` | 出力先（既定 `output/<timestamp>/`） |
| `--keep-open` | 終了後もブラウザを開いたまま（手動確認用） |

## 初回のみ必要な手動操作

1. **Google サインイン**: スクリプトがログインボタンを押した後、ポップアップで
   サインインと権限承認を完了する（最大5分待機）。トークンは専用プロファイル
   `profile/` にキャッシュされ、2回目以降は無人で動く。
2. **拡張の手動ロード**（通常は不要）: 拡張は BiDi `webExtension.install` で毎回
   自動ロードされる（Chrome 137+ では `--load-extension` が無視されるため、
   `--enable-unsafe-extension-debugging` + `--remote-debugging-pipe` を併用）。
   これも失敗した場合のみ、案内に従い chrome://extensions → デベロッパーモード →
   「パッケージ化されていない拡張機能を読み込む」→ `dist/` を選択。

## 出力

`output/<timestamp>/` に:

- `NN-*.png` — スクリーニング画面・エクスポートメニュー・各モーダル等のスクリーンショット
- `extracted.json` — モーダルから抽出した生テキスト（diff 可能）
- `report.md` — PASS/FAIL/INFO のチェック表 + 各セクション全文

終了コード: FAIL が無ければ 0。

## トラブルシューティング

- **profile が使用中**: 前回のレビュー用 Chrome ウィンドウを閉じる。
- **認証をやり直したい**: `profile/` ディレクトリを削除して再実行。
- **クリップボード照合が INFO になる**: ウィンドウが前面にないと
  `navigator.clipboard.readText()` が失敗する。トースト文言の PASS が正の判定。
