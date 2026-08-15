// シナリオ: 共有ドライブ配下の files.list 検証（GitHub Issue #80 フェーズ0）
//
// 本体の listAccessibleFileIdsInFolder()（src/lib/drive-api.ts:689）に相当する
// 「フォルダ配下の付与済みファイル一覧」が共有ドライブで機能するか、機能するには
// どのパラメータが要るかを測定する。この関数は「このユーザーが実際に読めるファイル」を
// 知る唯一の経路であり、再付与機能（fulltext-regrant.ts）の検知がこれに乗っているため重要。
//
// 手順:
//   1. サインイン
//   2. fileIds（カンマ区切り3件）をパース。3件でなければ中断
//   3. ベースライン測定: フォルダ配下 list をパラメータ有り／無しの両方、
//      および3ファイルそれぞれの meta（パラメータ有り）
//      → 3ファイルの meta が全て 404 でなければ中断する
//   4. enableDrives: true の Picker を複数選択で開き、3本のうち2本だけを選ばせる
//      （残り1本は「付与していないファイルが list に出てこないこと」の対照）
//      → 選択されたIDの集合が指示した2本と一致しなければ中断する
//   5. 選択した1本の meta（パラメータ有り）から driveId を取得する
//      （取れなければ以降の corpora=drive 測定はスキップ）
//   6. 再測定: フォルダ配下 list を
//      ①パラメータ無し ②supportsAllDrives+includeItemsFromAllDrives
//      ③②に加えて corpora=drive&driveId=... の3通り
//   7. 判定表を report.md へ残す

