#!/usr/bin/env bash
# 動画制作パイプラインの環境セットアップ（Linux 向け・冪等）
#
# 使い方:
#   bash video/scripts/setup.sh
#   （package.json からは `npm run video:setup` でも実行できる）
#
# 何度実行しても安全なように、各ステップは「既に揃っているか」を確認してからのみ
# ダウンロード・インストールを行う。実行内容:
#   1. npm ci                                  （依存パッケージのインストール）
#   2. Playwright Chromium の取得              （PLAYWRIGHT_CHROMIUM_PATH が既存ならスキップ）
#   3. ffmpeg/ffprobe の取得（BtbN ビルド）     （FFMPEG_PATH 指定 or PATH 上に既存ならスキップ）
#   4. VOICEVOX エンジンの取得・起動           （VOICEVOX_URL が既に応答するならスキップ）
#
# ffmpeg・VOICEVOX はいずれも video/tools/ 配下に展開する（.gitignore 済み・git 管理外）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VIDEO_TOOLS_DIR="$REPO_ROOT/video/tools"
mkdir -p "$VIDEO_TOOLS_DIR"

# ----------------------------------------------------------------------------
# 1. npm 依存パッケージ
# ----------------------------------------------------------------------------
echo "==> [1/4] npm ci"
(cd "$REPO_ROOT" && npm ci)

# ----------------------------------------------------------------------------
# 2. Playwright Chromium
# ----------------------------------------------------------------------------
echo "==> [2/4] Playwright Chromium"
if [ -n "${PLAYWRIGHT_CHROMIUM_PATH:-}" ] && [ -e "${PLAYWRIGHT_CHROMIUM_PATH}" ]; then
    echo "    PLAYWRIGHT_CHROMIUM_PATH が既に存在するためスキップ: ${PLAYWRIGHT_CHROMIUM_PATH}"
else
    (cd "$REPO_ROOT" && npx playwright install chromium)
fi

# ----------------------------------------------------------------------------
# 3. ffmpeg / ffprobe（BtbN FFmpeg-Builds の静的バイナリ、linux64-gpl・rolling latest）
#    注意: BtbN の "latest" タグはローリング更新のため、バイナリの厳密なバージョン固定は
#    されない（再現性が必要な場合は FFMPEG_PATH / FFPROBE_PATH で固定バイナリを明示する）。
# ----------------------------------------------------------------------------
echo "==> [3/4] ffmpeg / ffprobe"
FFMPEG_DIR="$VIDEO_TOOLS_DIR/ffmpeg-master-latest-linux64-gpl"
if [ -n "${FFMPEG_PATH:-}" ] && [ -e "${FFMPEG_PATH}" ]; then
    echo "    FFMPEG_PATH が既に存在するためスキップ: ${FFMPEG_PATH}"
elif command -v ffmpeg >/dev/null 2>&1; then
    echo "    PATH 上に ffmpeg が見つかったためスキップ: $(command -v ffmpeg)"
elif [ -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
    echo "    video/tools/ に展開済みのためダウンロードをスキップ: $FFMPEG_DIR/bin/ffmpeg"
else
    echo "    BtbN/FFmpeg-Builds (linux64-gpl, latest) をダウンロードします..."
    curl -sSL -o "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz" \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
    tar -xf "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz" -C "$VIDEO_TOOLS_DIR"
    rm -f "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz"
fi
if [ -x "$FFMPEG_DIR/bin/ffmpeg" ] && [ -z "${FFMPEG_PATH:-}" ] && ! command -v ffmpeg >/dev/null 2>&1; then
    echo "    ffmpeg/ffprobe を展開しました。実行時は以下を指定してください:"
    echo "      export FFMPEG_PATH=$FFMPEG_DIR/bin/ffmpeg"
    echo "      export FFPROBE_PATH=$FFMPEG_DIR/bin/ffprobe"
fi

# ----------------------------------------------------------------------------
# 4. VOICEVOX エンジン（linux-cpu-x64, バージョン固定）
# ----------------------------------------------------------------------------
echo "==> [4/4] VOICEVOX エンジン"
VOICEVOX_VERSION="0.24.1"
VOICEVOX_URL_CHECK="${VOICEVOX_URL:-http://127.0.0.1:50021}"
VOICEVOX_DIR="$VIDEO_TOOLS_DIR/voicevox"
VOICEVOX_ENGINE_BIN="$VOICEVOX_DIR/linux-cpu-x64/run"

if curl -sS -o /dev/null -m 3 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
    echo "    VOICEVOX エンジンは既に起動中です: $VOICEVOX_URL_CHECK"
else
    if [ -x "$VOICEVOX_ENGINE_BIN" ]; then
        echo "    video/tools/ に展開済みのためダウンロードをスキップ: $VOICEVOX_ENGINE_BIN"
    else
        echo "    VOICEVOX エンジン v${VOICEVOX_VERSION}（linux-cpu-x64）をダウンロードします..."
        echo "    ※ 7z 展開に python3 の py7zr を使用します（未インストールの場合: pip install py7zr）"
        mkdir -p "$VOICEVOX_DIR"
        curl -sSL -o "$VIDEO_TOOLS_DIR/voicevox_engine.7z" \
            "https://github.com/VOICEVOX/voicevox_engine/releases/download/${VOICEVOX_VERSION}/voicevox_engine-linux-cpu-x64-${VOICEVOX_VERSION}.7z.001"
        python3 -c "
import py7zr
with py7zr.SevenZipFile('$VIDEO_TOOLS_DIR/voicevox_engine.7z', mode='r') as z:
    z.extractall(path='$VOICEVOX_DIR')
"
        rm -f "$VIDEO_TOOLS_DIR/voicevox_engine.7z"
        chmod +x "$VOICEVOX_ENGINE_BIN"
    fi

    echo "    VOICEVOX エンジンをバックグラウンドで起動します..."
    nohup "$VOICEVOX_ENGINE_BIN" --host 127.0.0.1 --port 50021 \
        > "$VIDEO_TOOLS_DIR/voicevox.log" 2>&1 &
    disown

    echo "    起動待機中..."
    for _ in $(seq 1 60); do
        if curl -sS -o /dev/null -m 2 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
            echo "    VOICEVOX エンジンが起動しました: $VOICEVOX_URL_CHECK"
            break
        fi
        sleep 2
    done
    if ! curl -sS -o /dev/null -m 3 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
        echo "    警告: VOICEVOX エンジンの起動確認ができませんでした。ログを確認してください: $VIDEO_TOOLS_DIR/voicevox.log" >&2
    fi
fi

echo ""
echo "セットアップ完了。"
echo "次のコマンドで動画を生成できます: npm run build:demo && npm run video:record && npm run video:tts && npm run video:assemble"
