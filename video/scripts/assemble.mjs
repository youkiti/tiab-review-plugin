#!/usr/bin/env node
// 合成スクリプト
//
// 使い方:
//   node video/scripts/assemble.mjs
//
// video/build/scenes/<NN-slug>/（record.mjs の出力）と video/build/audio/<key>/
// （tts.mjs の出力）を突き合わせて、以下を生成する。
//   video/build/scenes/<NN-slug>.mp4   シーンごとの完成動画（映像+ナレーション音声）
//   video/build/final.mp4              全シーンを結合した最終動画
//   video/build/chapters.txt           YouTube 説明欄用チャプタータイムスタンプ
//   video/build/timeline.json          シーンごとの尺・キュー配置の記録
//   video/build/subtitles-en.srt       英語字幕（video/subtitles/ から生成）
//   video/build/description.txt        YouTube 説明欄用テキスト
//   video/build/thumbnail.png          サムネイル（video/assets/thumbnail.html を撮影）

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import {
    REPO_ROOT,
    BUILD_DIR,
    BUILD_SCENES_DIR,
    BUILD_AUDIO_DIR,
    NARRATION_DIR,
    SUBTITLES_DIR,
    ASSETS_DIR,
    VIDEO_WIDTH,
    VIDEO_HEIGHT,
    FPS,
    THUMBNAIL_WIDTH,
    THUMBNAIL_HEIGHT,
    MIN_CUE_GAP_SEC,
    resolveChromiumExecutable,
} from './config.mjs';
import { ffmpeg, ffprobeDuration } from './lib/ffmpeg.mjs';
import { parseNarrationFile, parseSubtitleFile } from './lib/narration.mjs';

// ============================================================================
// シーン一覧の読み込み
// ============================================================================

/** video/build/scenes/ 配下の <NN-slug>/meta.json をシーン番号順に列挙する */
function listBuiltScenes() {
    if (!existsSync(BUILD_SCENES_DIR)) return [];
    return readdirSync(BUILD_SCENES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => existsSync(path.join(BUILD_SCENES_DIR, name, 'meta.json')))
        .sort((a, b) => a.localeCompare(b, 'en'))
        .map((name) => {
            const meta = JSON.parse(readFileSync(path.join(BUILD_SCENES_DIR, name, 'meta.json'), 'utf8'));
            return { key: name, dir: path.join(BUILD_SCENES_DIR, name), meta };
        });
}

/** シーンのチャプタータイトルを決める。narration frontmatter の title を優先し、
 *  無ければ record.mjs が書き出したシーン自身の title にフォールバックする。 */
function resolveSceneTitle(meta) {
    if (meta.narrationKey) {
        const narrationPath = path.join(NARRATION_DIR, `${meta.narrationKey}.md`);
        if (existsSync(narrationPath)) {
            const narration = parseNarrationFile(narrationPath);
            if (narration.title) return narration.title;
        }
    }
    return meta.title || meta.slug;
}

// ============================================================================
// 映像処理（セグメント結合・パディング）
// ============================================================================

/**
 * 複数の segment-K.webm を1本の映像（音声無し）に結合し、統一フォーマットへ再エンコードする。
 * Playwright は新しいタブへ録画対象が切り替わった後も元ページの録画を（コンテキストが
 * 閉じるまで）続けるため、非最終セグメントをそのまま結合すると「次のセグメント開始以降の
 * 操作していない待機画面」が動画に挟まってしまう。これを避けるため、各非最終セグメントは
 * activeDurations（次セグメント開始までの実時間）でトリムして結合する。
 */
async function concatSegments(meta, sceneDir, outPath, activeDurations) {
    const inputs = [];
    const filterParts = [];
    const labels = [];
    meta.segments.forEach((seg, i) => {
        inputs.push('-i', path.join(sceneDir, seg.file));
        const isLast = i === meta.segments.length - 1;
        const trim = isLast ? '' : `trim=duration=${activeDurations[i].toFixed(3)},setpts=PTS-STARTPTS,`;
        filterParts.push(
            `[${i}:v]${trim}scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=disable,setsar=1,fps=${FPS}[v${i}]`,
        );
        labels.push(`[v${i}]`);
    });
    const filterComplex = `${filterParts.join(';')};${labels.join('')}concat=n=${meta.segments.length}:v=1:a=0[vout]`;
    await ffmpeg([
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        outPath,
    ]);
    return ffprobeDuration(outPath);
}

