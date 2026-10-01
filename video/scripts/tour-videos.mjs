#!/usr/bin/env node
// 操作ツアーの解説動画（ツアー1本につき1本の短い動画）を作る。
//
// 使い方（収録は拡張機能をヘッド付きで動かすので xvfb-run 経由で実行する）:
//   npm run build:demo
//   LANGUAGE=ja xvfb-run -a -s "-screen 0 1920x1080x24" npm run video:tours
//   LANGUAGE=ja xvfb-run -a -s "-screen 0 1920x1080x24" npm run video:tours -- join-project ml-start
//   npm run video:tours -- --skip-capture join-project   # 撮り直さず、既存のスクリーンショットから作り直す
//
// 引数を省略すると、参加者向けのツアー（DEFAULT_TOURS）を作る。
//
// 手書きのシーン（video/scenes/）と違い、映像も原稿もツアーそのものから作る:
//   映像  scripts/guide-tour-check のシナリオがデモビルドの上でツアーを最後まで操作し、手順ごとに残す
//         スクリーンショット（.tmp/guide-tour-check/<ツアーID>-<連番>-<手順ID>.png）。手順ごとに最初の1枚を使う
//   原稿  ツアーの定義（src/lib/guide/tours/<ツアーID>.ts）の手順の順番と、ja の messages.json のカードの文言
// ツアーの手順や文言を変えたら、この動画も作り直せば追従する（check:tours が落ちれば撮り直しが要る合図）。
// シナリオで通らなかった手順（skipIf で飛ばされる分岐など）は、スクリーンショットが無いので動画にも入れない。
//
// 1手順 = 1画面（左にスクリーンショット、右に手順の文言）で、ナレーションの長さだけ表示する。
// 画面は Playwright で HTML を描いて PNG にし、ffmpeg で音声と合わせて手順ごとに MP4 にしてからつなぐ。
// 出力: video/build/tours/<ツアーID>.mp4（と字幕 <ツアーID>.srt）。途中のファイルは video/build/tours/<ツアーID>/ に残す。
// ナレーションは VOICEVOX（config.mjs の VOICEVOX_URL / VOICEVOX_SPEAKER）。同じ文言・話者の音声は作り直さない。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    REPO_ROOT, BUILD_DIR, VIDEO_WIDTH, VIDEO_HEIGHT, FPS,
    VOICEVOX_URL, VOICEVOX_SPEAKER, resolveChromiumExecutable,
} from './config.mjs';
import { ffmpeg } from './lib/ffmpeg.mjs';
import { readWavInfo } from './lib/wav.mjs';

/** 引数を省略したときに作るツアー（アサインされた参加者が最初に見るもの） */
const DEFAULT_TOURS = ['join-project', 'fulltext-page', 'ml-start'];

const TOURS_SRC_DIR = path.join(REPO_ROOT, 'src', 'lib', 'guide', 'tours');
const MESSAGES_JA = path.join(REPO_ROOT, 'src', '_locales', 'ja', 'messages.json');
const SHOTS_DIR = path.join(REPO_ROOT, '.tmp', 'guide-tour-check');
const TOUR_CHECK = path.join(REPO_ROOT, 'scripts', 'guide-tour-check', 'run.mjs');
const OUT_DIR = path.join(BUILD_DIR, 'tours');

/** 発声の前後に置く無音（秒）。画面が切り替わった直後に喋り出さないため */
const LEAD_IN_SEC = 0.5;
const TAIL_SEC = 0.9;

/**
 * VOICEVOX が英字をうまく読めない語の読み替え（字幕の文言はそのまま、音声だけ置き換える）。
 * 長いものから順に当てる。ツアーの文言に新しい英字が出てきたら、ここに足す。
 */
const READINGS = [
    ['i / m / e キー', 'アイ、エム、イーのキー'],
    ['i / e キー', 'アイ、イーのキー'],
    ['c キー', 'シーのキー'],
    ['(i)', '（アイ）'], ['(e)', '（イー）'], ['(m)', '（エム）'], ['(u)', '（ユー）'],
    ['「?」', '「はてな」ボタン'], ['❓', 'はてなボタン'],
    ['→', 'から'],
    ['Remaining', 'リメイニング'], ['Include', 'インクルード'], ['Exclude', 'エクスクルード'],
    ['Google', 'グーグル'], ['Blind', 'ブラインド'], ['Ready', 'レディ'], ['Enter', 'エンター'],
    ['TiAb', 'タイアブ'], ['URL', 'ユーアールエル'], ['PDF', 'ピーディーエフ'], ['DOI', 'ディーオーアイ'],
    ['ML', 'エムエル'], ['AI', 'エーアイ'],
];

export function toReading(text) {
    let out = text;
    for (const [from, to] of READINGS) out = out.split(from).join(to);
    return out;
}

