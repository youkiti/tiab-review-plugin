// 公開物の README.md・METHODS.md の雛形（Issue #307）。コミットの SHA・作成日・レポートの見出しを差し込む。

export const REPO_URL = 'https://github.com/youkiti/tiab-review-plugin';

/** README.md の「評価の限界」の6項目（リポジトリの README.md の「評価の限界」節の英訳）。 */
export const LIMITATIONS_EN = [
    'These evaluations were run by the developer; there is no independent third-party validation yet.',
    'The primary dataset (depression) is a preclinical systematic review (animal models of depression). CQ1 to CQ5 come from systematic reviews for Japanese clinical practice guidelines. Abstracts are almost all in English; performance in other fields and languages has not been checked.',
    'The depression dataset was also used to tune the conditions, so its results may be optimistic.',
    'The evaluation data are published systematic reviews, so the models may have seen these papers or decisions during training (data contamination), which can inflate performance.',
    'The external validation (22 TITAN-SR reviews) used jev-1.13.0; jev-1.14.0, which the app now uses, has not been externally validated.',
    'Performance may change when providers update their models; gemini-3-flash-preview in particular is a preview model.',
];

const LIMITATIONS_JA = [
    '評価は開発者自身によるもので、第三者による独立した検証はまだありません。',
    '主指標の depression データセットは前臨床の系統的レビュー（うつ病の動物モデル）です。CQ1〜5 は日本の診療ガイドライン作成のための系統的レビュー由来です。抄録はほぼ英語で、他の分野・言語での性能は確かめていません。',
    'depression は条件の調整にも使ったため、その値は楽観的になりえます。',
    '評価データは公開済みの系統的レビューなので、LLM が学習の段階でこれらの論文や判定を見ている可能性があり（データの汚染）、性能が高めに出ることがあります。',
    '外部検証（TITAN-SR の22レビュー）は jev-1.13.0 で行いました。アプリが今使う jev-1.14.0 での外部検証はまだありません。',
    'モデルの提供元が更新すると性能は変わりえます。とくに gemini-3-flash-preview は preview 版です。',
];

/**
 * @param {{ sha: string, date: string, dirs: string[], skipped: string[], labelDatasets: string[], b4Included: boolean }} ctx
 */
export function renderReadme(ctx) {
    const list = (items) => items.map((item) => `- ${item}`).join('\n');
    const labels = ctx.labelDatasets.length
        ? `\`labels/<dataset>.csv\` (columns \`id,label_included\`) for the datasets whose license permits redistribution: ${ctx.labelDatasets.join(', ')}.`
        : 'No label tables are included in this version (redistribution of each source dataset could not be confirmed; see SOURCES.md).';
    const b4 = ctx.b4Included
        ? ''
        : '\n- The original decisions of the main-table row B4 (`gemini-3-flash-preview`, depression Recall 96.1%) are not published (only the aggregate values in the report).';
    return `# TiAb Review: developer-run evaluation results of AI title/abstract and full-text screening

Version ${ctx.date}. Generated from commit \`${ctx.sha}\` of ${REPO_URL}

## What this is

Raw results and reports of the evaluations the TiAb Review developer ran to choose the AI models bundled with the extension. Each directory of \`experiments/\` in the repository is one zip file here; paths inside a zip are the same as in the repository at the commit above. \`manifest.csv\` lists every file with its size and SHA-256. \`METHODS.md\` points to the report of each directory.

Included zip files:

${list(ctx.dirs.map((d) => `\`${d}.zip\``))}

${labels}

## Limitations

${list(LIMITATIONS_EN)}

## What is not included

- Titles, abstracts and full texts of any dataset.
- Label tables of datasets whose redistribution could not be confirmed.
- \`evidence[].quote\` (verbatim excerpts of abstracts) in the results of the Gemini models and others. Only \`field\`, \`start_char\` and \`end_char\` are kept, so people who hold the source data can recover the excerpts from the positions.${b4}
- Evaluations that are not accuracy evaluations of AI screening, and simple trials not listed in the repository README: ${ctx.skipped.length ? ctx.skipped.map((d) => `\`${d}\``).join(', ') : 'none'}.

## How to reproduce

1. Obtain the source datasets as described in \`SOURCES.md\` (DOI, license, how record ids are built).
2. Check out the commit above and run the runner in \`experiments/<directory>/\` (see each \`plan.md\` and \`report.md\`).
3. Record ids in the results (\`ref_id\`, \`id\`) correspond to the ids built by \`scripts/asreview-baseline/generate_datasets.py\` in the repository.

## License

Results and reports: CC BY 4.0. Code in the zip files: MIT (same as the LICENSE of the repository). Label tables follow the license of each source dataset (SOURCES.md).

---

# 日本語の説明

TiAb Review の開発者が、同梱する AI モデルを選ぶために行った評価の生の結果とレポートです（版 ${ctx.date}、コミット \`${ctx.sha}\`）。\`experiments/\` のディレクトリごとに 1 つの zip にしてあり、zip の中のパスはリポジトリのものと同じです。

## 評価の限界

${list(LIMITATIONS_JA)}

## 含まないもの

題名・抄録・全文、再配布を確かめられなかったデータセットのラベル、\`evidence[].quote\`（抄録の原文の抜粋。文字位置だけ残してあります）。${ctx.b4Included ? '' : '主表の B4（`gemini-3-flash-preview`）の元の判定結果は公開していません（レポートの集計値のみ）。'}
`;
}

/**
 * @param {{ sha: string, date: string, entries: { dir: string, reportPath: string|null, headings: string[], files: number, resultFiles: number, models: string[], datasets: string[], dates: string[] }[] }} ctx
 */
export function renderMethods(ctx) {
    const blocks = ctx.entries.map((entry) => {
        const link = entry.reportPath ? `${REPO_URL}/blob/${ctx.sha}/${entry.reportPath}` : '(no report.md)';
        const range = entry.dates.length ? (entry.dates.length === 1 ? entry.dates[0] : `${entry.dates[0]} to ${entry.dates[entry.dates.length - 1]}`) : '';
        const lines = [
            `## ${entry.dir}`,
            '',
            `- Report: ${link}`,
            `- Files: ${entry.files} (result files: ${entry.resultFiles})`,
            `- Datasets: ${entry.datasets.join(', ') || 'see report'}`,
            `- Models: ${entry.models.join(', ') || 'see report'}`,
            `- Run dates: ${range || 'see report'}`,
            '- Thresholds and conditions: see the sections of the report listed below',
        ];
        if (entry.headings.length) {
            lines.push('', 'Report headings:', '', ...entry.headings.map((h) => `- ${h}`));
        }
        return lines.join('\n');
    });
    return `# Methods index

Version ${ctx.date}, commit \`${ctx.sha}\` of ${REPO_URL}.

Each section points to the report of one directory (links are fixed to the commit). Datasets, models and run dates are read from file names and file contents; thresholds, sample sizes and conditions are in the reports.

${blocks.join('\n\n')}
`;
}
