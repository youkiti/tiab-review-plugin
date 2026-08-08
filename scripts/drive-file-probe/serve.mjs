#!/usr/bin/env node
// Drive File Probe 用ローカル静的サーバ
//
// probe.html / probe.js を http://localhost:8080 で配信する。
// テンプレート置換は一切行わず、素の静的ファイルとしてそのまま返す。
// 代わりに GET /config.json で .env の3値を JSON で返し、probe.js 側は
// fetch('/config.json') でそれを受け取る設計にしている。
//
// ポートは 8080 固定、bind は 127.0.0.1 ではなく localhost 固定とする。
// OAuth クライアントの承認済み JavaScript 生成元と Picker API キーの
// リファラー制限が http://localhost:8080 で登録されているため（AGENTS.md 参照）。
//
// 重要: .env の必須チェックは startServer() 呼び出し時にのみ行い、モジュール読み込み
// 時点では行わない。run.mjs の `--list` は .env が無くても動作する必要があるため、
// serve.mjs を import しただけでは何も検証されないようにしてある。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/drive-file-probe/ の2階層上がリポジトリルート
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

export const PORT = 8080;
export const HOST = 'localhost';

const PROBE_HTML_PATH = path.join(__dirname, 'probe.html');
const PROBE_JS_PATH = path.join(__dirname, 'probe.js');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
};

/**
 * リポジトリルートの .env を読み込み、必須の3変数を検証する。
 * どれか欠けていれば、何を設定すればよいかを含めた日本語メッセージで即座に失敗させる。
 */
function loadConfig() {
    dotenv.config({ path: ENV_PATH });
    const config = {
        WEB_OAUTH_CLIENT_ID: process.env.WEB_OAUTH_CLIENT_ID?.trim(),
        PICKER_API_KEY: process.env.PICKER_API_KEY?.trim(),
        GCP_PROJECT_NUMBER: process.env.GCP_PROJECT_NUMBER?.trim(),
    };
    const missing = Object.entries(config)
        .filter(([, value]) => !value)
        .map(([key]) => key);
    if (missing.length > 0) {
        throw new Error(
            `.env に以下の値が設定されていません: ${missing.join(', ')}\n` +
            `リポジトリルート（${REPO_ROOT}）の .env に次を設定してください:\n` +
            '  WEB_OAUTH_CLIENT_ID  ... Web版用 OAuth クライアントID（種別: ウェブ アプリケーション）\n' +
            '  PICKER_API_KEY       ... Google Picker API キー\n' +
            '  GCP_PROJECT_NUMBER   ... GCP プロジェクト番号\n' +
            '詳細は src/platform/web/auth.ts・.env.example・AGENTS.md の「Web版（ブラウザ版）」節を参照してください。'
        );
    }
    return config;
}

async function serveFile(res, filePath, ext) {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] });
    res.end(body);
}

async function handleRequest(req, res, config) {
    try {
        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Method Not Allowed');
            return;
        }
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (url.pathname === '/config.json') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(config));
            return;
        }
        if (url.pathname === '/' || url.pathname === '/probe.html') {
            await serveFile(res, PROBE_HTML_PATH, '.html');
            return;
        }
        if (url.pathname === '/probe.js') {
            await serveFile(res, PROBE_JS_PATH, '.js');
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Internal Server Error: ${err.message}`);
    }
}

/**
 * ローカル静的サーバを起動する。
 * @returns {Promise<import('node:http').Server>} listen 済みの http.Server（呼び出し側が close() する）
 */
export function startServer() {
    const config = loadConfig();
    const server = http.createServer((req, res) => {
        void handleRequest(req, res, config);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => {
            server.removeListener('error', reject);
            resolve(server);
        });
    });
}

// `node serve.mjs` で直接起動した場合の手動確認用エントリポイント。
// run.mjs から import された場合はこの分岐は実行されない
// （import.meta.url はこのファイル自身の URL、process.argv[1] は起動元スクリプトのパスのため）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    startServer()
        .then(() => {
            console.log(`Drive File Probe サーバを起動しました: http://${HOST}:${PORT}`);
            console.log('probe.html: http://localhost:8080/probe.html');
            console.log('Ctrl+C で終了します。');
        })
        .catch((err) => {
            console.error(err.message);
            process.exit(1);
        });
}
