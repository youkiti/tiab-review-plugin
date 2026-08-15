// シナリオ: 共有ドライブ配下フォルダへの書き込み検証（GitHub Issue #80 フェーズ0）
//
// 既存の upload-to-ungranted-folder / copy-to-ungranted-folder で確定している
// 「未付与フォルダを parents に指定してファイルを作成／複製できる」という性質が、
// 共有ドライブ配下のフォルダでも成り立つかを測定する。共同研究者のPDFアップロードと
// 取り込み機能の両方がこの性質に乗っているため、成り立たなければ共有ドライブ対応そのものが
// 成立しない。
//
// 手順:
//   1. サインイン
//   2. ベースライン測定: フォルダ meta（パラメータ有り／無し）、コピー元ファイル meta
//      → フォルダ meta が両方 404、コピー元 meta も 404 でなければ中断する
//   3. Picker（enableDrives は不要。コピー元はマイドライブ上のため）でコピー元PDFを選択させ、
//      ID一致をガード。再測定で 200 になったことを確認する（ならなければ中断）
//   4. ラベルを聞き取る
//   5. 次の4通りを順に実行する。各書き込みの直後にフォルダ meta を再測定し、
//      404 のままであることを確認する（200 に変わっていたら中断する）
//      - files.create: supportsAllDrives 無し
//      - files.create: supportsAllDrives 有り
//      - files.copy: supportsAllDrives 無し
//      - files.copy: supportsAllDrives 有り
//   6. 成功した書き込みについて、作成されたファイルの files.get（パラメータ有り）で
//      parents を取り直し、指定した共有ドライブフォルダが親になっているかを検証する
//   7. 判定表を report.md へ残す

