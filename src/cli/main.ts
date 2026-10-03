// CLI の入力ファイル、認証、プロジェクト作成を接続する。
// 実行結果と復旧の案内を出力し、終了コードを返す。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ja from '../_locales/ja/messages.json';
import en from '../_locales/en/messages.json';
import { setPlatform } from '../platform';
import { createNodePlatform } from '../platform/node';
import { getUserEmail } from '../lib/sheets-api';
import { buildSpreadsheetUrl } from '../lib/share-invite';
import { parseCliArgs, usageText } from './args';
import { planImport, runCreateProject, ImportInterruptedError, safeApiErrorMessage } from './create-project';
import { createTokenProvider, OAuthError } from './oauth';

/** 作成したシートを拡張機能で開く際の Picker 操作を案内する。 */
export const PICKER_GUIDANCE = '拡張機能でこのプロジェクトを開いたときに「このシートを使うには、Googleの画面で一度だけこのシートを選ぶ必要があります」と表示されたら、「Googleで許可する」を押してこのシートを1回選んでください。招待された判定者は、初回に必ずこの操作が要ります。';

function openBrowser(url: string, log: (message: string) => void): void {
    const failed = () => log('ブラウザを開けませんでした。表示された認可 URL を手で開いてください。');
    try {
        // Issue #245: cmd /c start は Node の引数クォートで空のタイトル引数が変化するため使わない。
        // URL をシェルに渡さず、Windows の URL ハンドラを直接起動する。
        const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
        const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', failed);
        child.on('exit', code => {
            if (code !== null && code !== 0) {
                failed();
            }
        });
        child.unref();
    } catch {
        failed();
    }
}

/** 引数に従って取り込み予定の表示またはプロジェクト作成を行い、終了コードを返す。 */
export async function main(argv: string[], io: {
    stdout(line: string): void;
    stderr(line: string): void;
    env?: NodeJS.ProcessEnv;
} = { stdout: line => console.log(line), stderr: line => console.error(line) }): Promise<number> {
    const args = parseCliArgs(argv);
    if ('error' in args) {
        io.stderr(args.error);
        io.stderr(usageText());
        return 2;
    }
    if (args.help) {
        io.stdout(usageText());
        return 0;
    }
    const risPath = args.risPath!;
    if (!['.ris', '.nbib', '.txt'].includes(path.extname(risPath).toLowerCase())) {
        io.stderr('RIS / nbib のみ対応');
        return 2;
    }
    let content: string;
    let formatError = (error: unknown) => error instanceof OAuthError ? error.message : safeApiErrorMessage(error);
    try {
        content = await readFile(risPath, 'utf8');
    } catch {
        io.stderr('error: RIS ファイルを読み込めませんでした。パスと読み取り権限を確認してください。');
        return 1;
    }
    try {
        const fileName = path.basename(risPath);
        const plan = planImport(content, fileName);
        if (plan.toImport.length === 0) {
            io.stderr('有効な文献がありません');
            return 1;
        }
        if (args.dryRun) {
            io.stdout(`[dry-run] 解釈できた文献: ${plan.references.length} 件`);
            io.stdout(`[dry-run] 重複で除外される件数: ${plan.duplicateCount} 件`);
            io.stdout(`[dry-run] 取り込まれる件数: ${plan.toImport.length} 件`);
            io.stdout(`[dry-run] 要確認の重複候補: ${plan.reviewPairs.length} 組`);
            io.stdout(`[dry-run] 抄録が 15,000 字で切り詰められる件数: ${plan.truncatedAbstractCount} 件`);
            io.stdout(`[dry-run] 招待する相手: ${args.share.join(',') || '（なし）'}`);
            return 0;
        }
        const env = io.env ?? process.env;
        const clientId = env.CLI_OAUTH_CLIENT_ID;
        const clientSecret = env.CLI_OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            io.stderr('CLI_OAUTH_CLIENT_ID と CLI_OAUTH_CLIENT_SECRET が必要です。設定方法は scripts/create-project/README.md を参照してください。');
            return 2;
        }
        const provider = createTokenProvider({
            clientId, clientSecret,
            credentialsPath: env.TIAB_CLI_CREDENTIALS_PATH ??
                path.join(os.homedir(), '.tiab-review-plugin', 'cli-credentials.json'),
            openBrowser: url => openBrowser(url, io.stderr), log: io.stderr,
        });
        formatError = provider.formatError;
        setPlatform(createNodePlatform({
            ...provider, messages: args.lang === 'ja' ? ja : en, fallbackMessages: en,
            version: `cli-${env.TIAB_CLI_VERSION || 'unknown'}`,
        }));
        await provider.getAccessToken(true);
        io.stdout(`ログイン中: ${await getUserEmail()}`);
        const result = await runCreateProject({ title: args.title!, fileName, plan, share: args.share, formatError });
        io.stdout(`spreadsheet_id: ${result.spreadsheetId}`);
        io.stdout(`url: ${result.url}`);
        io.stdout(`imported: ${result.importedCount} 件（重複で除外 ${result.duplicateCount} 件、要確認の重複候補 ${result.reviewPairCount} 組、抄録の切り詰め ${result.truncatedAbstractCount} 件）`);
        io.stdout(`shared: ${result.shared.join(',') || '（なし）'}`);
        for (const warning of result.warnings) {
            io.stderr(`warning: ${warning}`);
        }
        for (const failure of result.folderShareFailures) {
            io.stderr(`warning: ${failure.email} はフォルダを共有できませんでした（スプレッドシートは共有済み。フォルダは Drive で手動共有が必要）`);
        }
        io.stdout(PICKER_GUIDANCE);
        for (const failure of result.shareFailures) {
            io.stderr(`error: ${failure.email} の招待に失敗しました: ${failure.message}`);
        }
        return result.shareFailures.length ? 1 : 0;
    } catch (error) {
        if (error instanceof ImportInterruptedError) {
            io.stderr('error: 取り込みの途中で失敗しました。再実行すると行が二重になりうるため、自動では再試行しません。');
            io.stderr(`spreadsheet_id: ${error.spreadsheetId}`);
            io.stderr(`url: ${buildSpreadsheetUrl(error.spreadsheetId)}`);
            io.stderr(`確認できた取り込み: ${error.confirmedCount} / ${error.totalCount} 件`);
            io.stderr(`失敗したバッチ: ${error.failedFrom}〜${error.failedTo} 件目（入ったかどうかは不明。シートの References タブを確認してください）`);
            io.stderr(`原因: ${formatError(error.cause)}`);
        } else {
            io.stderr(`error: ${formatError(error)}`);
        }
        return 1;
    }
}
