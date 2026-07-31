// デモモード用ポップアップエントリ
//
// fetch モックとシードデータをインストールしてから、通常の拡張版ポップアップ実装
// （src/popup/popup.ts）をそのまま読み込む。
//
// 既知の制約: popup.ts のログインボタンは platform() を経由せず、
// chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }) で直接 service worker
// （src/background/auth-flow.ts の実 OAuth フロー）を呼び出す実装になっている。
// そのためポップアップ単体のログインボタンはこのデモモックの対象外であり、
// デモ動画の収録ではサイドパネル側のログイン導線を使うこと。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';

installDemoFetchMock();
seedDemoStore();

import '../popup/popup';
