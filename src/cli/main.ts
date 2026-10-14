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
import { getUserEmail, setKeyOpenedStatus, SheetsAccessDeniedError } from '../lib/sheets-api';
import { buildSpreadsheetUrl } from '../lib/share-invite';
import { parseCommandArgs, commandUsage } from './command-args';
import { parseDecisionCsv, decisionCsvSummary, resolveDecisionInputs, InputError, type DecisionInput } from './decision-csv';
import { runSeed, SeedInterruptedError, SeedPostProcessingError } from './seed';
import { runShare, inviteReviewers } from './share';
import { runStatus, statusText } from './status';
import { planImport, runCreateProject, ImportInterruptedError, safeApiErrorMessage } from './create-project';
import { createTokenProvider, OAuthError } from './oauth';

/**
 * 作成したシートを拡張機能で開く際の Picker 操作を案内する。
 * Issue #245: drive.file の付与は GCP プロジェクト単位と実測で確定したため（src/platform/AGENTS.md）、
 * 作成者は同じ GCP プロジェクトのクライアントならそのまま開ける。招待された判定者は初回に選ぶ必要がある。
 */
export const PICKER_GUIDANCE = '招待された判定者は、拡張機能でこのプロジェクトを初めて開くときに「Googleで許可する」を押してこのシートを1回選ぶ必要があります。作成者は、拡張機能と同じ Google Cloud プロジェクトのクライアントを使っていれば、そのまま開けます（別のプロジェクトのクライアントを使った場合は、作成者も同じ操作が要ります）。';

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
    const args = parseCommandArgs(argv);
    if ('error' in args) {
        io.stderr(args.error);
        io.stderr(commandUsage());
        return 2;
    }
    if (args.help) {
        io.stdout(commandUsage());
        return 0;
    }
    const risPath = args.risPath;
    let formatError = (error: unknown) => error instanceof OAuthError ? error.message : safeApiErrorMessage(error);
    let createdId: string | undefined;
    try {
        let rows: DecisionInput[] | undefined;
        if (args.decisionsPath) {
            let csv: string;
            try { csv = await readFile(args.decisionsPath, 'utf8'); }
            catch { throw new InputError('判定 CSV を読み込めませんでした。'); }
            rows = parseDecisionCsv(csv);
        }
        let plan: ReturnType<typeof planImport> | undefined;
        const fileName = risPath ? path.basename(risPath) : '';
        if (args.command === 'create') {
            if (!risPath || !['.ris', '.nbib', '.txt'].includes(path.extname(risPath).toLowerCase())) {
                io.stderr('RIS / nbib のみ対応');
                return 2;
            }
            let content: string;
            try { content = await readFile(risPath, 'utf8'); }
            catch { throw new InputError('RIS ファイルを読み込めませんでした。パスと読み取り権限を確認してください。'); }
            plan = planImport(content, fileName);
            if (plan.toImport.length === 0) throw new InputError('有効な文献がありません');
            // 作成時も、判定 CSV の照合に失敗するならシート作成前に止める。
            if (rows && !args.dryRun) resolveDecisionInputs(rows, plan.toImport, []);
        }
        if (args.dryRun) {
            if (plan) {
                io.stdout(`[dry-run] 解釈できた文献: ${plan.references.length} 件`);
                io.stdout(`[dry-run] 重複で除外される件数: ${plan.duplicateCount} 件`);
                io.stdout(`[dry-run] 取り込まれる件数: ${plan.toImport.length} 件`);
                io.stdout(`[dry-run] 要確認の重複候補: ${plan.reviewPairs.length} 組`);
                io.stdout(`[dry-run] 抄録が 15,000 字で切り詰められる件数: ${plan.truncatedAbstractCount} 件`);
            }
            if (rows) io.stdout(`[dry-run] CSV 検査結果: ${JSON.stringify(decisionCsvSummary(rows))}（References・既存判定とは未照合）`);
            if (args.command !== 'seed') io.stdout(`[dry-run] 招待する相手: ${args.share.join(',') || '（なし）'}`);
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
        formatError = error => error instanceof SheetsAccessDeniedError
            ? 'このコマンドで作ったプロジェクトにしか使えません。ID とログインしたアカウントを確認してください。'
            : provider.formatError(error);
        setPlatform(createNodePlatform({
            ...provider, messages: args.lang === 'ja' ? ja : en, fallbackMessages: en,
            version: `cli-${env.TIAB_CLI_VERSION || 'unknown'}`,
        }));
        await provider.getAccessToken(true);
        const userEmail = await getUserEmail();
        if (args.command === 'status') {
            const status = await runStatus(args.spreadsheetId!, userEmail);
            io.stdout(args.json ? JSON.stringify(status, null, 2) : statusText(status));
            return 0;
        }
        io.stdout(`ログイン中: ${userEmail}`);
        if (args.command === 'seed') {
            const result = await runSeed({ spreadsheetId: args.spreadsheetId!, rows: rows!, source: path.basename(args.decisionsPath!), openKey: args.openKey });
            io.stdout(`判定取り込み: ${result.imported} 件。${result.assignment}`);
            return 0;
        }
        if (args.command === 'share') {
            const result = await runShare(args.spreadsheetId!, args.share, formatError);
            printShareResult(result, io);
            return result.shareFailures.length ? 1 : 0;
        }
        const result = await runCreateProject({ title: args.title!, fileName, plan: plan!, share: [], formatError });
        createdId = result.spreadsheetId;
        for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
        if (rows) {
            const seeded = await runSeed({ spreadsheetId: createdId, rows, source: path.basename(args.decisionsPath!), openKey: args.openKey });
            io.stdout(`判定取り込み: ${seeded.imported} 件。${seeded.assignment}`);
        } else if (args.openKey) {
            await setKeyOpenedStatus(createdId, true);
        }
        Object.assign(result, await inviteReviewers(createdId, args.title!, result.folderId, args.share, formatError));
        io.stdout(`spreadsheet_id: ${result.spreadsheetId}`);
        io.stdout(`url: ${result.url}`);
        io.stdout(`imported: ${result.importedCount} 件（重複で除外 ${result.duplicateCount} 件、要確認の重複候補 ${result.reviewPairCount} 組、抄録の切り詰め ${result.truncatedAbstractCount} 件）`);
        printShareResult(result, io);
        return result.shareFailures.length ? 1 : 0;
    } catch (error) {
        if (error instanceof InputError) {
            if (createdId) io.stderr(`作成済み spreadsheet_id: ${createdId}（状態を確認してください）`);
            io.stderr(`error: ${error.message}`);
        } else if (error instanceof SeedPostProcessingError) {
            io.stderr(`error: ${error.message}`);
            io.stderr(`spreadsheet_id: ${error.spreadsheetId}`);
            io.stderr(`原因: ${formatError(error.cause)}`);
        } else if (error instanceof SeedInterruptedError) {
            io.stderr(`error: ${error.message}`);
            io.stderr(`spreadsheet_id: ${error.spreadsheetId}`);
            io.stderr(`読み戻せた取り込み行: ${error.confirmed ?? '不明'} / ${error.expected} 件（件数だけでは内容一致を保証しません）。Decisions と Config を確認してください。`);
            if (error.cause) io.stderr(`原因: ${formatError(error.cause)}`);
        } else if (error instanceof ImportInterruptedError) {
            io.stderr('error: 取り込みの途中で失敗しました。再実行すると行が二重になりうるため、自動では再試行しません。');
            io.stderr(`spreadsheet_id: ${error.spreadsheetId}`);
            io.stderr(`url: ${buildSpreadsheetUrl(error.spreadsheetId)}`);
            io.stderr(`確認できた取り込み: ${error.confirmedCount} / ${error.totalCount} 件`);
            io.stderr(`失敗したバッチ: ${error.failedFrom}〜${error.failedTo} 件目（入ったかどうかは不明。シートの References タブを確認してください）`);
            io.stderr(`原因: ${formatError(error.cause)}`);
        } else {
            if (createdId) io.stderr(`作成済み spreadsheet_id: ${createdId}（再作成せず状態を確認してください）`);
            io.stderr(`error: ${formatError(error)}`);
        }
        return 1;
    }
}

/** 作成時も追加招待も、成功・失敗の相手とフォルダ共有の警告を同じ形で出す。 */
function printShareResult(result: Awaited<ReturnType<typeof inviteReviewers>>, io: {
    stdout(line: string): void; stderr(line: string): void;
}): void {
    io.stdout(`shared: ${result.shared.join(',') || '（なし）'}`);
    for (const failure of result.folderShareFailures) {
        io.stderr(`warning: ${failure.email} はフォルダを共有できませんでした（スプレッドシートは共有済み。フォルダは Drive で手動共有が必要）`);
    }
    io.stdout(PICKER_GUIDANCE);
    for (const failure of result.shareFailures) io.stderr(`error: ${failure.email} の招待に失敗しました: ${failure.message}`);
}
