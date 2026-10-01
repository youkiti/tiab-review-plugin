// 案内ツアーの通し検証で共有する定数と設定。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DIST_DEMO_DIR = path.join(REPO_ROOT, 'dist-demo');
export const OUT_DIR = path.join(REPO_ROOT, '.tmp', 'guide-tour-check');
export const NBIB_FILE = path.join(REPO_ROOT, 'sample', 'pubmed-srws-psgad-set.nbib');

// src/demo/constants.ts の DEMO_SPREADSHEET_ID と同じ値（TS は import できないため手で写している）
export const DEMO_SPREADSHEET_ID = 'demo-spreadsheet-001';
export const DEMO_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DEMO_SPREADSHEET_ID}/edit`;

// src/demo/constants.ts の DEMO_SIGNED_IN_STORAGE_KEY と同じ値（デモのサインイン済みフラグの chrome.storage.local のキー）
export const DEMO_SIGNED_IN_STORAGE_KEY = 'demo_signed_in';

export const DEVICE_SCALE_FACTOR = 1;

/**
 * 実行時の設定。run.mjs が --size で viewport を書き換える（サイドパネルの実寸に近い縦長が既定。capture.mjs と同じ）。
 * ブラウザを起動するたびにここを読むので、書き換えは起動前に行うこと。
 */
export const config = {
    viewport: { width: 500, height: 1000 },
};

export const STEP_TIMEOUT = 20000; // 手順が切り替わるまでの待ち
export const POLL_STEP_TIMEOUT = 40000; // Picker 許可後の自動再接続（3秒ポーリング）を待つ手順
export const ACTION_TIMEOUT = 10000; // 要素が押せるようになるまでの待ち
export const NEGATIVE_WAIT = 4000; // 「現れないこと」を確かめる待ち

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
