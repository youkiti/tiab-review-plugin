// シナリオ: 未付与フォルダへの files.copy 複製検証
//
// 「アプリに drive.file 未付与のフォルダを parents に指定して、files.copy でファイルを
// 複製できるか」を測定する（GitHub Issue #68）。upload-to-ungranted-folder.mjs で
// files.create（multipart upload）は未付与フォルダへ作成でき、parents も尊重されると
// 実測済みだが、files.copy は別エンドポイントのため未検証。
// 実装側の該当箇所は src/lib/drive-api.ts の copyPdfToFulltextFolder()（563行目付近。
// PDF取り込み時に POST /files/{sourceFileId}/copy で呼ばれる）。
//
// 手順:
//   1. サインイン
//   2. ベースライン測定（コピー先フォルダ meta / コピー元ファイル meta / コピー先フォルダ配下 list）
//      → コピー先フォルダ meta が 404 でなければ実験が成立しないため中断する
//      → コピー元ファイル meta が 404 でなければ、Picker選択前後の付与の変化を追えないため中断する
//   3. Picker でコピー元PDFを選択し、drive.file を付与する
//   4. 付与できたことを再測定で確認する
//   5. 未付与フォルダへ files.copy で複製する
//   6. 成功した場合、作成されたファイルの meta・フォルダ meta（再測定）・フォルダ配下 list（再測定）
//      を追加測定し、「本当にそのフォルダの中に複製されたのか」「親フォルダは付与されたのか」を確認する
//   7. 判定表を report.md へ残す
//   8. このシナリオの測定の限界（フォルダの所有者を判別できない・2026-08-08時点で未実測であること）を明記する

