# 操作解説動画 制作パイプライン

TiAb Review Plugin の操作解説動画（YouTube 公開用）を、Playwright による自動収録 + VOICEVOX
による自動音声合成 + ffmpeg による自動合成で作るためのパイプライン。要件定義は
[REQUIREMENTS.md](./REQUIREMENTS.md) を参照。

## ディレクトリ構成

```
video/
├── REQUIREMENTS.md   要件定義書
├── README.md          本書
├── scenes/            Playwright シーンスクリプト（video/scripts/record.mjs が読み込む）
├── narration/         ナレーション原稿（日本語、チャプターごとに1ファイル）
├── subtitles/         英語字幕ソース（narration と対になるチャプターごとに1ファイル）
├── assets/            サムネイルテンプレート等の静的素材
├── scripts/           パイプライン本体（Node.js ESM, .mjs）
│   ├── config.mjs      共通設定（パス・解像度・VOICEVOX/ffmpeg 接続先 等）
│   ├── record.mjs       収録（シーン → video/build/scenes/<NN-slug>/）
│   ├── tts.mjs           音声合成（原稿 → video/build/audio/<NN-slug>/）
│   ├── assemble.mjs      合成（build/ 一式 → 最終動画・チャプター・字幕・説明文・サムネイル）
│   ├── setup.sh          環境セットアップ（冪等）
│   └── lib/              パーサ・ffmpeg ラッパー等の共通ユーティリティ
└── build/             生成物（git 管理外。.gitignore 済み）
```

## 前提環境

