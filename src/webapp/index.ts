/**
 * Web アプリ版エントリポイント
 *
 * 共有配線（bootstrapCommon）だけを使い、拡張専用機能（LLM / ML / フルテキスト /
 * インポート・エクスポート / 論文用テキスト）は import しない。
 * これにより chrome 依存や不要コードが Web バンドルへ混入しないようにする。
 */

// プラットフォームアダプタを最初に注入する（他モジュールが platform() を呼ぶため）
import { setPlatform } from '../platform';
import { webPlatform } from '../platform/web';
setPlatform(webPlatform);

import { bootstrapCommon } from '../sidepanel/bootstrap';

document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('web-app');
    bootstrapCommon();
});
