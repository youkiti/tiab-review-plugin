// 採点役に渡す資料を、台帳・問題集・小節の本文から社ごとに組み立てる。
// 出力: results/judge_input_<provider>_<ledgerVersion>.json（採点役はこれだけを読む。API キーは含まない）
import fs from 'fs';
import path from 'path';
import { isLedgerRow, loadConfig, loadQuestions, loadSections, readJsonLines, resultPath } from './ledger';
import type { Provider } from './ledger';

function main(): void {
    const config = loadConfig();
    const questions = loadQuestions();
    const sections = loadSections();
    for (const provider of config.providers as Provider[]) {
        const rows = readJsonLines(resultPath(config, provider, false), isLedgerRow);
        const items = questions.flatMap(question => {
            const row = rows.get(`${question.id}|${provider}|${config.ledgerVersion}`);
            if (!row) {
                return [];
            }
            const byId = new Map(sections[question.lang].map(section => [section.id, section]));
            const selected = row.status === 'success' ? row.sectionIds : [];
            return [{
                key: row.key,
                questionId: question.id,
                lang: question.lang,
                category: question.category,
                answerable: question.answerable,
                question: question.question,
                keyFacts: question.keyFacts,
                mustNot: question.mustNot ?? [],
                status: row.status === 'failure' ? `failure:${row.kind}` : row.status,
                answer: row.status === 'success' ? row.answer : null,
                selectedSections: selected.map(id => {
                    const section = byId.get(id);
                    return { id, title: section?.title ?? '', body: section?.body ?? '' };
                }),
            }];
        });
        const file = path.join(__dirname, 'results', `judge_input_${provider}_${config.ledgerVersion}.json`);
        fs.writeFileSync(file, JSON.stringify(items, null, 1) + '\n', 'utf8');
        console.log(`${provider}: ${items.length} 件を ${path.basename(file)} に書いた`);
    }
}

main();
