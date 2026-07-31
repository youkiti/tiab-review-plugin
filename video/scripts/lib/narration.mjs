// ナレーション原稿・字幕ソース（video/narration/NN-slug.md, video/subtitles/NN-slug.md）の
// パーサ。フォーマットは以下の通り（シンプルな独自形式のため外部 YAML ライブラリは使わない）。
//
//   ---
//   scene: "01"
//   slug: intro
//   title: イントロ（ツール概要）
//   target_seconds: 30
//   ---
//
//   ## cue 01
//   <!-- action: 画面操作の補足（TTS対象外） -->
//   実際にナレーションとして読み上げる本文。
//   複数行は半角スペースで連結して1つの発話にする。
//
//   ## cue 02
//   ...

import { readFileSync } from 'node:fs';

/** HTML コメント <!-- ... --> を取り除く（複数行コメントにも対応） */
export function stripHtmlComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 先頭の `---\n...\n---` フロントマターを解析する。
 * `key: value` / `key: "value"` の単純な1行形式のみサポートする。
 * 戻り値: { frontmatter: Record<string,string>, body: string }
 */
export function parseFrontmatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: raw };
    }
    const [, fmBlock, body] = match;
    const frontmatter = {};
    for (const line of fmBlock.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        let [, key, value] = m;
        value = value.trim();
        // ダブルクォートで囲まれた値はクォートを外す（"01" のような数値風文字列を
        // 文字列として保持したい frontmatter 向け）
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        frontmatter[key] = value;
    }
    return { frontmatter, body };
}

/**
 * 本文から `## cue NN` ブロックを抽出する。各ブロックの本文は
 * HTML コメントを除去したうえで、行を半角スペースで連結して1つのテキストにする。
 * 戻り値: [{ n: '01', text: string }]
 */
export function parseCueBlocks(body) {
    const cues = [];
    const blocks = body.split(/^##\s*cue\s+(\d+)\s*$/m);
    // split の結果は [前置き, "01", ブロック本文, "02", ブロック本文, ...] という形になる
    for (let i = 1; i < blocks.length; i += 2) {
        const n = blocks[i];
        const blockBody = blocks[i + 1] || '';
        const withoutComments = stripHtmlComments(blockBody);
        const text = withoutComments
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(' ');
        if (text.length > 0) {
            cues.push({ n, text });
        }
    }
    return cues;
}

/**
 * ナレーション原稿ファイル（video/narration/NN-slug.md）を読み込んで構造化する。
 * 戻り値: { scene, slug, title, targetSeconds, cues: [{n, text}] }
 */
export function parseNarrationFile(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const cues = parseCueBlocks(body);
    return {
        scene: frontmatter.scene,
        slug: frontmatter.slug,
        title: frontmatter.title,
        targetSeconds: frontmatter.target_seconds ? Number(frontmatter.target_seconds) : undefined,
        cues,
    };
}

/**
 * 英語字幕ソース（video/subtitles/NN-slug.md）を読み込んで構造化する。
 * ナレーション原稿と同じ `## cue NN` 形式を使うが frontmatter に title は無い場合がある。
 * 戻り値: { scene, slug, cues: [{n, text}] }
 */
export function parseSubtitleFile(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const cues = parseCueBlocks(body);
    return {
        scene: frontmatter.scene,
        slug: frontmatter.slug,
        cues,
    };
}