/** ツアーの定義ファイルから、i18n キーの共通部分と手順 ID（定義順）を読む。TypeScript は実行せず文字列から取る */
export function readTourDefinition(tourId) {
    const file = path.join(TOURS_SRC_DIR, `${tourId}.ts`);
    if (!existsSync(file)) throw new Error(`ツアーの定義がありません: ${path.relative(REPO_ROOT, file)}`);
    const src = readFileSync(file, 'utf8');
    const prefix = src.match(/tourKeyBase\('([A-Za-z_]+)'/)?.[1];
    if (!prefix) throw new Error(`${tourId}: tourKeyBase(...) の接頭辞を読めません`);
    const stepsAt = src.indexOf('steps:');
    if (stepsAt < 0) throw new Error(`${tourId}: steps が見つかりません`);
    // 手順のオブジェクトは steps: [ の直下（インデント12）に並ぶ。advance などの入れ子の id は拾わない
    const stepIds = [...src.slice(stepsAt).matchAll(/^ {12}id: '([a-z0-9-]+)'/gm)].map((m) => m[1]);
    if (stepIds.length === 0) throw new Error(`${tourId}: 手順の id を読めません`);
    return { base: `${prefix}${tourId.replace(/-/g, '_')}`, stepIds };
}

/** 手順ごとに最初のスクリーンショットを選ぶ。*-placement（配置の確認用）は除く */
export function pickShots(tourId, stepIds, files) {
    const re = new RegExp(`^${tourId}-(\\d+)-(.+)\\.png$`);
    const shots = files
        .map((f) => f.match(re))
        .filter(Boolean)
        .map((m) => ({ seq: Number(m[1]), label: m[2], file: m[0] }))
        .sort((a, b) => a.seq - b.seq);
    const picked = new Map();
    for (const s of shots) {
        if (stepIds.includes(s.label) && !picked.has(s.label)) picked.set(s.label, s.file);
    }
    return stepIds.filter((id) => picked.has(id)).map((id) => ({ stepId: id, file: picked.get(id) }));
}

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** PNG の幅と高さ（IHDR チャンク）を読む */
export function pngSize(buf) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 1画面ぶんの HTML。縦長のスクリーンショット（サイドパネル）は左に画面・右に文言、
 * 横長（全文の判定ページなど）は上に画面・下に文言にする（横長を左右に並べると文言の幅が潰れるため）。
 */
function frameHtml({ title, text, shotPath }) {
    const buf = shotPath ? readFileSync(shotPath) : null;
    const layout = !buf ? 'intro' : (pngSize(buf).width > pngSize(buf).height ? 'wide' : 'tall');
    const img = buf ? `<div class="shot"><img src="data:image/png;base64,${buf.toString('base64')}"></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;width:${VIDEO_WIDTH}px;height:${VIDEO_HEIGHT}px;background:#eef2f6;
            font-family:'Noto Sans CJK JP','IPAPGothic','IPA Pゴシック','IPAGothic','WenQuanYi Zen Hei',sans-serif;color:#1f2937}
        .wrap{display:flex;align-items:center;gap:72px;height:100%;padding:0 120px;box-sizing:border-box}
        .shot{flex:none;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(15,23,42,.18);overflow:hidden}
        .shot img{display:block;height:${VIDEO_HEIGHT - 80}px}
        .side{flex:1;min-width:0}
        .title{font-size:34px;color:#2563eb;font-weight:bold;margin-bottom:32px}
        .text{font-size:46px;line-height:1.65;white-space:pre-wrap}
        .intro .text{font-size:40px}
        .wide{flex-direction:column;justify-content:flex-start;gap:28px;padding:36px 120px}
        .wide .shot img{height:auto;max-height:700px;max-width:${VIDEO_WIDTH - 240}px}
        .wide .side{width:100%}
        .wide .title{font-size:28px;margin-bottom:12px}
        .wide .text{font-size:34px;line-height:1.55}
        .intro .title{font-size:72px;color:#111827;margin-bottom:36px}
        .brand{font-size:28px;color:#64748b;margin-bottom:20px}
    </style></head><body><div class="wrap ${layout}">${img}<div class="side">
        ${shotPath ? '' : '<div class="brand">TiAb Review Plugin ・ 操作ツアー</div>'}
        <div class="title">${escapeHtml(title)}</div>
        <div class="text">${escapeHtml(text)}</div>
    </div></div></body></html>`;
}

async function synthesize(text) {
    const q = await fetch(`${VOICEVOX_URL}/audio_query?speaker=${VOICEVOX_SPEAKER}&text=${encodeURIComponent(text)}`, { method: 'POST' });
    if (!q.ok) throw new Error(`VOICEVOX /audio_query に失敗しました (${q.status})。エンジンが起動しているか確認してください: ${VOICEVOX_URL}`);
    const s = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${VOICEVOX_SPEAKER}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await q.json()),
    });
    if (!s.ok) throw new Error(`VOICEVOX /synthesis に失敗しました (${s.status})`);
    return Buffer.from(await s.arrayBuffer());
}

