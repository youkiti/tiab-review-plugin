// シナリオ: 未付与フォルダへのファイル作成検証
//
// 「アプリに drive.file 未付与のフォルダを parents に指定して、ファイルを新規作成できるか」
// を測定する。src/platform/AGENTS.md の「drive.file の 403/404 は『無い』ではなく『このユーザーに未付与』」
// セクションで説明されている、共同研究者がフルテキストPDFをアップロードできない問題の
// 直し方（A案: ゲートを外す / B案: Pickerで再付与フローを足す）を、実測してから決めるための実験。
//
// 手順:
//   1. サインイン
//   2. ベースライン測定（フォルダ meta / フォルダ配下 list）
//      → フォルダ meta が 404 でなければ実験が成立しないため中断する
//   3. 未付与フォルダへファイルを新規作成
//   4. 成功した場合、作成されたファイルの meta・フォルダ meta（再測定）・フォルダ配下 list（再測定）
//      を追加測定し、「本当にそのフォルダの中にできたのか」「親フォルダは付与されたのか」を確認する
//   5. 判定表を report.md へ残す
//   6. このシナリオの測定の限界（自分が所有するフォルダに限る）を明記する

export default {
    id: 'upload-to-ungranted-folder',
    title: '未付与フォルダへファイルを新規作成できるか',
    inputs: ['folderId'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId } = ctx.input;

        const buildTargets = (id) => [
            { label: 'フォルダ meta', kind: 'meta', id },
            { label: 'フォルダ配下 list', kind: 'list', id },
        ];

        const baseline = await ctx.measure('ベースライン', buildTargets(folderId));

        const folderMeta = baseline.find((r) => r.label === 'フォルダ meta');
        // files.list は権限が無くても 200 + files:[] を返すため、ガードには使わない
        // （folder-cascade.mjs と同じ理由。AGENTS.md「実測で確定した挙動」参照）。
        if (folderMeta.status !== 404) {
            if (folderMeta.ok) {
                ctx.fail(
                    'ベースラインが 404 ではありません。このフォルダは既にアプリへ付与済みのため実験が成立しません。' +
                    'Drive UI で新しいフォルダを作り直してから再実行してください。'
                );
            } else {
                ctx.fail(
                    `404 以外の想定外のステータス（${folderMeta.status}）が返りました。付与状態を判定できないため中断します。` +
                    'サインインし直すか、フォルダIDが正しいか確認してください。'
                );
            }
        }
        ctx.note('ベースラインは想定どおり 404（未付与）でした。実験を継続します。');

        // ファイル名の一意化: Date.now() / Math.random() は使わず、人間に短いラベルを尋ねて
        // 組み込む。理由: (1) このハーネスは付与が不可逆な実機実験を前提にしており、
        // folder-cascade.mjs の ctx.ask() と同様、再実行の識別を人間の判断に委ねる設計に
        // 揃えたい。(2) 生成した名前が Drive UI 上でも report.md 上でも一目で見分けられる
        // ほうが、複数回の試行錯誤を後から追いやすい。(3) --input に必須項目を増やすと
        // コマンドラインの毎回の手打ちが増えるため、実行のその場で尋ねる方が扱いやすい。
        const runLabel = await ctx.ask(
            '今回のアップロードを識別する短いラベルを入力してください（例: 01, retry-a）。' +
            'ファイル名は probe-upload-<ラベル>.txt になります。'
        );
        const fileName = `probe-upload-${runLabel}.txt`;

        const uploadResult = await ctx.upload('未付与フォルダへのファイル作成', {
            folderId,
            name: fileName,
            content: 'probe',
        });

        if (!uploadResult.ok) {
            ctx.note(
                `作成は失敗しました（status=${uploadResult.status}）。未付与フォルダへは作成できないという結果です。`
            );
        } else {
            const createdFileId = uploadResult.body?.id;
            ctx.note(`作成に成功しました（id=${createdFileId}, name=${uploadResult.body?.name}）。追加測定を行います。`);

            const followUp = await ctx.measure('作成後の確認', [
                { label: '作成されたファイル meta', kind: 'meta', id: createdFileId },
                { label: 'フォルダ meta（再測定）', kind: 'meta', id: folderId },
                { label: 'フォルダ配下 list（再測定）', kind: 'list', id: folderId },
            ]);

            const createdMeta = followUp.find((r) => r.label === '作成されたファイル meta');
            const parents = createdMeta?.body?.parents ?? [];
            const parentIsTargetFolder = parents.includes(folderId);
            ctx.note(
                `作成されたファイルの parents: ${JSON.stringify(parents)}` +
                `（対象フォルダを含む: ${parentIsTargetFolder ? 'はい' : 'いいえ'}）`
            );

            const folderMetaAfter = followUp.find((r) => r.label === 'フォルダ meta（再測定）');
            ctx.note(
                `作成後のフォルダ meta: status=${folderMetaAfter.status}` +
                (folderMetaAfter.status === 404
                    ? '（作成の副作用では親フォルダは付与されない）'
                    : '（作成の副作用で親フォルダも付与された可能性がある）')
            );
        }

        ctx.note(
            '## 判定の読み方\n\n' +
            '**HTTP ステータスだけで判断しないこと。** parents を必ず確認する。\n\n' +
            '| ファイル作成 | 意味 | 対応 |\n' +
            '|---|---|---|\n' +
            '| 200/201 かつ parents が対象フォルダ | 未付与フォルダにも作成できる | A案: ensureFulltextFolder() のゲートを外す |\n' +
            '| 200/201 だが parents が対象フォルダ以外（マイドライブ直下など） | Drive が指定した親を黙って無視した。**成功に見えるが A案の前提は満たしていない**（PDFがfulltextフォルダの外に散らばる） | B案 |\n' +
            '| 403/404 | 作成にも付与が必要 | B案: Picker にフォルダ選択を足して再付与する |'
        );

        ctx.note(
            '## 結果の解釈には、対象フォルダを誰が所有しているかが要る\n\n' +
            'このシナリオは対象フォルダの所有者を判別しない（未付与なので meta が読めず、所有者を取得できない）。' +
            '実行者はどちらのフィクスチャを使ったかを記録すること。意味が変わる。\n\n' +
            '- **自分が所有する未付与フォルダ**: アプリへの付与だけが欠けている状態。機構の確認向け\n' +
            '- **他人が所有し、自分に編集者として共有された未付与フォルダ**: 共同研究者が実際に踏む状況。こちらが本命\n\n' +
            '2026-08-08 時点で**両方とも実測済み**。いずれも作成に成功し、parents も尊重され、' +
            '作成の副作用で親フォルダが付与されることは無かった（詳細は Issue #60 / PR #66）。'
        );
    },
};
