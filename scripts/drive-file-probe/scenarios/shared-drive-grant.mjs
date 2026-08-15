// シナリオ: 共有ドライブ上のファイルに対する drive.file の付与検証（GitHub Issue #80 フェーズ0）
//
// 共有ドライブ配下のファイルに対して次の3点を測定する。
//   ① Picker が共有ドライブを表示するか（setEnableDrives(true) の有無で比較）
//   ② Picker 選択で drive.file の付与が起きるか
//   ③ 付与後、supportsAllDrives 無しでも読めるのか
//      （＝ src/lib/drive-api.ts の12箇所へのパラメータ付与が本当に必要か）
//
// 「共有ドライブが読めない」原因が (a) drive.file 未付与 なのか (b) supportsAllDrives 等の
// パラメータ欠落 なのかは、現状パラメータが本体に1つも無いため区別できていない。
// このシナリオはパラメータ有り／無しの両方を毎回測ることで、その区別を実測で確定させる。
//
// 手順:
//   1. サインイン
//   2. ベースライン測定（未付与）。フォルダ meta / フォルダ配下 list / ファイル meta / ファイル media を
//      パラメータ有り・無しの両方で計8ターゲット測定
//      → ファイル meta がパラメータ有り・無しのどちらも 404 でなければ中断する
//   3. enableDrives 無しの Picker を開き（allowCancel）、共有ドライブが表示されるかを人間に確認してもらう
//   4. enableDrives: true の Picker で対象PDFを1つだけ選択させ、付与する
//   5. 手順2と同じ8ターゲットを再測定
//   6. 判定表を report.md へ残す

