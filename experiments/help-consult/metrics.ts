import type { HelpLanguage, HelpSection } from '../../src/lib/help-consult/types';
import { searchHelpSections } from '../../src/lib/help-consult/search';
import type { JudgeRow, LedgerRow, Provider, Question } from './ledger';

function latest<T extends { key: string }>(items: readonly T[]): T[] {
    return [...new Map(items.map(item => [item.key, item])).values()];
}
export function median(values: readonly number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function hit(question: Question, ids: readonly string[]): boolean {
    return question.expectedSectionIds.some(id => ids.includes(id));
}
export function searchBaseline(questions: readonly Question[], sections: readonly HelpSection[]) {
    const answerable = questions.filter(question => question.answerable);
    const hits = answerable.filter(question => hit(question, searchHelpSections(sections, question.question, 3).map(s => s.id))).length;
    return { hits, total: answerable.length, rate: answerable.length ? hits / answerable.length : null };
}
export function calculateGroup(
    questions: readonly Question[], ledger: readonly LedgerRow[], judges: readonly JudgeRow[],
    provider: Provider, lang: HelpLanguage, version: string
) {
    const expected = questions.filter(question => question.lang === lang);
    const byKey = new Map(expected.map(question => [`${question.id}|${provider}|${version}`, question]));
    const rows = latest(ledger).filter(row => row.provider === provider && row.lang === lang && byKey.has(row.key));
    const grades = new Map(latest(judges).map(judge => [judge.key, judge]));
    const answerableRows = rows.filter(row => byKey.get(row.key)!.answerable);
    const hits = answerableRows.filter(row => row.status === 'success' && hit(byKey.get(row.key)!, row.sectionIds)).length;
    const joined = rows.flatMap(row => {
        const judge = grades.get(row.key);
        return judge ? [{ row, judge, question: byKey.get(row.key)! }] : [];
    });
    const gradedAnswerable = joined.filter(item => item.question.answerable);
    const correctAnswerable = gradedAnswerable.filter(item => item.judge.grade === 'correct').length;
    const count = (grade: JudgeRow['grade']) => joined.filter(item => item.judge.grade === grade).length;
    return {
        executed: rows.length, missing: expected.length - rows.length,
        success: rows.filter(row => row.status === 'success').length,
        noMatch: rows.filter(row => row.status === 'no_match').length,
        invalid: rows.filter(row => row.status === 'failure' && row.kind === 'invalid_response').length,
        hits, selectionTotal: answerableRows.length, selectionRate: answerableRows.length ? hits / answerableRows.length : null,
        unanswerableNoMatch: rows.filter(row => !byKey.get(row.key)!.answerable && row.status === 'no_match').length,
        medianMs: median(rows.map(row => row.latencyMs)), graded: joined.length,
        correct: count('correct'), partial: count('partial'), wrong: count('wrong'), severe: count('severe'),
        gradedAnswerable: gradedAnswerable.length, correctAnswerable,
        accuracy: gradedAnswerable.length ? correctAnswerable / gradedAnswerable.length : null,
        leaks: joined.filter(item => item.judge.leak).length,
    };
}
export function acceptance(group: ReturnType<typeof calculateGroup>, baseline: number | null): string {
    if (group.missing || group.graded !== group.executed || !group.executed) return '採点待ち（未実行・未採点を含む）';
    return group.accuracy !== null && group.accuracy >= 0.9 && group.severe === 0 && group.leaks === 0
        && group.selectionRate !== null && baseline !== null && group.selectionRate >= baseline ? '合格目安を満たす' : '合格目安を満たさない';
}