/** 映像を tpad（最終フレーム複製）で targetDuration まで伸ばす。伸ばす必要が無ければ何もしない */
async function padVideoIfNeeded(videoPath, currentDuration, targetDuration, outPath) {
    const extra = targetDuration - currentDuration;
    if (extra <= 0.01) {
        return { path: videoPath, duration: currentDuration };
    }
    await ffmpeg([
        '-i', videoPath,
        '-vf', `tpad=stop_mode=clone:stop_duration=${extra.toFixed(3)}`,
        '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        outPath,
    ]);
    return { path: outPath, duration: targetDuration };
}

// ============================================================================
// 音声処理（キュー配置・ナレーショントラック生成）
// ============================================================================

/**
 * meta.cues（収録時のキュー打刻）と audio index（TTS結果）を突き合わせ、
 * 「前のキュー音声の終わりから最低 MIN_CUE_GAP_SEC 空ける」ルールで配置を決める。
 * 戻り値: [{ n, cueTime, start, end, file, text }]（start昇順）
 */
function placeCues(meta, audioIndex) {
    if (!audioIndex) return [];
    const audioByN = new Map(audioIndex.cues.map((c) => [c.n, c]));
    // meta.cues には呼び出し側（processScene）で absTime（結合後映像内の絶対秒数）が
    // 付与済み。segment/tRel 順に並べておけば絶対時刻も自然に昇順になる。
    const sorted = [...meta.cues].sort((a, b) => {
        if (a.segment !== b.segment) return a.segment - b.segment;
        return a.tRel - b.tRel;
    });
    const placements = [];
    let prevEnd = 0;
    for (const cueMark of sorted) {
        const audioCue = audioByN.get(cueMark.n);
        if (!audioCue) {
            console.warn(`  警告: cue ${cueMark.n} に対応する音声が見つかりません（TTS未実行/原稿不一致の可能性）`);
            continue;
        }
        const cueTime = cueMark.absTime;
        const start = Math.max(cueTime, prevEnd + MIN_CUE_GAP_SEC);
        const end = start + audioCue.durationSec;
        placements.push({
            n: cueMark.n,
            cueTime,
            start,
            end,
            file: path.join(BUILD_AUDIO_DIR, meta.narrationKey, audioCue.file),
            text: audioCue.text,
        });
        prevEnd = end;
    }
    return placements;
}

/** ナレーション音声トラック（wav）を adelay + amix で組み立てる。cue が無ければ null */
async function buildNarrationTrack(placements, outPath) {
    if (placements.length === 0) return null;
    const inputs = [];
    const filterParts = [];
    const labels = [];
    placements.forEach((p, i) => {
        inputs.push('-i', p.file);
        const delayMs = Math.round(p.start * 1000);
        filterParts.push(`[${i}:a]adelay=delays=${delayMs}:all=1[a${i}]`);
        labels.push(`[a${i}]`);
    });
    // amix は2入力以上が前提のため、cue が1件だけのときは adelay の出力をそのまま
    // 最終ラベル [aout] として使う
    const filterComplex = placements.length === 1
        ? filterParts.join(';').replace('[a0]', '[aout]')
        : `${filterParts.join(';')};${labels.join('')}amix=inputs=${placements.length}:duration=longest:dropout_transition=0:normalize=0[aout]`;
    await ffmpeg([
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[aout]',
        '-c:a', 'pcm_s16le',
        outPath,
    ]);
    return outPath;
}