export default {
    id: 'shared-drive-grant',
    title: '共有ドライブ上のファイルへの drive.file 付与と supportsAllDrives の要否',
    inputs: ['folderId', 'fileId'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId, fileId } = ctx.input;

        // フォルダ meta / フォルダ配下 list / ファイル meta / ファイル media を
        // パラメータ有り・無しの両方で測る計8ターゲット。
        const buildTargets = (targetFolderId, targetFileId) => [
            { label: 'フォルダ meta（パラメータ無し）', kind: 'meta', id: targetFolderId },
            { label: 'フォルダ meta（supportsAllDrives）', kind: 'meta', id: targetFolderId, allDrives: true },
            { label: 'フォルダ配下 list（パラメータ無し）', kind: 'list', id: targetFolderId },
            {
                label: 'フォルダ配下 list（supportsAllDrives+includeItemsFromAllDrives）',
                kind: 'list',
                id: targetFolderId,
                allDrives: true,
            },
            { label: 'ファイル meta（パラメータ無し）', kind: 'meta', id: targetFileId },
            { label: 'ファイル meta（supportsAllDrives）', kind: 'meta', id: targetFileId, allDrives: true },
            { label: 'ファイル media（パラメータ無し）', kind: 'media', id: targetFileId },
            { label: 'ファイル media（supportsAllDrives）', kind: 'media', id: targetFileId, allDrives: true },
        ];

        const baseline = await ctx.measure('ベースライン', buildTargets(folderId, fileId));

        const fileMetaNoParam = baseline.find((r) => r.label === 'ファイル meta（パラメータ無し）');
        const fileMetaAllDrives = baseline.find((r) => r.label === 'ファイル meta（supportsAllDrives）');
        // list は権限が無くても 200 + files:[] を返すため、ガードには使わない
        // （既存シナリオと同じ理由。AGENTS.md「実測で確定した挙動」参照）。
        // 404 と 403 はどちらも「未付与」相当として受理する（共有ドライブでは403が返る可能性が
        // 十分にあり、そこで中断すると人間がフィクスチャ作成・認証まで済ませた実行1回分が丸ごと
        // 無駄になるため）。
        const unexpected = [fileMetaNoParam, fileMetaAllDrives].find((r) => r.status !== 404 && r.status !== 403);
        if (unexpected) {
            if (unexpected.ok) {
                ctx.fail(
                    'ファイルのベースラインが 404 ではありません（パラメータ有り・無しの少なくとも一方が 200）。' +
                    '既に付与済みのフィクスチャなので実験が成立しません。README.md の「フィクスチャの作り方」に' +
                    '従い、共有ドライブ上に新しいフォルダ・PDFを Drive UI で作り直してから再実行してください。'
                );
            } else {
                ctx.fail(
                    `404/403 以外の想定外のステータス（${unexpected.status}）が返りました。付与状態を判定できないため` +
                    '中断します。サインインし直すか、フォルダ/ファイルIDが正しいか確認してください。'
                );
            }
        }
        const baselineGot403 = [fileMetaNoParam, fileMetaAllDrives].filter((r) => r.status === 403);
        if (baselineGot403.length > 0) {
            ctx.note(
                '## 注意: ベースラインで403が返ったターゲットがあります\n\n' +
                baselineGot403.map((r) => `- ${r.label}: status=403`).join('\n') +
                '\n\n404と403はどちらも「未付与」相当ですが、実際には403が返っています。判定表を読む際は' +
                'この違いを読み飛ばさないよう注意してください。'
            );
        }
        ctx.note(
            'ファイルのベースラインは想定どおり未付与相当（404 または 403）でした' +
            `（パラメータ無し: status=${fileMetaNoParam.status}、supportsAllDrives有り: status=${fileMetaAllDrives.status}）。` +
            '実験を継続します。'
        );

        ctx.note(
            '本体の Picker はビュー2枚（自分所有 + 共有アイテム）を追加しているが、このハーネスは ' +
            'DocsView 1枚しか使っていない。「共有ドライブが出るか」の観測としては十分だが、Picker の' +
            '見た目そのものの完全な再現ではない点に注意すること。'
        );

        const noEnableDrivesPick = await ctx.pick(
            { mimeTypes: 'application/pdf' },
            'setEnableDrives(true) を呼んでいない、現行仕様相当の Picker です。左メニューに共有ドライブ' +
            '（マイドライブ／共有アイテム以外の項目）が表示されるかを確認してください。**ファイルは選択せず**、' +
            '確認できたらキャンセルしてください。誤って選択すると drive.file の付与が起きてフィクスチャが' +
            '消費されます。',
            { allowCancel: true }
        );

        if (noEnableDrivesPick !== null) {
            ctx.note(
                '想定外: enableDrives 無しの Picker で、キャンセルではなくファイルが選択されました: ' +
                `${JSON.stringify(noEnableDrivesPick)}。誤操作により付与が起きた可能性があります。`
            );
        }

        const sharedDriveVisible = await ctx.ask(
            '共有ドライブは Picker の左メニューに表示されましたか？（はい/いいえ＋気づいたことを一言で）'
        );
        ctx.note(`enableDrives 無しの Picker での確認結果: ${sharedDriveVisible}`);
        ctx.note(
            'この確認は、GitHub Issue #80 で推測されている「setEnableDrives(true) が無いため Picker に' +
            '共有ドライブが出ず、共同研究者が共有ドライブ上のファイルを選択できずに詰む」という仮説の' +
            '実証（または反証）です。'
        );

        // 誤操作で対象ファイルそのものが選ばれていた場合は、それをもって付与とみなし、
        // 本来の enableDrives:true Picker（付与目的）は省略する。
        const accidentallyGranted =
            Array.isArray(noEnableDrivesPick) && noEnableDrivesPick.some((doc) => doc.id === fileId);

        if (accidentallyGranted) {
            ctx.note(
                '誤って選択されたファイルが対象ファイル（fileId）と一致したため、これをもって付与とみなし、' +
                '本来予定していた enableDrives: true の Picker（手順4相当）は省略します。'
            );
        } else {
            if (noEnableDrivesPick !== null) {
                ctx.note(
                    '誤って選択されたファイルは対象ファイル（fileId）とは別物のため、fileId への付与はまだ' +
                    '成立していません。enableDrives: true の Picker を続けて開きます。'
                );
            }

            const grantPick = await ctx.pick(
                { enableDrives: true, mimeTypes: 'application/pdf' },
                `共有ドライブ内の対象PDF（ID: ${fileId}）を1つだけ選択してください。それ以外のファイルを選ぶと` +
                '以降の測定が無意味になります。'
            );
            if (grantPick[0]?.id !== fileId) {
                ctx.fail(
                    `Picker で選択されたファイルID（${grantPick[0]?.id}）が、想定していた対象ファイルID` +
                    `（${fileId}）と一致しません。選択ミスに気づかず進むと以降の測定が全て無意味になるため中断します。`
                );
            }
            ctx.note('enableDrives: true の Picker で対象ファイルを選択しました。付与を再測定で確認します。');
        }

        const afterPick = await ctx.measure('Picker操作後', buildTargets(folderId, fileId));

        // --- 判定1: 付与は起きたか ---
        const fileMetaAllDrivesAfter = afterPick.find((r) => r.label === 'ファイル meta（supportsAllDrives）');
        const grantHappened = !!fileMetaAllDrivesAfter?.ok;
        ctx.note(
            '## 判定1: 付与は起きたか\n\n' +
            `- 付与前: ファイル meta（supportsAllDrives） = ${fileMetaAllDrives.status}（${fileMetaAllDrives.summary}）\n` +
            `- 付与後: ファイル meta（supportsAllDrives） = ${fileMetaAllDrivesAfter.status}` +
            `（${fileMetaAllDrivesAfter.summary}）\n\n` +
            `結論: ${grantHappened ? '404 → 200 に変化しており、付与は起きた。' : '200 になっておらず、付与を確認できなかった。'}`
        );

        // --- 判定2: supportsAllDrives は必須か ---
        const fileMetaNoParamAfter = afterPick.find((r) => r.label === 'ファイル meta（パラメータ無し）');
        const fileMediaNoParamAfter = afterPick.find((r) => r.label === 'ファイル media（パラメータ無し）');
        const fileMediaAllDrivesAfter = afterPick.find((r) => r.label === 'ファイル media（supportsAllDrives）');
        const supportsAllDrivesRequired =
            grantHappened && (!fileMetaNoParamAfter.ok || !fileMediaNoParamAfter.ok);
        ctx.note(
            '## 判定2: supportsAllDrives は必須か\n\n' +
            `- 付与後・パラメータ無し: ファイル meta = ${fileMetaNoParamAfter.status}` +
            `（${fileMetaNoParamAfter.summary}）、ファイル media = ${fileMediaNoParamAfter.status}` +
            `（${fileMediaNoParamAfter.summary}）\n` +
            `- 付与後・supportsAllDrives有り: ファイル meta = ${fileMetaAllDrivesAfter.status}` +
            `（${fileMetaAllDrivesAfter.summary}）、ファイル media = ${fileMediaAllDrivesAfter.status}` +
            `（${fileMediaAllDrivesAfter.summary}）\n\n` +
            `結論: ${
                !grantHappened
                    ? '付与が確認できなかったため判定不能。'
                    : supportsAllDrivesRequired
                        ? 'パラメータ無しでは読めず、supportsAllDrives=true は必須。src/lib/drive-api.ts への' +
                          '追加が要る。'
                        : 'パラメータ無しでも読めており、supportsAllDrives=true は不要（付与さえあれば読める）。'
            }`
        );

        // --- 判定3: 未付与とパラメータ欠落は区別できるか ---
        // エラー理由の文字列はそのまま note に残す（Issue #69 のエラー案内文の設計に直結するため）。
        ctx.note(
            '## 判定3: 未付与とパラメータ欠落は区別できるか\n\n' +
            '| 状態 | status | エラー理由（summary） |\n' +
            '|---|---|---|\n' +
            `| 未付与・パラメータ無し（ベースライン） | ${fileMetaNoParam.status} | \`${fileMetaNoParam.summary}\` |\n` +
            `| 未付与・supportsAllDrives有り（ベースライン） | ${fileMetaAllDrives.status} | \`${fileMetaAllDrives.summary}\` |\n` +
            `| 付与後・パラメータ無し | ${fileMetaNoParamAfter.status} | \`${fileMetaNoParamAfter.summary}\` |\n\n` +
            (supportsAllDrivesRequired
                ? '「未付与・パラメータ無し」と「付与後・パラメータ無し（＝パラメータ欠落だけが理由の失敗）」の' +
                  `status/エラー理由を見比べること: ${
                      fileMetaNoParam.status === fileMetaNoParamAfter.status &&
                      fileMetaNoParam.summary === fileMetaNoParamAfter.summary
                          ? '両者は同一であり、アプリ側からは区別不能。Issue #69 のエラー案内文は' +
                            '「未付与」と「パラメータ欠落」を切り分けて案内できない前提で設計する必要がある。'
                          : '両者に差異がある。差異の内容を確認し、区別できる可能性がある。'
                  }`
                : 'supportsAllDrives が不要という結果のため、この論点は該当しない（パラメータ欠落自体が' +
                  '失敗要因にならない）。')
        );
    },
};
