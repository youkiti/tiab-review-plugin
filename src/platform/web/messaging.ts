/**
 * Web 版プラットフォームアダプタ: ページ内メッセージング実装。
 * 拡張機能版の chrome.runtime メッセージングの代わりに、同一ページ内の
 * EventTarget を使ったシンプルな pub/sub で代替する（チーム進捗の即時更新用）。
 */
const bus = new EventTarget();

/** メッセージ受信リスナーを登録する */
export function onMessage(listener: (message: unknown) => void): void {
    bus.addEventListener('message', (e) => listener((e as CustomEvent).detail));
}

/** メッセージを送信する（同一ページ内のリスナー全員に配信） */
export function emitMessage(message: unknown): void {
    bus.dispatchEvent(new CustomEvent('message', { detail: message }));
}
