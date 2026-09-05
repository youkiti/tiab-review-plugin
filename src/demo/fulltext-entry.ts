// デモモード用フルテキストページエントリ
//
// fetch モックとシードデータをインストールしてから、通常の拡張版フルテキスト実装
// （src/fulltext/fulltext.ts）をそのまま読み込む。spreadsheetId はサイドパネル側の
// 接続フローで chrome.storage.local に保存されたものをそのまま利用する。
//
// Issue #151（#150 工程0）チャンク2: bench プロファイルでのベンチマーク時に、フルテキスト
// ページ（別ウィンドウ）を直接開いても大量データが見えるよう、sidepanel-entry.ts と同じく
// resolveDemoProfile() / resolveBenchOptions() で URL クエリパラメータから同期的に解決して
// seedDemoStore() へ渡す（従来はプロファイル解決を行わず常に 'default' だった）。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';
import { resolveDemoProfile, resolveBenchOptions } from './profile';

installDemoFetchMock();
seedDemoStore(resolveDemoProfile(), resolveBenchOptions());

import '../fulltext/fulltext';