export default {
    id: 'shared-drive-list',
    title: '共有ドライブ配下フォルダの files.list（付与済みファイル一覧）検証',
    inputs: ['folderId', 'fileIds'],
    async run(ctx) {
        await ctx.signIn();

        const { folderId } = ctx.input;
        const fileIds = ctx.input.fileIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (fileIds.length !== 3) {
            ctx.fail(
                `--input fileIds には未付与PDFのIDを3件、カンマ区切りで指定してください` +
                `（現在 ${fileIds.length} 件: ${JSON.stringify(fileIds)}）。`
            );
        }

        // 選ばせる2本と、対照として選ばせない1本を固定する。
        const [selectId1, selectId2, excludedId] = fileIds;

        const baselineTargets = [
            { label: 'フォルダ配下 list（パラメータ無し）', kind: 'list', id: folderId },
            {
                label: 'フォルダ配下 list（supportsAllDrives+includeItemsFromAllDrives）',
                kind: 'list',
                id: folderId,
                allDrives: true,
            },
            { label: `ファイル1 meta（supportsAllDrives） [${selectId1}]`, kind: 'meta', id: selectId1, allDrives: true },
            { label: `ファイル2 meta（supportsAllDrives） [${selectId2}]`, kind: 'meta', id: selectId2, allDrives: true },
            { label: `ファイル3 meta（supportsAllDrives） [${excludedId}]`, kind: 'meta', id: excludedId, allDrives: true },
        ];
        const baseline = await ctx.measure('ベースライン', baselineTargets);

        const fileMetas = baseline.filter((r) => r.kind === 'meta');
        // 404 と 403 はどちらも「未付与」相当として受理する（共有ドライブでは403が返る可能性が
        // 十分にあり、そこで中断すると人間がフィクスチャ作成・認証まで済ませた実行1回分が丸ごと
        // 無駄になるため）。
        const unexpected = fileMetas.find((r) => r.status !== 404 && r.status !== 403);
        if (unexpected) {
            if (unexpected.ok) {
                ctx.fail(
                    `ファイル（${unexpected.id}）のベースラインが 404 ではありません。既に付与済みのフィクスチャ` +
                    'なので実験が成立しません。README.md の「フィクスチャの作り方」に従い、共有ドライブ上に' +
                    '新しいフォルダ・PDFを Drive UI で作り直してから再実行してください。'
                );
            } else {
                ctx.fail(
                    `404/403 以外の想定外のステータス（${unexpected.status}、ファイルID=${unexpected.id}）が返りました。` +
                    '付与状態を判定できないため中断します。サインインし直すか、fileIds が正しいか確認してください。'
                );
            }
        }
        const baselineGot403 = fileMetas.filter((r) => r.status === 403);
        if (baselineGot403.length > 0) {
            ctx.note(
                '## 注意: ベースラインで403が返ったターゲットがあります\n\n' +
                baselineGot403.map((r) => `- ${r.label}: status=403`).join('\n') +
                '\n\n404と403はどちらも「未付与」相当ですが、実際には403が返っています。判定表を読む際は' +
                'この違いを読み飛ばさないよう注意してください。'
            );
        }
        ctx.note(
            '3ファイルのベースラインはいずれも想定どおり未付与相当（404 または 403）でした（' +
            fileMetas.map((r) => `${r.label}: status=${r.status}`).join('、') +
            '）。実験を継続します。'
        );

        const pickResult = await ctx.pick(
            { enableDrives: true, multiSelect: true, mimeTypes: 'application/pdf' },
            '共有ドライブ内の対象フォルダから、次の2本の PDF だけを選択してください' +
            '（Ctrl/Cmd キーを押しながらクリックすると複数選択できます）。\n' +
            `- 1本目（ID: ${selectId1}）\n- 2本目（ID: ${selectId2}）\n\n` +
            `3本目（ID: ${excludedId}）は選ばないでください。これは「付与していないファイルが list に` +
            '出てこないこと」を確認するための対照です。'
        );

        const pickedIds = new Set((pickResult || []).map((doc) => doc.id));
        const expectedIds = new Set([selectId1, selectId2]);
        const idsMatch =
            pickedIds.size === expectedIds.size && [...expectedIds].every((id) => pickedIds.has(id));
        if (!idsMatch) {
            ctx.fail(
                `Picker で選択されたファイルID集合（${JSON.stringify([...pickedIds])}）が、` +
                `指定した2本（${JSON.stringify([...expectedIds])}）と一致しません。選択ミスに気づかず進むと` +
                '以降の測定が全て無意味になるため中断します。'
            );
        }
        ctx.note('指示どおり2本だけが選択されたことを確認しました。');

        const driveIdProbe = await ctx.measure('driveId 取得用の再測定', [
            {
                label: `ファイル1 meta（再測定、supportsAllDrives） [${selectId1}]`,
                kind: 'meta',
                id: selectId1,
                allDrives: true,
            },
        ]);
        const driveId = driveIdProbe[0]?.body?.driveId;
        if (!driveId) {
            ctx.note(
                '選択したファイルの meta から driveId を取得できませんでした（付与が成立していないか、' +
                'meta 自体に driveId が含まれていません）。以降の corpora=drive 測定はスキップします。'
            );
        } else {
            ctx.note(`driveId を取得しました: ${driveId}。以降 corpora=drive 付きの list も測定します。`);
        }

        const listTargets = [
            { label: 'フォルダ配下 list（①パラメータ無し）', kind: 'list', id: folderId },
            {
                label: 'フォルダ配下 list（②supportsAllDrives+includeItemsFromAllDrives）',
                kind: 'list',
                id: folderId,
                allDrives: true,
            },
        ];
        if (driveId) {
            listTargets.push({
                label: 'フォルダ配下 list（③②に加え corpora=drive&driveId）',
                kind: 'list',
                id: folderId,
                allDrives: true,
                driveId,
            });
        }
        const afterPick = await ctx.measure('Picker選択後の再測定', listTargets);

        // --- 判定: 件数・混入チェック ---
        const rows = afterPick.map((r) => {
            if (!r.ok) {
                return `| ${r.label} | 失敗（status=${r.status}） | \`${r.summary}\` | - | - |`;
            }
            const ids = (r.body?.files || []).map((f) => f.id);
            const containsBoth = ids.includes(selectId1) && ids.includes(selectId2);
            const containsExcluded = ids.includes(excludedId);
            return (
                `| ${r.label} | ${ids.length}件 | ${JSON.stringify(ids)} | ` +
                `選択2本を両方含む: ${containsBoth ? 'はい' : 'いいえ'} | ` +
                `対照（未選択）を含む: ${containsExcluded ? 'はい（混入）' : 'いいえ'} |`
            );
        });

        ctx.note(
            '## 判定: 共有ドライブ配下の files.list に何が要るか\n\n' +
            '| 測定 | 件数/結果 | 返ってきたID | 選択2本の有無 | 混入の有無 |\n' +
            '|---|---|---|---|---|\n' +
            rows.join('\n') +
            '\n\n' +
            '**0件は権限不足でも正常応答として返る（既存の知見）ため、「0件」を「フォルダが空」と' +
            '解釈してはいけない。** 件数が正しく 2 になった行が、共有ドライブ配下の files.list に' +
            '最低限必要なパラメータの組み合わせである。3本目（対照）が混入している行があれば、' +
            'その組み合わせは付与範囲を正しく反映していないことになる。'
        );
    },
};
