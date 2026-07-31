// デモモード用フルテキストページエントリ
//
// fetch モックとシードデータをインストールしてから、通常の拡張版フルテキスト実装
// （src/fulltext/fulltext.ts）をそのまま読み込む。spreadsheetId はサイドパネル側の
// 接続フローで chrome.storage.local に保存されたものをそのまま利用する。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';

installDemoFetchMock();
seedDemoStore();

import '../fulltext/fulltext';