function srtTime(sec) {
    const ms = Math.round(sec * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function capture(tourId) {
    console.log(`[${tourId}] ツアーを通して手順ごとのスクリーンショットを撮ります...`);
    const res = spawnSync(process.execPath, [TOUR_CHECK, '--only', tourId, '--lang', 'ja'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: { ...process.env, PLAYWRIGHT_CHROMIUM_PATH: process.env.PLAYWRIGHT_CHROMIUM_PATH || resolveChromiumExecutable() || '' },
    });
    if (res.status !== 0) {
        throw new Error(`[${tourId}] ツアーの通し実行が失敗しました。npm run build:demo 済みか、xvfb-run 経由か、LANGUAGE=ja かを確認してください。\n${(res.stdout + res.stderr).slice(-3000)}`);
    }
}

async function buildTour(tourId, browser, messages) {
    const { base, stepIds } = readTourDefinition(tourId);
    const msg = (key) => {
        const m = messages[key]?.message;
        if (!m) throw new Error(`${tourId}: 文言がありません: ${key}`);
        return m;
    };
    const shots = pickShots(tourId, stepIds, existsSync(SHOTS_DIR) ? readdirSync(SHOTS_DIR) : []);
    if (shots.length === 0) throw new Error(`${tourId}: 手順のスクリーンショットがありません（${path.relative(REPO_ROOT, SHOTS_DIR)}）`);

    const title = msg(`${base}_title`);
    // 手順番号は画面右側に出さない。カードの「n / m」（飛ばされない手順だけで数える）と食い違って紛らわしいため
    const cues = [{ key: 'intro', title, text: msg(`${base}_desc`), shot: null }];
    shots.forEach((s, i) => cues.push({
        key: `${String(i + 1).padStart(2, '0')}-${s.stepId}`,
        title,
        text: msg(`${base}_${s.stepId.replace(/-/g, '_')}`),
        shot: path.join(SHOTS_DIR, s.file),
    }));
    const skipped = stepIds.filter((id) => !shots.some((s) => s.stepId === id));
    if (skipped.length) console.log(`[${tourId}] シナリオで通らなかった手順は入れません: ${skipped.join(', ')}`);

    const workDir = path.join(OUT_DIR, tourId);
    mkdirSync(workDir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } });
    const segments = [];
    const srt = [];
    let clock = 0;
    for (const [i, cue] of cues.entries()) {
        const spoken = toReading(cue.key === 'intro' ? `${cue.title}。${cue.text}` : cue.text);
        const hash = createHash('sha256').update(`${VOICEVOX_SPEAKER}|${spoken}`).digest('hex').slice(0, 16);
        const wav = path.join(workDir, `${cue.key}-${hash}.wav`);
        if (!existsSync(wav)) {
            console.log(`[${tourId}] 音声 ${cue.key} を合成中...`);
            writeFileSync(wav, await synthesize(spoken));
        }
        const { durationSec } = readWavInfo(wav);
        const dur = LEAD_IN_SEC + durationSec + TAIL_SEC;

        const frame = path.join(workDir, `${cue.key}.png`);
        await page.setContent(frameHtml({ title: cue.title, text: cue.text, shotPath: cue.shot }));
        await page.screenshot({ path: frame });

        const seg = path.join(workDir, `seg-${String(i).padStart(2, '0')}.mp4`);
        const delayMs = Math.round(LEAD_IN_SEC * 1000);
        await ffmpeg([
            '-loop', '1', '-framerate', String(FPS), '-i', frame, '-i', wav,
            '-filter_complex', `[1:a]adelay=${delayMs}|${delayMs},apad[a]`,
            '-map', '0:v', '-map', '[a]', '-t', dur.toFixed(3),
            '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(FPS),
            '-c:a', 'aac', '-ar', '48000', '-ac', '2', seg,
        ]);
        segments.push(seg);
        srt.push(`${i + 1}\n${srtTime(clock + LEAD_IN_SEC)} --> ${srtTime(clock + LEAD_IN_SEC + durationSec)}\n${cue.key === 'intro' ? `${cue.title}\n${cue.text}` : cue.text}\n`);
        clock += dur;
    }
    await page.close();

    const list = path.join(workDir, 'segments.txt');
    writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = path.join(OUT_DIR, `${tourId}.mp4`);
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    writeFileSync(path.join(OUT_DIR, `${tourId}.srt`), srt.join('\n'));
    console.log(`[${tourId}] 完了: ${path.relative(REPO_ROOT, out)}（${shots.length} 手順・約 ${Math.round(clock)} 秒）`);
}

async function main() {
    const args = process.argv.slice(2);
    const skipCapture = args.includes('--skip-capture');
    const tourIds = args.filter((a) => !a.startsWith('--'));
    const targets = tourIds.length ? tourIds : DEFAULT_TOURS;

    const v = await fetch(`${VOICEVOX_URL}/version`).catch(() => null);
    if (!v?.ok) throw new Error(`VOICEVOX エンジンに接続できません: ${VOICEVOX_URL}（npm run video:setup で起動できます）`);

    mkdirSync(OUT_DIR, { recursive: true });
    const messages = JSON.parse(readFileSync(MESSAGES_JA, 'utf8'));
    const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
    try {
        for (const id of targets) {
            readTourDefinition(id); // 撮る前に、存在しない ID を弾く
            if (!skipCapture) capture(id);
            await buildTour(id, browser, messages);
        }
    } finally {
        await browser.close();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err.message || err);
        process.exitCode = 1;
    });
}