/** 映像+ナレーション音声（無ければ無音）を最終的な1シーン分の mp4 にまとめる */
async function muxScene(videoPath, narrationWavPath, videoDuration, outPath) {
    if (narrationWavPath) {
        await ffmpeg([
            '-i', videoPath,
            '-i', narrationWavPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
            outPath,
        ]);
    } else {
        // ナレーションが無いシーン（映像のみ）: 動画尺ぶんの無音トラックを付与する。
        // 他シーンと結合するとき concat demuxer が音声有無の混在を扱えないため必須。
        await ffmpeg([
            '-i', videoPath,
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '128k',
            '-shortest',
            outPath,
        ]);
    }
}

// ============================================================================
// シーン1本の処理
// ============================================================================

async function processScene(built, tmpDir) {
    const { key, dir, meta } = built;
    console.log(`\n--- シーン合成: ${key} ---`);

    // 各セグメントの「有効尺」を求める。非最終セグメントは録画ファイルの尺ではなく
    // 「次のセグメントが開始するまでの実時間（wallclock差）」を使う。録画ファイル自体は
    // コンテキストが閉じるまで回り続けており、後半は操作していない待機画面のため
    // （concatSegments のコメント参照）。最終セグメントはファイル尺をそのまま使う。
    const segmentDurations = [];
    for (const seg of meta.segments) {
        segmentDurations.push(await ffprobeDuration(path.join(dir, seg.file)));
    }
    const activeDurations = meta.segments.map((seg, i) => {
        if (i === meta.segments.length - 1) return segmentDurations[i];
        const wallclockGap = (meta.segments[i + 1].t0Wallclock - seg.t0Wallclock) / 1000;
        return Math.min(segmentDurations[i], wallclockGap);
    });
    const segmentOffsets = [];
    let acc = 0;
    for (const d of activeDurations) {
        segmentOffsets.push(acc);
        acc += d;
    }
    const metaWithAbsTime = {
        ...meta,
        cues: meta.cues.map((c) => ({ ...c, absTime: segmentOffsets[c.segment] + c.tRel })),
    };

    const concatPath = path.join(tmpDir, `${key}-concat.mp4`);
    const videoDuration = await concatSegments(meta, dir, concatPath, activeDurations);
    console.log(`  結合映像: ${videoDuration.toFixed(2)}s`);

    let audioIndex = null;
    if (meta.narrationKey) {
        const indexPath = path.join(BUILD_AUDIO_DIR, meta.narrationKey, 'index.json');
        if (existsSync(indexPath)) {
            audioIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
        } else {
            console.warn(`  警告: 音声インデックスが見つかりません（tts.mjs 未実行）: ${indexPath}`);
        }
    }

    const placements = placeCues(metaWithAbsTime, audioIndex);
    const narrationEnd = placements.length > 0 ? placements[placements.length - 1].end : 0;

    let narrationWavPath = null;
    if (placements.length > 0) {
        narrationWavPath = path.join(tmpDir, `${key}-narration.wav`);
        await buildNarrationTrack(placements, narrationWavPath);
    }

    const { path: finalVideoPath, duration: finalDuration } = await padVideoIfNeeded(
        concatPath,
        videoDuration,
        narrationEnd,
        path.join(tmpDir, `${key}-padded.mp4`),
    );

    const outPath = path.join(BUILD_SCENES_DIR, `${key}.mp4`);
    await muxScene(finalVideoPath, narrationWavPath, finalDuration, outPath);
    const sceneDuration = await ffprobeDuration(outPath);

    console.log(`  完成: ${outPath}（${sceneDuration.toFixed(2)}s、cue ${placements.length}件）`);

    return {
        id: meta.sceneId,
        slug: meta.slug,
        key,
        narrationKey: meta.narrationKey,
        title: resolveSceneTitle(meta),
        file: outPath,
        duration: sceneDuration,
        cues: placements.map((p) => ({ n: p.n, start: p.start, end: p.end })),
    };
}

// ============================================================================
// タイムライン系出力（chapters.txt / timeline.json / subtitles-en.srt / description.txt）
// ============================================================================

