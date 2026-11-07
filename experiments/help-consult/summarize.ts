import fs from 'fs';
import path from 'path';
import { acceptance, calculateGroup, searchBaseline } from './metrics';
import { configHash, EvaluationError, isJudgeRow, isLedgerRow, loadConfig, loadQuestions, loadSections,
    readJsonLines, resultPath, rowKey } from './ledger';

function main(): void {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--fake')) throw new EvaluationError('引数は --fake のみ指定できます。');
    const fake = args.includes('--fake'), config = loadConfig(), questions = loadQuestions(), sections = loadSections();
    const lines = ['# ヘルプ相談の評価集計', '',
        '選択的中率の分母は実行済みの答えのある問い（no_match・invalid_response も含む）。正答率の分母は採点済みの答えのある問い。',
        '中央値は再試行と待機を含む問い全体の時間。未実行・未採点がある結果は暫定。', '',
        '| 言語 | 検索のみの的中数 / 答えのある問い | 的中率 |', '|---|---:|---:|'];
    const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
    const baselines = { ja: searchBaseline(questions.filter(q => q.lang === 'ja'), sections.ja),
        en: searchBaseline(questions.filter(q => q.lang === 'en'), sections.en) };
    for (const lang of ['ja', 'en'] as const) {
        const baseline = baselines[lang];
        lines.push(`| ${lang} | ${baseline.hits} / ${baseline.total} | ${percent(baseline.rate)} |`);
    }
    lines.push('', '| 社 | 言語 | 実行済み | success | no_match | invalid_response | 小節の選択的中率 | 答えなしの no_match | 中央値 ms | 正しい | 不十分 | 誤り | 重大な誤り | 正答率 | 漏えい |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const notes: string[] = [];
    for (const provider of config.providers) {
        const rows = [...readJsonLines(resultPath(config, provider, fake), isLedgerRow, configHash(provider)).values()];
        const judgeFile = resultPath(config, provider, fake, true);
        const judges = [...readJsonLines(judgeFile, isJudgeRow).values()];
        const expectedKeys = new Set(questions.map(q => rowKey(q, provider, config.ledgerVersion)));
        const unknown = rows.filter(row => !expectedKeys.has(row.key) || row.provider !== provider
            || !questions.some(q => q.id === row.questionId && q.lang === row.lang && row.key === rowKey(q, provider, config.ledgerVersion))).length;
        const known = rows.filter(row => expectedKeys.has(row.key) && row.provider === provider
            && questions.some(q => q.id === row.questionId && q.lang === row.lang && row.key === rowKey(q, provider, config.ledgerVersion)));
        const knownKeys = new Set(known.map(row => row.key));
        notes.push(`${provider}: 問題集にない行（属性不一致を含む） ${unknown} 件、台帳にない問い ${questions.length - known.length} 件、結合できない採点 ${judges.filter(j => !knownKeys.has(j.key)).length} 件。`);
        for (const lang of ['ja', 'en'] as const) {
            const group = calculateGroup(questions, known, judges, provider, lang, config.ledgerVersion);
            const grade = (value: number) => group.graded ? String(value) : '採点待ち';
            lines.push(`| ${provider} | ${lang} | ${group.executed} | ${group.success} | ${group.noMatch} | ${group.invalid} | ${percent(group.selectionRate)} (${group.hits}/${group.selectionTotal}) | ${group.unanswerableNoMatch} | ${group.medianMs ?? '—'} | ${grade(group.correct)} | ${grade(group.partial)} | ${grade(group.wrong)} | ${grade(group.severe)} | ${group.gradedAnswerable ? percent(group.accuracy) : '採点待ち'} | ${grade(group.leaks)} |`);
            notes.push(`${provider} / ${lang}: ${acceptance(group, baselines[lang].rate)}（実行 ${group.executed} 件、未実行 ${group.missing} 件、採点済み ${group.graded} 件）。`);
        }
        if (!fs.existsSync(judgeFile)) notes.push(`${provider}: 採点待ち（採点ファイルなし）。`);
    }
    lines.push('', ...notes, '', '元データ: [問題集](../questions.json)、[ヘルプ](../../../docs/help.html)。',
        '実装: [実行](../run.ts)、[集計](../summarize.ts)、[指標](../metrics.ts)。', '');
    const markdown = lines.join('\n');
    const directory = path.join(__dirname, 'results');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `summary_${fake ? 'fake_' : ''}${config.ledgerVersion}.md`), markdown, 'utf8');
    console.log(markdown);
}
main();