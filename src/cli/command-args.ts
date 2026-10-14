// 従来の作成引数を維持し、サブコマンド固有の指定を検証する。
import { parseCliArgs, usageText, type CliArgs } from './args';

export interface CommandArgs extends CliArgs {
    command: 'create' | 'seed' | 'share' | 'status';
    spreadsheetId?: string;
    decisionsPath?: string;
    openKey: boolean;
    json: boolean;
}

export function parseCommandArgs(argv: string[]): CommandArgs | { error: string } {
    const rest = [...argv];
    const command = rest[0] && !rest[0].startsWith('-') ? rest.shift()! : 'create';
    if (!['create', 'seed', 'share', 'status'].includes(command)) return { error: '知らないサブコマンドです。' };
    const spreadsheetId = command !== 'create' && rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
    let decisionsPath: string | undefined;
    let openKey = false;
    let json = false;
    const common: string[] = [];
    const allowed = command === 'create' ? ['--title', '--ris', '--share', '--lang'] :
        command === 'share' ? ['--share', '--lang'] : [];
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--decisions' && ['create', 'seed'].includes(command)) {
            decisionsPath = rest[++i];
            if (!decisionsPath || decisionsPath.startsWith('-')) return { error: '--decisions の値が必要です。' };
        } else if (arg === '--open-key' && ['create', 'seed'].includes(command)) {
            openKey = true;
        } else if (arg === '--json' && command === 'status') {
            json = true;
        } else if (['--help', '-h'].includes(arg) || (arg === '--dry-run' && command !== 'status')) {
            common.push(arg);
        } else if (allowed.includes(arg)) {
            common.push(arg, rest[++i] ?? '');
        } else {
            return { error: 'このコマンドでは使えないオプションです。--help を参照してください。' };
        }
    }
    const parsed = parseCliArgs(command === 'create' ? common : ['--title', '対象', '--ris', '対象', ...common]);
    if ('error' in parsed) return parsed;
    if (!parsed.help) {
        if (command !== 'create' && (!spreadsheetId || !/^[\w-]+$/.test(spreadsheetId))) return { error: '有効な spreadsheet_id が必要です。' };
        if (command === 'seed' && !decisionsPath) return { error: '--decisions は必須です。' };
        if (command === 'share' && !parsed.share.length) return { error: '--share は必須です。' };
    }
    return { ...parsed, command: command as CommandArgs['command'], spreadsheetId, decisionsPath, openKey, json };
}

export function commandUsage(): string {
    return '使い方: node scripts/tiab.mjs <コマンド>\n' +
        '  create --title <名前> --ris <パス> [--decisions <CSV>] [--open-key] [--share <一覧>] [--lang ja|en] [--dry-run]\n' +
        '  seed <spreadsheet_id> --decisions <CSV> [--open-key] [--dry-run]\n' +
        '  share <spreadsheet_id> --share <一覧> [--lang ja|en] [--dry-run]\n' +
        '  status <spreadsheet_id> [--json]\n' +
        'seed の dry-run は CSV のみ検査し、文献の照合・既存判定の確認は行いません。\n\n' + usageText();
}
