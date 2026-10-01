// Web 版の収録用デモエントリ。
// fetch モック・シード・GIS の代役を用意し、実アカウントなしで Web 版を操作する。
// Web 版エントリが登録する DOMContentLoaded より前に準備を完了する。

import { installDemoFetchMock } from './fetch-mock';
import { seedDemoStore } from './seed';
import { resolveDemoProfile, resolveBenchOptions } from './profile';
import { DEMO_SPREADSHEET_ID, DEMO_SPREADSHEET_TITLE, DEMO_SEED_TIMESTAMP, DEMO_TOKEN } from './constants';
import { storageSet } from '../platform/web/storage';

installDemoFetchMock();
seedDemoStore(resolveDemoProfile(), resolveBenchOptions());

// 保存関数内の localStorage 書き込みは同期的に完了する。
void storageSet({
    localRecentSheets: [
        { id: DEMO_SPREADSHEET_ID, name: DEMO_SPREADSHEET_TITLE, lastUsedAt: DEMO_SEED_TIMESTAMP },
    ],
});

const demoGoogle = {
    accounts: {
        oauth2: {
            initTokenClient(config: google.accounts.oauth2.TokenClientConfig): google.accounts.oauth2.TokenClient {
                return {
                    requestAccessToken() {
                        // 成功応答だけを再現し、型定義で必須のエラー情報などを省くため unknown を経由する。
                        setTimeout(() => config.callback({
                            access_token: DEMO_TOKEN,
                            expires_in: '3600',
                            token_type: 'Bearer',
                            scope: config.scope,
                        } as unknown as google.accounts.oauth2.TokenResponse), 0);
                    },
                };
            },
            revoke(_token: string, done: () => void): void {
                done();
            },
        },
    },
};

// 収録に必要な OAuth API だけを実装するため、GIS 全体の型へ unknown 経由で変換する。
window.google = demoGoogle as unknown as typeof google;

import '../webapp/index';
