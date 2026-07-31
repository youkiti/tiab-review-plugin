#!/usr/bin/env node
// TTS（音声合成）スクリプト
//
// 使い方:
//   node video/scripts/tts.mjs                      # video/narration/ 配下の全原稿を合成
//   node video/scripts/tts.mjs 01-intro 03-tiab-screening   # 指定原稿のみ
//
// video/narration/NN-slug.md を読み込み、VOICEVOX エンジン（config.mjs の VOICEVOX_URL /
// VOICEVOX_SPEAKER）で cue ごとに音声を合成し、以下へ書き出す。
//   video/build/audio/NN-slug/cue-NN.wav
//   video/build/audio/NN-slug/index.json  { speaker, cues: [{n, file, durationSec, text, hash}] }
//
// 再実行時は index.json に保存したハッシュ（本文+話者ID）と比較し、変化の無い cue は
// 合成をスキップする（原稿の一部だけ手直ししたときに全キューを再生成しないため）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { NARRATION_DIR, BUILD_AUDIO_DIR, VOICEVOX_URL, VOICEVOX_SPEAKER } from './config.mjs';
import { parseNarrationFile } from './lib/narration.mjs';
import { readWavInfo } from './lib/wav.mjs';

function hashCue(text, speaker) {
    return createHash('sha256').update(`${speaker}|${text}`).digest('hex');
}

/** video/narration/ 配下の *.md をシーン番号順に列挙する（拡張子・パスなしの基本名の配列） */
function listNarrationKeys() {
    if (!existsSync(NARRATION_DIR)) return [];
    return readdirSync(NARRATION_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.basename(f, '.md'))
        .sort((a, b) => a.localeCompare(b, 'en'));
}

function filterNarrationKeys(allKeys, args) {
    if (args.length === 0) return allKeys;
    const selected = [];
    for (const arg of args) {
        const match = allKeys.find((k) => k === arg || k.startsWith(`${arg}-`));
        if (!match) {
            throw new Error(`指定されたナレーション原稿が見つかりません: ${arg}（video/narration/ 配下を確認してください）`);
        }
        if (!selected.includes(match)) selected.push(match);
    }
    return selected;
}

async function synthesizeCue(text, speaker) {
    const queryUrl = `${VOICEVOX_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`;
    const queryRes = await fetch(queryUrl, { method: 'POST' });
    if (!queryRes.ok) {
        throw new Error(`/audio_query に失敗しました (${queryRes.status}): ${await queryRes.text()}`);
    }
    const audioQuery = await queryRes.json();

    const synthUrl = `${VOICEVOX_URL}/synthesis?speaker=${speaker}`;
    const synthRes = await fetch(synthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audioQuery),
    });
    if (!synthRes.ok) {
        throw new Error(`/synthesis に失敗しました (${synthRes.status}): ${await synthRes.text()}`);
    }
    const arrayBuffer = await synthRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

async function processNarration(key) {
    const filePath = path.join(NARRATION_DIR, `${key}.md`);
    const narration = parseNarrationFile(filePath);
    if (narration.cues.length === 0) {
        console.log(`[${key}] cue が見つからないためスキップします`);
        return;
    }

    const outDir = path.join(BUILD_AUDIO_DIR, key);
    mkdirSync(outDir, { recursive: true });
    const indexPath = path.join(outDir, 'index.json');
    let prevIndex = { cues: [] };
    if (existsSync(indexPath)) {
        try {
            prevIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
        } catch {
            prevIndex = { cues: [] };
        }
    }
    const prevByN = new Map((prevIndex.cues || []).map((c) => [c.n, c]));

    const resultCues = [];
    let synthesized = 0;
    let skipped = 0;
    for (const { n, text } of narration.cues) {
        const hash = hashCue(text, VOICEVOX_SPEAKER);
        const fileName = `cue-${n}.wav`;
        const filePathOut = path.join(outDir, fileName);
        const prev = prevByN.get(n);
        if (prev && prev.hash === hash && prevIndex.speaker === VOICEVOX_SPEAKER && existsSync(filePathOut)) {
            resultCues.push(prev);
            skipped += 1;
            continue;
        }
        console.log(`[${key}] cue ${n} を合成中... (${text.slice(0, 30)}${text.length > 30 ? '…' : ''})`);
        const wavBuffer = await synthesizeCue(text, VOICEVOX_SPEAKER);
        writeFileSync(filePathOut, wavBuffer);
        const { durationSec } = readWavInfo(filePathOut);
        resultCues.push({ n, file: fileName, durationSec, text, hash });
        synthesized += 1;
    }

    writeFileSync(indexPath, JSON.stringify({ speaker: VOICEVOX_SPEAKER, cues: resultCues }, null, 2));
    console.log(`[${key}] 完了: 合成 ${synthesized} 件 / 再利用 ${skipped} 件 -> ${indexPath}`);
}

async function main() {
    const args = process.argv.slice(2);
    const allKeys = listNarrationKeys();
    if (allKeys.length === 0) {
        throw new Error(`video/narration/ に原稿がありません: ${NARRATION_DIR}`);
    }
    const targetKeys = filterNarrationKeys(allKeys, args);

    // VOICEVOX の疎通確認（分かりやすいエラーメッセージのため先にチェックする）
    try {
        const versionRes = await fetch(`${VOICEVOX_URL}/version`);
        if (!versionRes.ok) throw new Error(`status ${versionRes.status}`);
    } catch (err) {
        throw new Error(
            `VOICEVOX エンジン (${VOICEVOX_URL}) に接続できません。起動しているか、環境変数 ` +
            `VOICEVOX_URL を確認してください。（video/scripts/setup.sh 参照）\n詳細: ${err.message || err}`,
        );
    }

    for (const key of targetKeys) {
        await processNarration(key);
    }
    console.log(`\nTTS 完了: ${targetKeys.length} 原稿`);
}

main().catch((err) => {
    console.error('TTS に失敗しました:', err);
    process.exit(1);
});
