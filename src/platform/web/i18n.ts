/**
 * Web 版プラットフォームアダプタ: i18n 実装。
 * バンドルされた messages.json（ja/en）と navigator.language を用いて
 * chrome.i18n.getMessage 互換のメッセージ解決を行う。
 * navigator への参照はガードしてあるため、このモジュール自体は Node 環境でも読み込める。
 */
import ja from '../../_locales/ja/messages.json';
import en from '../../_locales/en/messages.json';
import { resolveMessage, type Messages } from './i18n-core';

// Node 環境（テスト実行時など）では navigator が存在しないため、既定で 'ja' 扱いにする
const navLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language.toLowerCase() : 'ja';
const lang: Messages = navLang.startsWith('ja') ? (ja as Messages) : (en as Messages);
const fallback: Messages = ja as Messages; // manifest の default_locale と揃える

/** chrome.i18n.getMessage 互換のメッセージ取得関数 */
export function getMessage(key: string, substitutions: string[] = []): string {
    return resolveMessage(lang, fallback, key, substitutions);
}
