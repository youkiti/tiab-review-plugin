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
        // files.list は権限が無くても 200 + files:[] を返すため、ここでは 404 かどうかを
        // 明示的に見る（ok/statusが200系以外だからといって404とは限らない。401/403等が
        // 紛れ込むと「未付与」と誤判定してしまい、直後の Picker で不可逆な付与が起きる）。
        const unexpected = [folderMeta, fileMeta].find((r) => r.status !== 404);
        if (unexpected) {
            if (unexpected.ok) {
                ctx.fail(
                    'ベースラインが 404 ではありません。フォルダまたはファイルが既にこのアプリへ付与済みのため、' +
                    '実験が成立しません（drive.file の付与は不可逆です）。README.md の「フィクスチャの作り方」に従い、' +
                    'Drive UI で新しいフォルダ・PDF を作り直してから再実行してください。'
                );
            } else {
                ctx.fail(
                    `404 以外の想定外のステータス（${unexpected.status}）が返りました。付与状態を判定できないため中断します。` +
                    'サインインし直すか、フォルダ/ファイルIDが正しいか確認してください。' +
                    'なお、このケースではフィクスチャは消費されていません。同じフィクスチャで再実行してかまいません。'
                );
            }
        }
        ctx.note('ベースラインは想定どおり 404（未付与）でした。実験を継続します。');

        const picked = await ctx.pick(
            { selectFolder: true },
            `「${folderId}」フォルダ自体を選択して「選択」ボタンを押してください` +
            '（フォルダをダブルクリックして中に入らないこと。フォルダの行/アイコンを選んだ状態で選択ボタンを押す）'
        );

        // 選択されたのが対象フォルダそのものかを検証する。
        // ダブルクリックでフォルダの中に入ってしまうと、配下のファイルを選んだ状態でも
        // Picker は正常に PICKED を返す。そのまま進むと「選んだファイルが 200 になった」
        // だけの結果を「カスケードした」と誤読してしまう（実測1回目で実際に踏んだ）。
        // 付与は不可逆でやり直しにフィクスチャを1つ消費するため、ここで必ず止める。
        const pickedFolder = Array.isArray(picked) && picked.some((doc) => doc.id === folderId);
        if (!pickedFolder) {
            const pickedDesc = Array.isArray(picked)
                ? picked.map((doc) => `${doc.name}（${doc.mimeType}）`).join(', ')
                : JSON.stringify(picked);
            ctx.fail(
                `対象フォルダ（${folderId}）ではなく別のものが選択されました: ${pickedDesc}\n` +
                'ダブルクリックでフォルダの中に入り、配下のファイルを選んでいませんか。' +
                'フォルダはシングルクリックで選択状態にしてから「選択」ボタンを押してください。\n' +
                'なお、そもそも Picker 上でフォルダを選択できない（クリックしても選択状態にならない）場合は、' +
                'それ自体が Issue #60 の結論です（判定表3行目「フォルダ自体が選択できない → 対策 A が必要」）。' +
                'その場合は再実行せず、そう報告してください。\n' +
                '再実行するときは、いま選択してしまったファイルは付与済みなので使えません。' +
                'フォルダ自体が未付与のままなら、同じフォルダ＋別の未付与ファイルで再実行できます。'
            );
        }

        await ctx.measure('Picker選択後（直後）', buildTargets(folderId, fileId));

        // 付与がサーバ側へ反映されるまでに遅延がある疑いがあるため、間を置いて測り直す。
        // 実測では「Picker 直後は 404 だったフォルダが、数分後に 200 になっている」現象を観測した。
        // 直後の1回だけで 404 を根拠に「カスケードしない」と結論すると誤る恐れがあるため、
        // 遅延後の測定を本番の判定材料とする。
        await ctx.ask('1分ほど待ってから Enter を押してください（付与の伝播待ち。何も入力しなくてよい）');
        const afterPick = await ctx.measure('Picker選択後（待機後）', buildTargets(folderId, fileId));

        const newFileId = await ctx.ask(
            'Drive UI でこのフォルダに新しい PDF を1本追加し、その fileId を貼り付けて Enter'
        );

        const buildFollowUpTargets = (id) => [
            { label: '後追いファイル meta', kind: 'meta', id },
            { label: '後追いファイル media', kind: 'media', id },
            { label: 'フォルダ配下 list', kind: 'list', id: folderId },
        ];

        await ctx.measure('後追いアップロード後（直後）', buildFollowUpTargets(newFileId));

        // 上と同じ理由（伝播遅延）で、後追いファイルについても間を置いて測り直す。
        await ctx.ask('1分ほど待ってから Enter を押してください（付与の伝播待ち。何も入力しなくてよい）');
        const afterUpload = await ctx.measure('後追いアップロード後（待機後）', buildFollowUpTargets(newFileId));

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
