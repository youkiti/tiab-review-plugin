// デスクトップ型 OAuth クライアントで作成したシートの付与単位を測定する（Issue #245）。
// 同じ GCP プロジェクトの Web クライアントでサインインし、meta を測定する。
// 404 の場合は Picker でそのシートを選んで再測定し、付与後に読めることを確認する。
export default {
    id: 'desktop-client-created-file',
    title: 'CLI で作成したシートを Web クライアントから読めるか',
    inputs: ['fileId'],
    async run(ctx) {
        await ctx.signIn();
        const { fileId } = ctx.input;
        const targets = [{ label: 'スプレッドシート meta', kind: 'meta', id: fileId }];
        const baseline = await ctx.measure('ベースライン', targets);
        const status = baseline.find(result => result.label === 'スプレッドシート meta')?.status;
        try {
            if (status === 200) {
                ctx.note('GCP プロジェクト単位。CLI で作ったシートは Picker 無しで開ける');
            } else if (status === 404) {
                ctx.note('OAuth クライアント単位。作成者も Picker で1回選ぶ必要がある');
                await ctx.pick({ mimeTypes: 'application/vnd.google-apps.spreadsheet' },
                    `CLI が作成したスプレッドシート（ID: ${fileId}）を選んでください。`);
                const after = await ctx.measure('Picker 選択後', targets);
                if (after.find(result => result.label === 'スプレッドシート meta')?.status !== 200) {
                    ctx.fail('Picker 選択後も読み取れませんでした。付与状態を判定できません。');
                }
                ctx.note('Picker で選ぶと同じシートを読めることを確認しました。');
            } else {
                ctx.fail(`想定外のステータス（${status}）のため付与状態を判定できません。`);
            }
        } finally {
            ctx.note(
                '| ベースライン | 意味 | CLI の案内文 |\n|---|---|---|\n' +
                '| 200 | GCP プロジェクト単位 | 作成者の Web 版 Picker 案内は不要。招待者向けは維持 |\n' +
                '| 404 | OAuth クライアント単位 | 作成者にも Picker で1回選ぶ案内を維持 |\n\n' +
                'サインインするアカウントは CLI でシートを作ったのと同じアカウントであること。\n' +
                '拡張機能側は別の OAuth クライアントなので、拡張機能でシートの URL を貼って開けるかも別途確かめて記録すること。'
            );
        }
    },
};
