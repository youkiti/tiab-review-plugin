// ffmpeg / ffprobe 呼び出しの薄いラッパー。config.mjs の resolveFfmpeg/resolveFfprobe で
// 実行ファイルパスを解決し、ここでは子プロセス実行と結果パースだけを担当する。

import { spawn } from 'node:child_process';
import { resolveFfmpeg, resolveFfprobe } from '../config.mjs';

/** 子プロセスを実行し、失敗時は stderr を含めてエラーにする */
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`${cmd} が失敗しました (exit ${code}):\n${stderr.slice(-4000)}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/** ffmpeg をオプション配列付きで実行する（先頭に -y を自動付与） */
export async function ffmpeg(args) {
    const bin = resolveFfmpeg();
    return run(bin, ['-y', ...args]);
}

/** ffprobe で動画/音声ファイルの再生時間(秒)を取得する */
export async function ffprobeDuration(filePath) {
    const bin = resolveFfprobe();
    const { stdout } = await run(bin, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
    ]);
    const value = Number(stdout.trim());
    if (!Number.isFinite(value)) {
        throw new Error(`ffprobe で再生時間を取得できませんでした: ${filePath}`);
    }
    return value;
}

/** ffprobe で映像・音声ストリームの有無を調べる（スモークテスト検証等に使用） */
export async function ffprobeStreams(filePath) {
    const bin = resolveFfprobe();
    const { stdout } = await run(bin, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'default=noprint_wrappers=1',
        filePath,
    ]);
    return stdout;
}
