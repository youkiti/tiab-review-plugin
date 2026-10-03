// コマンドライン引数を検証し、プロジェクト作成の設定へ変換する。
// ヘルプ表示と引数エラーの案内もここで組み立てる。

export interface CliArgs {
    help: boolean;
    title?: string;
    risPath?: string;
    share: string[];
    dryRun: boolean;
    lang: 'ja' | 'en';
}

/** 引数を解析し、不足や不正な指定があれば表示用のエラーを返す。 */
export function parseCliArgs(argv: string[]): CliArgs | { error: string } {
    const args: CliArgs = { help: false, share: [], dryRun: false, lang: 'ja' };
    for (let i = 0; i < argv.length; i++) {
        const option = argv[i];
        if (option === '--help' || option === '-h') {
            args.help = true;
            continue;
        }
        if (option === '--dry-run') {
            args.dryRun = true;
            continue;
        }
        if (!['--title', '--ris', '--share', '--lang'].includes(option)) {
            return { error: '知らないオプションです。--help を参照してください。' };
        }
        const value = argv[++i];
        if (!value || value.startsWith('--') || value === '-h') {
            return { error: `${option} の値が必要です。` };
        }
        if (option === '--title') {
            args.title = value.trim();
        }
        if (option === '--ris') {
            args.risPath = value;
        }
        if (option === '--share') {
            const emails = value.split(',').map(email => email.trim()).filter(Boolean);
            if (emails.some(email => !email.includes('@'))) {
                return { error: '--share には @ を含むメールアドレスを指定してください。' };
            }
            args.share = [...new Set([...args.share, ...emails])];
        }
        if (option === '--lang') {
            if (value !== 'ja' && value !== 'en') {
                return { error: '--lang は ja または en を指定してください。' };
            }
            args.lang = value;
        }
    }
    if (!args.help && (!args.title || !args.risPath)) {
        return { error: '--title と --ris は必須です。' };
    }
    return args;
}

/** コマンドの使い方と利用できるオプションを返す。 */
export function usageText(): string {
    return '使い方: node scripts/create-project.mjs --title "プロジェクト名" --ris <パス> [--share a@example.com,b@example.com] [--dry-run]\n' +
        '  --title <文字列>  プロジェクト名（必須）\n' +
        '  --ris <パス>     RIS / nbib ファイル（.ris / .nbib / .txt、必須）\n' +
        '  --share <一覧>   招待するメールアドレス（カンマ区切り、複数回指定可）\n' +
        '  --dry-run        通信せず取り込み予定を表示\n' +
        '  --lang ja|en     招待文の言語（既定: ja）\n' +
        '  --help, -h       この使い方を表示';
}