function formatChapterTime(sec) {
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function buildChapters(sceneResults) {
    let offset = 0;
    const lines = [];
    for (const scene of sceneResults) {
        lines.push(`${formatChapterTime(offset)} ${scene.title}`);
        offset += scene.duration;
    }
    return lines.join('\n') + '\n';
}

function buildTimeline(sceneResults) {
    let offset = 0;
    const scenes = sceneResults.map((scene) => {
        const entry = {
            sceneId: scene.id,
            slug: scene.slug,
            narrationKey: scene.narrationKey,
            title: scene.title,
            duration: scene.duration,
            offset,
            cues: scene.cues,
        };
        offset += scene.duration;
        return entry;
    });
    return { totalDuration: offset, scenes };
}

/** ~42文字を目安に単語単位で行を折り返す（英語字幕用） */
function wrapText(text, maxLen = 42) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length > maxLen && current) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function formatSrtTime(sec) {
    const clamped = Math.max(0, sec);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = Math.floor(clamped % 60);
    const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    const pad2 = (n) => String(n).padStart(2, '0');
    const pad3 = (n) => String(n).padStart(3, '0');
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

/** 分割後の最終ブロックがこれより短い場合、直前のブロックへ吸収合併する（秒） */
const MIN_LAST_SRT_BLOCK_SEC = 1.0;

/**
 * 1つの cue（英語テキスト + 配置済み絶対時刻 [start,end]）を、1ブロック2行までの
 * SRT ブロック列に変換する。行数が2行を超える場合は時間窓を文字数比で分割し、
 * 連続する複数ブロックにする。
 */
function buildSrtBlocksForCue(text, absStart, absEnd) {
    const lines = wrapText(text, 42);
    const groups = [];
    for (let i = 0; i < lines.length; i += 2) {
        groups.push(lines.slice(i, i + 2));
    }
    if (groups.length === 0) return [];
    const totalChars = groups.reduce((sum, g) => sum + g.join(' ').length, 0) || 1;
    const totalDuration = Math.max(0.01, absEnd - absStart);
    let cursor = absStart;
    const blocks = [];
    groups.forEach((group, i) => {
        const isLast = i === groups.length - 1;
        const chars = group.join(' ').length;
        const share = isLast ? (absEnd - cursor) : (totalDuration * chars) / totalChars;
        const blockStart = cursor;
        const blockEnd = isLast ? absEnd : cursor + share;
        blocks.push({ start: blockStart, end: blockEnd, text: group.join('\n') });
        cursor = blockEnd;
    });

    // 比例配分の結果、最終ブロックが極端に短くなる（一瞬しか表示されず読めない）ことがある。
    // その場合は直前のブロックへ吸収し、時間幅・テキストの両方を統合する。
    if (blocks.length >= 2) {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock.end - lastBlock.start < MIN_LAST_SRT_BLOCK_SEC) {
            const prevBlock = blocks[blocks.length - 2];
            prevBlock.end = lastBlock.end;
            prevBlock.text = `${prevBlock.text}\n${lastBlock.text}`;
            blocks.pop();
        }
    }

    return blocks;
}

function buildSubtitles(timeline) {
    let index = 1;
    const srtParts = [];
    for (const scene of timeline.scenes) {
        if (!scene.narrationKey) continue; // ナレーション無し（映像のみ）シーンは字幕も無し
        // subtitles/ は narration と同じキー（NN-slug）で対応するファイルを持つ
        const candidate = path.join(SUBTITLES_DIR, `${scene.narrationKey}.md`);
        if (!existsSync(candidate)) {
            console.warn(`  警告: 字幕ソースが見つかりません（スキップ）: ${candidate}`);
            continue;
        }
        const subtitle = parseSubtitleFile(candidate);
        const subtitleByN = new Map(subtitle.cues.map((c) => [c.n, c.text]));
        for (const cue of scene.cues) {
            const text = subtitleByN.get(cue.n);
            if (!text) continue;
            const absStart = scene.offset + cue.start;
            const absEnd = scene.offset + cue.end;
            for (const block of buildSrtBlocksForCue(text, absStart, absEnd)) {
                srtParts.push(
                    `${index}\n${formatSrtTime(block.start)} --> ${formatSrtTime(block.end)}\n${block.text}\n`,
                );
                index += 1;
            }
        }
    }
    return srtParts.join('\n');
}