- Node.js 18 以上（`package.json` の `engines` 参照）
- Linux + [xvfb](https://www.x.org/releases/X11R7.6/doc/man/man1/Xvfb.1.xhtml)（拡張機能を読み込んだ Chromium
  をヘッド付きで動かして収録するため。収録コマンドは常に `xvfb-run` 経由で実行する）
- Python3 + [py7zr](https://pypi.org/project/py7zr/)（`pip install py7zr`）
  （VOICEVOX エンジンの配布形式が 7z のため、`video/scripts/setup.sh` の展開に使用）
- ネットワーク到達性（初回セットアップ時のみ。Playwright の Chromium、ffmpeg、VOICEVOX
  エンジンをダウンロードする）

## 使い方（基本の4ステップ）

```bash
# 0. 環境セットアップ（初回のみ。以後は冪等なので再実行しても安全）
npm run video:setup

# 1. デモ用拡張機能ビルド（Playwright 収録用。実データ・実アカウントを使わない）
npm run build:demo

# 2. シーン収録（Playwright + xvfb。LANGUAGE=ja を必ず付与する）
LANGUAGE=ja xvfb-run -a -s "-screen 0 1920x1080x24" npm run video:record

# 3. ナレーション音声合成（VOICEVOX エンジンが起動していること）
npm run video:tts

# 4. 最終合成（動画結合・チャプター・字幕・説明文・サムネイル生成）
npm run video:assemble
```

生成物は `video/build/` 配下にまとまる（後述）。

### ffmpeg / ffprobe の実行ファイル指定

`video/scripts/setup.sh` が `video/tools/` 配下に展開した場合、`config.mjs` は
**環境変数 → PATH 上のコマンド** の順でしか自動解決しないため、`video/tools/` に置いた
バイナリを使うときは明示的に環境変数を指定する（`setup.sh` 実行時にも案内が表示される）。

```bash
export FFMPEG_PATH="$(pwd)/video/tools/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg"
export FFPROBE_PATH="$(pwd)/video/tools/ffmpeg-master-latest-linux64-gpl/bin/ffprobe"
```

### Playwright の Chromium 実行ファイル指定

既定では `/opt/pw-browsers/chromium` があればそれを使い、無ければ Playwright 標準の解決
（開発機で `npx playwright install chromium` 実行後に使われるパス）にフォールバックする。
別の場所を明示したい場合は `PLAYWRIGHT_CHROMIUM_PATH` を設定する。

### VOICEVOX エンジンの接続先

既定は `http://127.0.0.1:50021`、話者は四国めたん（ノーマル・話者ID 2）。変更する場合は
`VOICEVOX_URL` / `VOICEVOX_SPEAKER` を環境変数で指定する。

## シーンを1本だけ再収録する

機能追加時などにチャプター1本だけを更新したい場合、対象シーンの `video/scenes/NN-slug.mjs`
（と、必要なら `video/narration/NN-slug.md` / `video/subtitles/NN-slug.md`）だけを編集し、
以下のように収録対象を絞って再実行する。

```bash
LANGUAGE=ja xvfb-run -a -s "-screen 0 1920x1080x24" \
  node video/scripts/record.mjs 05-ml-screening

npm run video:tts -- 05-ml-screening   # 原稿を変更した場合のみ（未変更のcueは自動でスキップされる）
npm run video:assemble                 # 常に build/ 全体から再生成する
```

引数はシーンファイルのフルネーム（`05-ml-screening`）でも、番号部分（`05`）だけでも一致する。
引数を省略すると、それぞれ `video/scenes/` `video/narration/` 配下の全ファイルが対象になる。

`tts.mjs` は原稿本文と話者IDのハッシュを `video/build/audio/<key>/index.json` に保存しており、
変更の無い cue は再生成をスキップする。`assemble.mjs` は毎回 `video/build/` 全体から作り直す
（各シーン mp4・最終 mp4・チャプター・字幕・説明文・サムネイルをすべて再生成する）。

## ナレーション原稿・字幕・シーンスクリプトの対応関係（CONTRACT）

1チャプター = 1シーンスクリプト（`video/scenes/NN-slug.mjs`）+ 1ナレーション原稿
（`video/narration/NN-slug.md`）+ 1英語字幕ソース（`video/subtitles/NN-slug.md`）が基本単位。
`NN` はチャプター番号（2桁ゼロ埋め）、`slug` はシーン名。

### ナレーション原稿の形式（`video/narration/NN-slug.md`）

```markdown
---
scene: "NN"
slug: slug-name
title: チャプタータイトル      # chapters.txt・description.txt に使われる
target_seconds: 90            # 目安秒数（パイプラインは参照のみ、強制はしない）
---

## cue 01
<!-- action: 画面操作の補足メモ（TTSには渡らない。HTMLコメントは自動で除去される） -->
実際にTTSで読み上げる本文。複数行に分けて書いても、合成時は半角スペースで
1つの発話として結合される。

## cue 02
...
```

### 英語字幕ソースの形式（`video/subtitles/NN-slug.md`）

ナレーション原稿と同じ `## cue NN` 形式。`title` 等の frontmatter は無くてもよい。
cue 番号（`n`）はナレーション原稿・シーンスクリプトの `ctx.cue(n)` と対応させる。

### シーンスクリプトの CONTRACT（`video/scenes/NN-slug.mjs`）

CONTRACT の全文と ctx API の詳細は `video/scripts/record.mjs` の先頭コメントに記載している
（実装時はそちらを一次情報として参照すること）。要点:

- `export default { id, slug, title, narration?, storageSeed?, pageQuery?, async run(ctx) {...} }`
- `narration`（省略可）: 使用するナレーション原稿・字幕ソースのキー。省略時は `${id}-${slug}`。
  ナレーション無し（映像のみ）のシーンにしたい場合は `narration: null` を指定する。
- `storageSeed`（省略可）: 収録前に `chrome.storage.local` へ流し込む初期状態。ログイン画面を
  スキップしたい場合は `{ demo_signed_in: true }` を指定する（`video/scenes/00-smoke.mjs` 参照）。
- `run(ctx)` の中で `ctx.cue(n)` を呼んだタイミングが、そのナレーション cue の発声開始時刻の
  目安として記録される。`ctx.newSegment(page)` を呼ぶと、以後の `ctx.page`/`ctx.cue()` は
  新しいタブ（例: フルテキストページ）を基準に切り替わる。

サンプル: [`video/scenes/00-smoke.mjs`](./scenes/00-smoke.mjs)（スモークテスト用。narration を
`01-intro` に向けて音声付きで最後まで通す）。実際のチャプター01〜11のシーンは別タスクで追加する。

## タイミング精度についての注意

- `ctx.cue(n)` が記録するのは「その瞬間の壁時計時刻」を、アクティブなセグメント（ページ）が
  作られた瞬間からの相対秒数に変換した値。sub秒（1秒未満）オーダーの誤差が生じうる。
- `assemble.mjs` は各キューの音声を「その cue の想定発声時刻」と「直前の cue 音声終了 +
  最短間隔（`MIN_CUE_GAP_SEC` = 0.3秒）」の遅い方に配置するため、多少のタイミングのズレは
  自然に吸収される（早口で操作してもナレーションが重ならない）。
- ナレーション音声の合計がシーン映像より長くなった場合は、映像の最終フレームを複製して
  引き伸ばす（`tpad`）。逆に映像がナレーションより長い場合は、映像の自然な尺がそのまま使われる。

## 生成物一覧（`video/build/`, git 管理外）

| パス | 内容 |
| --- | --- |
| `scenes/<NN-slug>/segment-K.webm` | 収録した生の映像セグメント（`record.mjs`） |
| `scenes/<NN-slug>/meta.json` | セグメント・キュー時刻等のメタデータ（`record.mjs`） |
| `audio/<NN-slug>/cue-NN.wav` | 合成したナレーション音声（`tts.mjs`） |
| `audio/<NN-slug>/index.json` | cue ごとの音声メタ・再合成スキップ用ハッシュ（`tts.mjs`） |
| `scenes/<NN-slug>.mp4` | シーン単体の完成動画（映像+ナレーション、`assemble.mjs`） |
| `final.mp4` | 全シーンを結合した最終動画（`assemble.mjs`） |
| `chapters.txt` | YouTube 説明欄に貼るチャプタータイムスタンプ |
| `timeline.json` | シーンごとの尺・cue 配置時刻の記録 |
| `subtitles-en.srt` | 英語字幕（YouTube の字幕トラックとしてアップロード） |
| `description.txt` | YouTube 説明欄用テキスト（チャプター・リンク・クレジット込み） |
| `thumbnail.png` | サムネイル（`video/assets/thumbnail.html` を撮影） |

これらはすべて `video/build/` から再生成可能なため git 管理しない
（`.gitignore` の `video/build/` / `video/tools/` を参照）。
