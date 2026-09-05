// デモモード用サイドパネルエントリ
//
// fetch モックとシードデータをインストールしてから、通常の拡張版サイドパネル実装
// （src/sidepanel/sidepanel.ts）をそのまま読み込む。既存のサイドパネル実装は
// 一切変更しない（差し替えは webpack.config.js の entry 設定のみで行う）。
// chrome.storage の直接参照は .eslintrc.cjs の overrides（src/demo/**）で許可済み。
//
// デモプロファイル（既定 / ML / bench）は resolveDemoProfile()（src/demo/profile.ts）で
// URL クエリパラメータ ?demoProfile=ml / ?demoProfile=bench から同期的に解決する
// （chrome.storage.local を使った非同期判定は採用していない。理由は profile.ts のコメントを
// 参照）。bench プロファイル用のサイズ・キー開閉オプションも同じく resolveBenchOptions() で
// 同期的に解決する（Issue #151（#150 工程0）チャンク2）。
// 同期的に解決できるため、このファイルは元の（Chunk 1 の）同期的な構造のまま、
// sidepanel.ts の import より前に必ずシードが完了する。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';
import { resolveDemoProfile, resolveBenchOptions } from './profile';
import { DEMO_SPREADSHEET_ID, DEMO_SPREADSHEET_TITLE, DEMO_SEED_TIMESTAMP } from './constants';

installDemoFetchMock();
seedDemoStore(resolveDemoProfile(), resolveBenchOptions());

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