export default {
    id: 'copy-to-ungranted-folder',
    title: '未付与フォルダへ files.copy でファイルを複製できるか',
    inputs: ['folderId', 'sourceFileId'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId, sourceFileId } = ctx.input;

        const baseline = await ctx.measure('ベースライン', [
            { label: 'コピー先フォルダ meta', kind: 'meta', id: folderId },
            { label: 'コピー元ファイル meta', kind: 'meta', id: sourceFileId },
            { label: 'コピー先フォルダ配下 list', kind: 'list', id: folderId },
        ]);

        const folderMeta = baseline.find((r) => r.label === 'コピー先フォルダ meta');
        // files.list は権限が無くても 200 + files:[] を返すため、ガードには使わない
        // （upload-to-ungranted-folder.mjs と同じ理由。AGENTS.md「実測で確定した挙動」参照）。
        if (folderMeta.status !== 404) {
            if (folderMeta.ok) {
                ctx.fail(
                    'コピー先フォルダのベースラインが 404 ではありません。このフォルダは既にアプリへ付与済みのため' +
                    '実験が成立しません。Drive UI で新しいフォルダを作り直してから再実行してください。'
                );
            } else {
                ctx.fail(
                    `404 以外の想定外のステータス（${folderMeta.status}）が返りました。付与状態を判定できないため` +
                    '中断します。サインインし直すか、フォルダIDが正しいか確認してください。'
                );
            }
        }

        const sourceMeta = baseline.find((r) => r.label === 'コピー元ファイル meta');
        if (sourceMeta.status !== 404) {
            if (sourceMeta.ok) {
                ctx.fail(
                    'コピー元ファイルのベースラインが 404 ではありません。このシナリオは「Picker で選んだから' +
                    '付与された（404→200）」という証拠の連鎖の上に成り立っており、最初から付与済みのファイルを' +
                    '使うとその連鎖が切れて測定が無意味になります。Drive UI で手作業に作った未付与の PDF を' +
                    '使い直してください。'
                );
            } else {
                ctx.fail(
                    `404 以外の想定外のステータス（${sourceMeta.status}）が返りました。付与状態を判定できないため` +
                    '中断します。サインインし直すか、ファイルIDが正しいか確認してください。'
                );
            }
        }

        // この時点で中断してもフォルダのフィクスチャは消費されない（Picker 操作前なので付与が起きない）ため、
        // フォルダは作り直さずに再利用してよい。
        ctx.note('ベースラインは想定どおり両方 404（未付与）でした。実験を継続します。');

        const pickResult = await ctx.pick(
            { mimeTypes: 'application/pdf' },
            `コピー元ファイル（ID: ${sourceFileId}）を Picker で1つだけ選択してください。` +
            'それ以外のファイルを選ぶと以降の測定が無意味になります。'
        );
        if (pickResult[0]?.id !== sourceFileId) {
            ctx.fail(
                `Picker で選択されたファイルID（${pickResult[0]?.id}）が、想定していたコピー元ファイルID` +
                `（${sourceFileId}）と一致しません。選択ミスに気づかず進むと以降の測定が全て無意味になるため中断します。`
            );
        }

        const afterPick = await ctx.measure('Picker 選択後', [
            { label: 'コピー元ファイル meta（再測定）', kind: 'meta', id: sourceFileId },
        ]);
        const sourceMetaAfterPick = afterPick.find((r) => r.label === 'コピー元ファイル meta（再測定）');
        if (!sourceMetaAfterPick.ok) {
            ctx.fail(
                'Picker で選択したはずのコピー元ファイルが、再測定でも 200 になりません' +
                `（status=${sourceMetaAfterPick.status}）。Picker での付与が成立していない状態で copy を撃つと、` +
                '失敗の原因が「未付与のコピー先フォルダ」なのか「未付与のコピー元」なのか切り分けられなくなるため' +
                '中断します。'
            );
        }
        ctx.note('Picker によるコピー元ファイルへの付与を確認しました。複製を実行します。');

        // ファイル名の一意化: upload-to-ungranted-folder.mjs と同じ方針（Date.now()/Math.random() では
        // なく人間に短いラベルを尋ねて組み込む）。
        const runLabel = await ctx.ask(
            '今回の複製を識別する短いラベルを入力してください（例: 01, retry-a）。' +
            'ファイル名は probe-copy-<ラベル>.pdf になります。'
        );
        const fileName = `probe-copy-${runLabel}.pdf`;

        // appProperties は実装（copyPdfToFulltextFolder の呼び出し元、
        // src/sidepanel/features/fulltext-drive-import.ts:629）と同じキー構成にする。実条件に揃えるため。
        const copyResult = await ctx.copy('未付与フォルダへの files.copy', {
            sourceFileId,
            folderId,
            name: fileName,
            appProperties: {
                sourceFileId,
                refId: 'probe-ref',
                spreadsheetId: 'probe-spreadsheet',
                importOperationId: `probe-${runLabel}`,
            },
        });

        if (!copyResult.ok) {
            ctx.note(
                `複製は失敗しました（status=${copyResult.status}）。未付与フォルダへは複製できないという結果です。`
            );
        } else {
            const createdFileId = copyResult.body?.id;
            ctx.note(`複製に成功しました（id=${createdFileId}, name=${copyResult.body?.name}）。追加測定を行います。`);

            const followUp = await ctx.measure('作成後の確認', [
                { label: '作成されたファイル meta', kind: 'meta', id: createdFileId },
                { label: 'コピー先フォルダ meta（再測定）', kind: 'meta', id: folderId },
                { label: 'コピー先フォルダ配下 list（再測定）', kind: 'list', id: folderId },
            ]);

            // parents の確認（このシナリオの本題）。files.copy レスポンスの parents はリクエスト内容を
            // そのまま反映しているだけの可能性があるため、保存後の状態を files.get で取り直した方を
            // 真値として採用する。両者が食い違う場合はその旨を明示的に note する。
            const createdMeta = followUp.find((r) => r.label === '作成されたファイル meta');
            const parentsFromCopyResponse = copyResult.body?.parents ?? [];
            if (!createdMeta?.ok) {
                ctx.note(
                    `作成されたファイルの files.get 自体が失敗した（status=${createdMeta?.status}）ため、` +
                    'parents を検証できませんでした。files.copy レスポンスの parents（' +
                    `${JSON.stringify(parentsFromCopyResponse)}）は参考値として記録しますが、これだけで` +
                    '「対象フォルダに複製できた」と判定してはいけません。'
                );
            } else {
                const parentsFromGet = createdMeta.body?.parents ?? [];
                const parentIsTargetFolder = parentsFromGet.includes(folderId);
                const parentsMismatch = JSON.stringify(parentsFromGet) !== JSON.stringify(parentsFromCopyResponse);
                ctx.note(
                    `files.get の parents（真値として採用）: ${JSON.stringify(parentsFromGet)}` +
                    `（対象フォルダを含む: ${parentIsTargetFolder ? 'はい' : 'いいえ'}）\n` +
                    `files.copy レスポンスの parents: ${JSON.stringify(parentsFromCopyResponse)}` +
                    (parentsMismatch
                        ? '\n両者は食い違っています。files.copy のレスポンスはリクエスト内容をそのまま反映しているだけの' +
                          '可能性があるため、files.get の結果を採用しました。'
                        : '\n両者は一致しています。')
                );
            }

            const folderMetaAfter = followUp.find((r) => r.label === 'コピー先フォルダ meta（再測定）');
            ctx.note(
                `複製後のコピー先フォルダ meta: status=${folderMetaAfter.status}` +
                (folderMetaAfter.status === 404
                    ? '（複製の副作用では親フォルダは付与されない）'
                    : '（複製の副作用で親フォルダも付与された可能性がある）')
            );
        }

        ctx.note(
            '## 判定の読み方\n\n' +
            '**HTTP ステータスだけで判断しないこと。** parents を必ず確認する。\n\n' +
            '| files.copy の結果 | 意味 | 対応 |\n' +
            '|---|---|---|\n' +
            '| 200 かつ parents が対象フォルダ | 未付与フォルダへも複製できる。共同研究者もそのまま取り込みを' +
            '使える | コード変更は不要。AGENTS.md の「実測で確定した挙動」へ追記する |\n' +
            '| 200 だが parents が対象フォルダ以外（マイドライブ直下など） | Drive が指定した親を黙って' +
            '無視した。**成功に見えるが PDF が fulltext フォルダの外へ散らばる** | 取り込み後に files.get で' +
            'parents を検証して失敗扱いにする等の対策が要る |\n' +
            '| 403/404 | 複製には付与が必要。共同研究者は取り込み機能だけ使えない | 取り込み前に Picker で' +
            'fulltext フォルダ自体を選ばせて付与する導線が要る |'
        );

        ctx.note(
            '## 結果の解釈には、対象フォルダを誰が所有しているかが要る\n\n' +
            'このシナリオもコピー先フォルダの所有者を判別できない（未付与なので meta が読めない）。' +
            '実行者はどちらのフィクスチャを使ったかを記録すること。\n\n' +
            '- **自分が所有する未付与フォルダ**: アプリへの付与だけが欠けている状態。機構の確認向け\n' +
            '- **他人が所有し、自分に編集者として共有された未付与フォルダ**: 共同研究者が実際に踏む状況。' +
            'こちらが本命\n\n' +
            '2026-08-08 時点では**未実測**（upload-to-ungranted-folder.mjs のように両方測り終えた既成事実は無い）。'
        );
    },
};
