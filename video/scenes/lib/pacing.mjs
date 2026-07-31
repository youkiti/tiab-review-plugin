// シーン収録の「間」を作るための共通ヘルパー
//
// video/build/audio/<key>/index.json（tts.mjs の出力）を読み、各キューのナレーション
// 尺（durationSec）を取得する。シーンスクリプトは、ctx.cue(n) を打った直後に
// 「durationSec + 0.5秒」だけ画面を意味のある状態に保ってから次のアクションに進む
// ことで、音声とシーン内の操作のタイミングを合わせる（詳細は AGENTS 側のタイミング
// 設計を参照）。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD_AUDIO_DIR } from '../../scripts/config.mjs';

/**
 * video/build/audio/<narrationKey>/index.json を読み込み、
 * { 'NN': durationSec, ... } の形の Map を返す。
 * 未生成の場合は、`node video/scripts/tts.mjs` の実行を促す分かりやすい日本語エラーを投げる。
 */
export function loadCueDurations(narrationKey) {
    const indexPath = path.join(BUILD_AUDIO_DIR, narrationKey, 'index.json');
    if (!existsSync(indexPath)) {
        throw new Error(
            `ナレーション音声が見つかりません: ${indexPath}\n` +
            `先に \`node video/scripts/tts.mjs\` を実行して音声を生成してください` +
            `（VOICEVOX エンジンが起動している必要があります）。`,
        );
    }
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const durations = {};
    for (const cue of index.cues) {
        durations[cue.n] = cue.durationSec;
    }
    return durations;
}

/**
 * startedAtMs（Date.now() で記録したこのキューの開始時刻）から、
 * 少なくとも minMs ミリ秒が経過するまで待つ。既に経過済みなら待たない。
 */
export async function sleepRemainder(ctx, startedAtMs, minMs) {
    const elapsed = Date.now() - startedAtMs;
    const remaining = minMs - elapsed;
    if (remaining > 0) {
        await ctx.sleep(remaining);
    }
}
