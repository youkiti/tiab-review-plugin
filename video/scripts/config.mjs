// 動画制作パイプライン共通設定
//
// record.mjs / tts.mjs / assemble.mjs から共通で読み込む。パス解決・解像度・
// VOICEVOX 接続先・ffmpeg/ffprobe の探索順など、パイプライン全体の定数をここに集約する。
// 値を変更すればパイプライン全体に反映される。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリルート（video/scripts/ の2階層上） */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** video/ ディレクトリ */
export const VIDEO_ROOT = path.resolve(__dirname, '..');

/** デモ拡張機能のビルド成果物（`npm run build:demo` の出力） */
export const DIST_DEMO_DIR = path.join(REPO_ROOT, 'dist-demo');

/** 生成物の出力先（git 管理外） */
export const BUILD_DIR = path.join(VIDEO_ROOT, 'build');
export const BUILD_SCENES_DIR = path.join(BUILD_DIR, 'scenes');
export const BUILD_AUDIO_DIR = path.join(BUILD_DIR, 'audio');

/** シーンスクリプト・原稿・字幕ソースの置き場所 */
export const SCENES_DIR = path.join(VIDEO_ROOT, 'scenes');
export const NARRATION_DIR = path.join(VIDEO_ROOT, 'narration');
export const SUBTITLES_DIR = path.join(VIDEO_ROOT, 'subtitles');
export const ASSETS_DIR = path.join(VIDEO_ROOT, 'assets');

/** 映像の解像度・フレームレート（全シーン共通） */
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const FPS = 30;

/** サムネイルの解像度（YouTube 推奨サイズ） */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/** VOICEVOX エンジン接続先。環境変数で上書き可能 */
export const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';

/** ナレーター話者ID。既定は四国めたん（ノーマル） */
export const VOICEVOX_SPEAKER = Number(process.env.VOICEVOX_SPEAKER || 2);

/**
 * キュー（ナレーション区切り）同士の音声の最小間隔（秒）。
 * 前のキューの音声終了より早く次のキューの開始時刻が来た場合、この間隔を確保するよう
 * 後ろへずらす（assemble.mjs 参照）。
 */
export const MIN_CUE_GAP_SEC = 0.3;

/**
 * シーン開始から最初のキューが発声されるまでの「間（ま）」の最短秒数。
 * 画面が切り替わった直後にいきなり喋り出すと不自然なため、収録シーン側で
 * この秒数だけ待ってから ctx.cue(1) を呼ぶことを推奨する（scene のドキュメント参照）。
 */
export const SCENE_LEAD_IN_SEC = 0.8;

/** Playwright 用 Chromium の実行ファイルパスを解決する */
export function resolveChromiumExecutable() {
    const envPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (envPath && existsSync(envPath)) {
        return envPath;
    }
    const defaultPath = '/opt/pw-browsers/chromium';
    if (existsSync(defaultPath)) {
        return defaultPath;
    }
    // どちらも無ければ undefined を返し、Playwright 既定の解決（開発機で
    // `npx playwright install chromium` 実行後に使われるパス）に委ねる。
    return undefined;
}

/**
 * env var → PATH 上のコマンド → エラー、の順で実行ファイルを解決する。
 * 見つからない場合は日本語の分かりやすいエラーメッセージで例外を投げる。
 */
function resolveExecutable(envVarName, commandName) {
    const envPath = process.env[envVarName];
    if (envPath) {
        if (!existsSync(envPath)) {
            throw new Error(
                `${envVarName} に指定されたパスが存在しません: ${envPath}\n` +
                `正しいパスを指定するか、環境変数を解除して PATH 上の ${commandName} を使ってください。`,
            );
        }
        return envPath;
    }
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const found = execFileSync(which, [commandName], { encoding: 'utf8' }).trim().split('\n')[0];
        if (found) {
            return found;
        }
    } catch {
        // PATH 上に見つからない場合は下のエラーへフォールスルー
    }
    throw new Error(
        `${commandName} が見つかりません。以下のいずれかで解決してください。\n` +
        `  1. 環境変数 ${envVarName} に ${commandName} の実行ファイルパスを設定する\n` +
        `  2. ${commandName} を PATH の通った場所にインストールする\n` +
        `  3. video/scripts/setup.sh を実行して video/tools/ 配下に自動セットアップする`,
    );
}

/** ffmpeg 実行ファイルのパスを解決する（呼び出し時に評価。存在しなければ例外） */
export function resolveFfmpeg() {
    return resolveExecutable('FFMPEG_PATH', 'ffmpeg');
}

/** ffprobe 実行ファイルのパスを解決する（呼び出し時に評価。存在しなければ例外） */
export function resolveFfprobe() {
    return resolveExecutable('FFPROBE_PATH', 'ffprobe');
}
