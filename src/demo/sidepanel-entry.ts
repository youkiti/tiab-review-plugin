// デモモード用サイドパネルエントリ
//
// fetch モックとシードデータをインストールしてから、通常の拡張版サイドパネル実装
// （src/sidepanel/sidepanel.ts）をそのまま読み込む。既存のサイドパネル実装は
// 一切変更しない（差し替えは webpack.config.js の entry 設定のみで行う）。
// chrome.storage の直接参照は .eslintrc.cjs の overrides（src/demo/**）で許可済み。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';
import { DEMO_SPREADSHEET_ID, DEMO_SPREADSHEET_TITLE, DEMO_SEED_TIMESTAMP } from './constants';

installDemoFetchMock();
seedDemoStore();

// 「最近使用したシート」にデモプロジェクトを事前登録し、ログイン直後の一覧へ
// spreadsheetId の事前設定なしで表示されるようにする（loadRecentSheets は
// Drive API モックの files.list とこのローカル一覧をマージするため、
// 片方が欠けてももう片方で一覧に出るようにする保険も兼ねる）。
void chrome.storage.local.set({
    localRecentSheets: [
        { id: DEMO_SPREADSHEET_ID, name: DEMO_SPREADSHEET_TITLE, lastUsedAt: DEMO_SEED_TIMESTAMP },
    ],
});

import '../sidepanel/sidepanel';