export default {
    id: 'shared-drive-write',
    title: '共有ドライブ配下フォルダへの files.create / files.copy 書き込み検証',
    inputs: ['folderId', 'sourceFileId'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId, sourceFileId } = ctx.input;

        const baseline = await ctx.measure('ベースライン', [
            { label: '共有ドライブフォルダ meta（パラメータ無し）', kind: 'meta', id: folderId },
            { label: '共有ドライブフォルダ meta（supportsAllDrives）', kind: 'meta', id: folderId, allDrives: true },
            { label: 'コピー元ファイル meta', kind: 'meta', id: sourceFileId },
        ]);

        const folderMetaNoParam = baseline.find((r) => r.label === '共有ドライブフォルダ meta（パラメータ無し）');
        const folderMetaAllDrives = baseline.find((r) => r.label === '共有ドライブフォルダ meta（supportsAllDrives）');
        const sourceMeta = baseline.find((r) => r.label === 'コピー元ファイル meta');
        // 404 と 403 はどちらも「未付与」相当として受理する（共有ドライブでは403が返る可能性が
        // 十分にあり、そこで中断すると人間がフィクスチャ作成・認証まで済ませた実行1回分が丸ごと
        // 無駄になるため）。
        const unexpected = [folderMetaNoParam, folderMetaAllDrives, sourceMeta].find(
            (r) => r.status !== 404 && r.status !== 403
        );
        if (unexpected) {
            if (unexpected.ok) {
                ctx.fail(
                    'ベースラインが 404 ではありません（フォルダまたはコピー元ファイルの少なくとも一方が既に' +
                    '付与済み）。実験が成立しないため、README.md の「フィクスチャの作り方」に従い、' +
                    '共有ドライブ上に空フォルダを、マイドライブに未付与PDFを Drive UI で作り直してから' +
                    '再実行してください。'
                );
            } else {
                ctx.fail(
                    `404/403 以外の想定外のステータス（${unexpected.status}）が返りました。付与状態を判定できないため` +
                    '中断します。サインインし直すか、folderId/sourceFileId が正しいか確認してください。'
                );
            }
        }
        const baselineGot403 = [folderMetaNoParam, folderMetaAllDrives, sourceMeta].filter((r) => r.status === 403);
        if (baselineGot403.length > 0) {
            ctx.note(
                '## 注意: ベースラインで403が返ったターゲットがあります\n\n' +
                baselineGot403.map((r) => `- ${r.label}: status=403`).join('\n') +
                '\n\n404と403はどちらも「未付与」相当ですが、実際には403が返っています。判定表を読む際は' +
                'この違いを読み飛ばさないよう注意してください。'
            );
        }
        ctx.note(
            'フォルダ・コピー元ファイルのベースラインはいずれも想定どおり未付与相当（404 または 403）でした（' +
            `${folderMetaNoParam.label}: status=${folderMetaNoParam.status}、` +
            `${folderMetaAllDrives.label}: status=${folderMetaAllDrives.status}、` +
            `${sourceMeta.label}: status=${sourceMeta.status}）。実験を継続します。`
        );

        const pickResult = await ctx.pick(
            { mimeTypes: 'application/pdf' },
            `コピー元ファイル（ID: ${sourceFileId}、マイドライブ上）を Picker で1つだけ選択してください。` +
            'それ以外のファイルを選ぶと以降の測定が無意味になります。'
        );
        if (pickResult[0]?.id !== sourceFileId) {
            ctx.fail(
                `Picker で選択されたファイルID（${pickResult[0]?.id}）が、想定していたコピー元ファイルID` +
                `（${sourceFileId}）と一致しません。選択ミスに気づかず進むと以降の測定が全て無意味になるため中断します。`
            );
        }

        const afterPick = await ctx.measure('Picker選択後', [
            { label: 'コピー元ファイル meta（再測定）', kind: 'meta', id: sourceFileId },
        ]);
        if (!afterPick[0].ok) {
            ctx.fail(
                'Picker で選択したはずのコピー元ファイルが、再測定でも 200 になりません' +
                `（status=${afterPick[0].status}）。付与が成立していない状態で書き込みを撃つと、失敗原因を` +
                '切り分けられなくなるため中断します。'
            );
        }
        ctx.note('Picker によるコピー元ファイルへの付与を確認しました。書き込みを実行します。');

        const runLabel = await ctx.ask(
            '今回の run を識別する短いラベルを入力してください（例: 01, retry-a）。' +
            'ファイル名は probe-sd-create-nosad-<ラベル>.pdf 等になります。'
        );

        /**
         * 書き込み直後にフォルダ meta（パラメータ無し・supportsAllDrives有りの両方）を再測定し、
         * 未付与のままであることを確認する。200 に変わっていたら「書き込みの副作用で親フォルダが
         * 付与された」ことになり、以降の測定が汚染されるため、note に明記した上で中断する。
         *
         * 判定には supportsAllDrives: true の結果だけを使う。共有ドライブではパラメータ無しの404は
         * 付与の有無を証明しない（supportsAllDrivesを付けなければ、付与済みでも404を返しうるため）。
         * パラメータ無しの結果は判定には使わないが、ctx.measure に含めて report.md には残す。
         * 404・403 はどちらも「未付与」相当として受理する（修正2のベースライン判定と条件を揃える）。
         */
        async function checkFolderStillUngranted(afterLabel) {
            const check = await ctx.measure(`${afterLabel} 直後の確認`, [
                { label: '共有ドライブフォルダ meta（パラメータ無し・再測定）', kind: 'meta', id: folderId },
                {
                    label: '共有ドライブフォルダ meta（supportsAllDrives・再測定）',
                    kind: 'meta',
                    id: folderId,
                    allDrives: true,
                },
            ]);
            const allDrivesResult = check.find((r) => r.allDrives);
            if (allDrivesResult.status !== 404 && allDrivesResult.status !== 403) {
                ctx.fail(
                    `${afterLabel} の直後、フォルダ meta（supportsAllDrives）が未付与相当（404/403）のままでは` +
                    `ありません（status=${allDrivesResult.status}）。書き込みの副作用で親フォルダが付与された` +
                    '可能性があり、以降の測定が汚染されるため中断します。'
                );
            }
        }

        const createNoSad = await ctx.upload('files.create（supportsAllDrivesなし）', {
            folderId,
            name: `probe-sd-create-nosad-${runLabel}.pdf`,
            content: 'probe',
        });
        await checkFolderStillUngranted('files.create（supportsAllDrivesなし）');

        const createSad = await ctx.upload('files.create（supportsAllDrivesあり）', {
            folderId,
            name: `probe-sd-create-sad-${runLabel}.pdf`,
            content: 'probe',
            allDrives: true,
        });
        await checkFolderStillUngranted('files.create（supportsAllDrivesあり）');

        const copyNoSad = await ctx.copy('files.copy（supportsAllDrivesなし）', {
            sourceFileId,
            folderId,
            name: `probe-sd-copy-nosad-${runLabel}.pdf`,
        });
        await checkFolderStillUngranted('files.copy（supportsAllDrivesなし）');

        const copySad = await ctx.copy('files.copy（supportsAllDrivesあり）', {
            sourceFileId,
            folderId,
            name: `probe-sd-copy-sad-${runLabel}.pdf`,
            allDrives: true,
        });
        await checkFolderStillUngranted('files.copy（supportsAllDrivesあり）');

        // 成功した書き込みについて、files.get（真値として採用。files.create/copy レスポンスの
        // parents はリクエスト内容の反映にすぎない可能性があるため）で parents を取り直す。
        // copy-to-ungranted-folder.mjs と同じ方針。
        async function verifyPlacement(label, result) {
            if (!result.ok) {
                return `| ${label} | 失敗（status=${result.status}） | - | - |`;
            }
            const createdId = result.body?.id;
            const got = await ctx.measure(`${label} 作成後の files.get`, [
                { label: `${label}: 作成されたファイル meta（supportsAllDrives）`, kind: 'meta', id: createdId, allDrives: true },
            ]);
            const meta = got[0];
            if (!meta.ok) {
                return `| ${label} | 成功（status=${result.status}） | files.get 失敗（status=${meta.status}）のため未検証 | - |`;
            }
            const parents = meta.body?.parents ?? [];
            const parentIsTarget = parents.includes(folderId);
            return (
                `| ${label} | 成功（status=${result.status}） | ${JSON.stringify(parents)} | ` +
                `${parentIsTarget ? '対象フォルダに配置された' : '**対象フォルダの外へ散らばった（最悪ケース）**'} |`
            );
        }

        const rows = [
            await verifyPlacement('files.create（supportsAllDrivesなし）', createNoSad),
            await verifyPlacement('files.create（supportsAllDrivesあり）', createSad),
            await verifyPlacement('files.copy（supportsAllDrivesなし）', copyNoSad),
            await verifyPlacement('files.copy（supportsAllDrivesあり）', copySad),
        ];

        ctx.note(
            '## 判定の読み方\n\n' +
            '**HTTP ステータスだけで判断しないこと。** files.get で取り直した parents を必ず確認する。\n\n' +
            '| 書き込み | 結果 | files.get の parents | 配置の判定 |\n' +
            '|---|---|---|---|\n' +
            rows.join('\n') +
            '\n\n' +
            '「200 だが親がマイドライブ直下などに逃げている」場合は、**成功に見えて PDF が散らばる' +
            '最悪ケース**である。この行が1つでもあれば、対応する supportsAllDrives の有無だけでは' +
            '不十分であり、書き込み後に files.get で parents を検証して失敗扱いにする等の対策が要る。'
        );

        ctx.note(
            '## この測定の前提\n\n' +
            'コピー先フォルダは共有ドライブ上の**空の**未付与フォルダ、コピー元PDFは**マイドライブ上の**' +
            '未付与PDFという前提で実施した。フォルダの所有者（共有ドライブのメンバー種別）は判別できない' +
            '（未付与なので meta が読めない場合がある）ため、実行者はどのロール（コンテンツ管理者/投稿者等）' +
            'で共有ドライブに参加していたかを別途記録すること。'
        );
    },
};