function buildDescription(chaptersText, version) {
    return [
        'TiAb Review Plugin の操作解説動画です。',
        'システマティックレビューの文献スクリーニングを効率化する Chrome 拡張機能の使い方を、',
        'ログインから、タイトル・抄録スクリーニング、機械学習・AIによる支援、フルテキスト評価、',
        'チームでの共有まで、ひととおり解説します。',
        '',
        'ヘルプ: https://youkiti.github.io/tiab-review-plugin/help.html',
        'Web版: https://youkiti.github.io/tiab-review-plugin/app/',
        'GitHub: https://github.com/youkiti/tiab-review-plugin',
        'Chrome Web Store: [ストアURLを記入]',
        '',
        '【チャプター】',
        chaptersText.trim(),
        '',
        `ナレーション: VOICEVOX:四国めたん`,
        'English subtitles available (CC)',
        '',
        `TiAb Review Plugin v${version}`,
    ].join('\n') + '\n';
}

// ============================================================================
// サムネイル生成
// ============================================================================

async function buildThumbnail(version) {
    const htmlPath = path.join(ASSETS_DIR, 'thumbnail.html');
    if (!existsSync(htmlPath)) {
        console.warn(`  警告: サムネイルテンプレートが見つかりません（スキップ）: ${htmlPath}`);
        return;
    }
    const executablePath = resolveChromiumExecutable();
    const launchOptions = { headless: true };
    if (executablePath) launchOptions.executablePath = executablePath;
    const browser = await chromium.launch(launchOptions);
    try {
        const page = await browser.newPage({ viewport: { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT } });
        await page.goto(`file://${htmlPath}?version=${encodeURIComponent(version)}`);
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(BUILD_DIR, 'thumbnail.png') });
        console.log(`  サムネイル生成: ${path.join(BUILD_DIR, 'thumbnail.png')}`);
    } finally {
        await browser.close();
    }
}

// ============================================================================
// 全シーン結合（final.mp4）
// ============================================================================

async function concatScenes(sceneResults, tmpDir) {
    const listPath = path.join(tmpDir, 'final-list.txt');
    const listContent = sceneResults
        .map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`)
        .join('\n');
    writeFileSync(listPath, listContent);
    const outPath = path.join(BUILD_DIR, 'final.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    return outPath;
}

// ============================================================================
// メイン
// ============================================================================

async function main() {
    const built = listBuiltScenes();
    if (built.length === 0) {
        throw new Error(`video/build/scenes/ にシーンがありません。先に record.mjs を実行してください: ${BUILD_SCENES_DIR}`);
    }
    mkdirSync(BUILD_DIR, { recursive: true });
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tiab-video-assemble-'));

    try {
        const sceneResults = [];
        for (const b of built) {
            sceneResults.push(await processScene(b, tmpDir));
        }

        console.log('\n--- 全シーン結合 ---');
        const finalPath = await concatScenes(sceneResults, tmpDir);
        console.log(`最終動画: ${finalPath}`);

        const chaptersText = buildChapters(sceneResults);
        writeFileSync(path.join(BUILD_DIR, 'chapters.txt'), chaptersText);

        const timeline = buildTimeline(sceneResults);
        writeFileSync(path.join(BUILD_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

        const srt = buildSubtitles(timeline);
        writeFileSync(path.join(BUILD_DIR, 'subtitles-en.srt'), srt);

        const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        writeFileSync(path.join(BUILD_DIR, 'description.txt'), buildDescription(chaptersText, pkg.version));

        await buildThumbnail(pkg.version);

        console.log('\n合成完了。生成物一覧:');
        for (const f of ['final.mp4', 'chapters.txt', 'timeline.json', 'subtitles-en.srt', 'description.txt', 'thumbnail.png']) {
            console.log(`  video/build/${f}`);
        }
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('合成に失敗しました:', err);
    process.exit(1);
});
