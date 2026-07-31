// デモプロファイル解決
//
// 'default'（実データ10件のみ）と 'ml'（+ 合成文献1,090件、MLタブ開放デモ用）を
// 切り替えるための入口。URL クエリパラメータ ?demoProfile=ml のみで判定する
// （同期・確実。sidepanel.html / fulltext.html に対して Playwright で直接指定できる）。
//
// 実装メモ（chrome.storage.local 案を採用しなかった理由）:
// 当初は chrome.storage.local の 'demo_profile' キーを非同期フォールバックとして
// 読む案も検討したが、実際に Chromium 拡張機能上で計測したところ、
// document.addEventListener('DOMContentLoaded', ...) の発火は
// chrome.storage.local.get()（拡張プロセスを跨ぐ real な非同期呼び出し）の解決より
// 先に走ってしまい、シード完了前に src/sidepanel/sidepanel.ts 側の初期化
// （bootstrapCommon 呼び出し・イベントリスナー登録・i18n 適用）が一切行われないまま
// DOMContentLoaded リスナーの登録機会自体を逃す事象を確認した（ログインボタンの
// クリックが効かず、i18nテキストも空のままになる）。
// これは「クエリパラメータが無い＝既定プロファイル」という最も頻繁なケース
// （通常の拡張機能利用者がサイドパネルを開く操作そのもの）を壊してしまうため、
// 非同期フォールバックは採用せず、クエリパラメータのみによる完全同期解決とした。

export type DemoProfile = 'default' | 'ml';

/**
 * 現在のページURLの ?demoProfile= クエリパラメータからプロファイルを同期的に解決する。
 * 'ml' 以外（未指定・不明な値）は常に 'default' として扱う。
 */
export function resolveDemoProfile(): DemoProfile {
    if (typeof location === 'undefined') return 'default';
    const value = new URLSearchParams(location.search).get('demoProfile');
    return value === 'ml' ? 'ml' : 'default';
}
