// WAV ファイルのヘッダーだけを読んで再生時間(秒)を計算する小さなユーティリティ。
// VOICEVOX の /synthesis はヘッダー付きの PCM WAV (通常 24kHz mono 16bit) を返すため、
// 外部ライブラリなしで RIFF チャンクを辿るだけで十分。

import { readFileSync } from 'node:fs';

/**
 * WAV ファイルのバイナリを解析して { durationSec, sampleRate, numChannels, bitsPerSample } を返す。
 * fmt チャンク・data チャンクの位置はファイルによって前後することがあるため、
 * チャンクを順に辿って両方を見つける。
 */
export function readWavInfo(filePath) {
    const buf = readFileSync(filePath);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`WAV ファイルとして認識できません: ${filePath}`);
    }
    let offset = 12;
    let fmt = null;
    let dataSize = null;
    while (offset + 8 <= buf.length) {
        const chunkId = buf.toString('ascii', offset, offset + 4);
        const chunkSize = buf.readUInt32LE(offset + 4);
        const bodyStart = offset + 8;
        if (chunkId === 'fmt ') {
            fmt = {
                numChannels: buf.readUInt16LE(bodyStart + 2),
                sampleRate: buf.readUInt32LE(bodyStart + 4),
                bitsPerSample: buf.readUInt16LE(bodyStart + 14),
            };
        } else if (chunkId === 'data') {
            dataSize = chunkSize;
        }
        // チャンクは偶数バイトにパディングされる
        offset = bodyStart + chunkSize + (chunkSize % 2);
    }
    if (!fmt || dataSize === null) {
        throw new Error(`WAV の fmt/data チャンクが見つかりません: ${filePath}`);
    }
    const bytesPerSec = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
    const durationSec = bytesPerSec > 0 ? dataSize / bytesPerSec : 0;
    return { durationSec, sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, bitsPerSample: fmt.bitsPerSample };
}
