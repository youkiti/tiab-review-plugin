#!/usr/bin/env node
// make-multipage-pdf.mjs - 検証用の複数ページPDFを生成する（Issue #156（#150 工程5））
//
// 目的: 表示範囲中心のPDF描画（src/fulltext/pdf-renderer.ts）を、デモ同梱の固定フィクスチャ
// （video/fixtures/demo-paper.pdf、4ページ）より長いPDFで手動検証するため。各ページに
// Helvetica のテキストだけを置いた有効な PDF 1.4 ファイルを、xref テーブルを正しく計算して
// バイト列から直接組み立てる（外部パッケージへの依存なし）。
//
// 使い方:
//   node scripts/bench/make-multipage-pdf.mjs [--pages <n>] [--out <path>]
//
// 既定: --pages 40、--out .tmp/bench/multipage-<n>.pdf
//
// 生成したPDFは検証専用。dist-demo/fixtures/demo-paper.pdf の置き換えはローカルでのみ行い、
// 生成物自体をコミットしないこと（.tmp/ は .gitignore 済み）。差し替えたら
// `npm run build:demo:prod` 済みの dist-demo/ に対して直接ファイルを上書きし、
// scripts/bench/run.mjs 等の計測後は元のフィクスチャへ戻すこと（demo-paper.pdf の
// quote は video/fixtures/demo-paper.pdf の実テキストに依存しているため、置き換えたままだと
// 根拠ジャンプのシナリオが一致せず skipped になる。README 参照）。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.tmp/bench');

function printHelp() {
    console.log(`検証用の複数ページPDF生成（Issue #156（#150 工程5））

使い方:
  node scripts/bench/make-multipage-pdf.mjs [オプション]

オプション:
  --pages <n>   生成するページ数（既定 40）
  --out <path>  出力先ファイルパス（既定 .tmp/bench/multipage-<n>.pdf）
  --help, -h    このヘルプを表示
`);
}

function parseArgs(argv) {
    const options = { pages: 40, out: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            case '--pages': {
                const n = Number(argv[++i]);
                if (!Number.isInteger(n) || n < 1) {
                    throw new Error(`--pages には1以上の整数を指定してください: ${argv[i]}`);
                }
                options.pages = n;
                break;
            }
            case '--out':
                options.out = argv[++i];
                break;
            default:
                throw new Error(`未知のオプション: ${arg}（--help で使い方を表示）`);
        }
    }
    return options;
}

/** PDF文字列リテラル内で特別扱いされる文字（() \）をエスケープする。 */
function escapePdfString(s) {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * N ページの PDF 1.4 バイト列を組み立てる。
 * オブジェクト番号の割り付け:
 *   1        = Catalog
 *   2        = Pages（Kids に全ページを持つ）
 *   3        = Font（Helvetica, Type1）
 *   4..3+N   = 各ページの Page オブジェクト
 *   4+N..3+2N = 各ページの Contents ストリーム
 */
function buildMultipagePdf(pageCount) {
    const PAGE_WIDTH = 612; // Letter, pt
    const PAGE_HEIGHT = 792;

    const fontObjNum = 3;
    const pageObjNum = n => 3 + n; // n: 1始まりページ番号
    const contentObjNum = n => 3 + pageCount + n;
    const totalObjects = 3 + pageCount * 2; // Catalog + Pages + Font + ページ数分の(Page+Content)

    // 各オブジェクトの本文（"n 0 obj\n...\nendobj\n"）を配列で保持し、後でoffsetを計算しながら結合する。
    const objects = new Array(totalObjects + 1); // index 0 は使わない（オブジェクト番号は1始まり）

    objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;

    const kids = Array.from({ length: pageCount }, (_, i) => `${pageObjNum(i + 1)} 0 R`).join(' ');
    objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`;

    objects[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

    for (let n = 1; n <= pageCount; n++) {
        const pObj = pageObjNum(n);
        const cObj = contentObjNum(n);
        objects[pObj] = `${pObj} 0 obj\n` +
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
            `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${cObj} 0 R >>\n` +
            `endobj\n`;

        // ページごとに固有の文字列を含める（quoteマッチのテストにも使えるよう、行ごとに変える）。
        const lines = [
            `TiAb multipage bench fixture - page ${n} of ${pageCount}`,
            `This is a synthetic page generated for manual verification of viewport-centered PDF rendering.`,
            `Page marker: BENCH-PAGE-${n}`,
        ];
        const streamBody = [
            'BT',
            '/F1 18 Tf',
            '72 720 Td',
            `(${escapePdfString(lines[0])}) Tj`,
            '0 -28 Td',
            `(${escapePdfString(lines[1])}) Tj`,
            '0 -28 Td',
            `(${escapePdfString(lines[2])}) Tj`,
            'ET',
        ].join('\n');
        const streamBytes = Buffer.byteLength(streamBody, 'latin1');
        objects[cObj] = `${cObj} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamBody}\nendstream\nendobj\n`;
    }

    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; // バイナリマーカー行（pdf.js等がバイナリ判定に使う慣例）
    const chunks = [Buffer.from(header, 'latin1')];
    const offsets = new Array(totalObjects + 1).fill(0);
    let offset = chunks[0].length;

    for (let i = 1; i <= totalObjects; i++) {
        offsets[i] = offset;
        const buf = Buffer.from(objects[i], 'latin1');
        chunks.push(buf);
        offset += buf.length;
    }

    const xrefStart = offset;
    // xref の各エントリは仕様上20バイト固定（10桁offset + 空白 + 5桁世代 + 空白 + n/f + 空白 + 改行）。
    // 先頭の object 0 は常に空きリストの先頭を指す固定エントリ。
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= totalObjects; i++) {
        xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    chunks.push(Buffer.from(xref, 'latin1'));
    chunks.push(Buffer.from(trailer, 'latin1'));

    return Buffer.concat(chunks);
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const outPath = options.out
        ? path.resolve(REPO_ROOT, options.out)
        : path.join(DEFAULT_OUT_DIR, `multipage-${options.pages}.pdf`);

    mkdirSync(path.dirname(outPath), { recursive: true });
    const pdf = buildMultipagePdf(options.pages);
    writeFileSync(outPath, pdf);
    console.log(`[make-multipage-pdf] ${options.pages}ページのPDFを書き出しました: ${outPath} (${pdf.length} bytes)`);
}

main();
