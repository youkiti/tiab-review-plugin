// シナリオ: フォルダカスケード検証（GitHub Issue #60）
//
// Google Picker でフォルダを選択したとき、drive.file の付与がそのフォルダ配下の
// ファイルにも及ぶか（＝カスケードするか）を測定する。
//
// 手順:
//   1. サインイン
//   2. ベースライン測定（フォルダ meta / 対象ファイル meta・media / フォルダ配下 list）
//      → いずれかが 404 でなければ、既にアプリへ付与済みで実験が成立しないため中断する
//      （付与は不可逆なので、ここで気づかず進めると測定全体が無意味になる）
//   3. Picker で対象フォルダそのものを選択（フォルダへ入らず、フォルダ自体を選ぶ）
//   4. 同じ測定を再実行（Picker選択後）
//   5. Drive UI で新しい PDF を追加してもらい、その後追いファイルを測定
//   6. 判定表を report.md へ残す

export default {
    id: 'folder-cascade',
    title: 'Picker でのフォルダ選択が配下ファイルへカスケードするか',
    inputs: ['folderId', 'fileId'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId, fileId } = ctx.input;

        const buildTargets = (targetFolderId, targetFileId) => [
            { label: 'フォルダ meta', kind: 'meta', id: targetFolderId },
            { label: 'ファイル meta', kind: 'meta', id: targetFileId },
            { label: 'ファイル media', kind: 'media', id: targetFileId },
            { label: 'フォルダ配下 list', kind: 'list', id: targetFolderId },
        ];

        const baseline = await ctx.measure('ベースライン', buildTargets(folderId, fileId));

        const folderMeta = baseline.find((r) => r.label === 'フォルダ meta');
        const fileMeta = baseline.find((r) => r.label === 'ファイル meta');
        if (folderMeta.ok || fileMeta.ok) {
            ctx.fail(
                'ベースラインが 404 ではありません。フォルダまたはファイルが既にこのアプリへ付与済みのため、' +
                '実験が成立しません（drive.file の付与は不可逆です）。README.md の「フィクスチャの作り方」に従い、' +
                'Drive UI で新しいフォルダ・PDF を作り直してから再実行してください。'
            );
        }
        ctx.note('ベースラインは想定どおり 404（未付与）でした。実験を継続します。');

        await ctx.pick(
            { selectFolder: true },
            `「${folderId}」フォルダ自体を選択して「選択」ボタンを押してください` +
            '（フォルダをダブルクリックして中に入らないこと。フォルダの行/アイコンを選んだ状態で選択ボタンを押す）'
        );

        const afterPick = await ctx.measure('Picker選択後', buildTargets(folderId, fileId));

        const newFileId = await ctx.ask(
            'Drive UI でこのフォルダに新しい PDF を1本追加し、その fileId を貼り付けて Enter'
        );

        const afterUpload = await ctx.measure('後追いアップロード後', [
            { label: '後追いファイル meta', kind: 'meta', id: newFileId },
            { label: '後追いファイル media', kind: 'media', id: newFileId },
            { label: 'フォルダ配下 list', kind: 'list', id: folderId },
        ]);

        ctx.note(
            '## 判定の読み方\n\n' +
            '| 手順4（Picker選択後）の配下ファイル | 手順5（後追いアップロード後）の後追いファイル | 結論 |\n' +
            '|---|---|---|\n' +
            '| 200 | 200 | カスケードする。参加時1クリックで分担収集が成立 |\n' +
            '| 200 | 404 | 選択時点のスナップショット型。アップロードのたびに再付与が要る |\n' +
            '| 404 | — | カスケードしない |'
        );

        const afterPickFileMedia = afterPick.find((r) => r.label === 'ファイル media');
        const afterUploadFileMedia = afterUpload.find((r) => r.label === '後追いファイル media');
        ctx.note(
            `今回の結果: Picker選択後の配下ファイル media = ${afterPickFileMedia.status}、` +
            `後追いアップロード後の後追いファイル media = ${afterUploadFileMedia.status}`
        );
    },
};
