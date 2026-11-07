import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { ConsultResult, HelpLanguage, HelpSection } from '../../src/lib/help-consult/types';
import { CONSULT_MODELS } from '../../src/lib/help-consult/model';

export type Provider = 'gemini' | 'openai' | 'openrouter';
export interface Config {
    ledgerVersion: string; providers: Provider[]; timeoutMs: number; smokeCount: number;
    retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
}
export interface Question {
    id: string; lang: HelpLanguage; category: string; question: string;
    expectedSectionIds: string[]; answerable: boolean; keyFacts: string[]; mustNot?: string[];
}
export type LedgerRow = ConsultResult & {
    key: string; questionId: string; lang: HelpLanguage; provider: Provider; model: string;
    latencyMs: number; configHash: string; at: string;
};
export interface JudgeRow {
    key: string; grade: 'correct' | 'partial' | 'wrong' | 'severe'; leak: boolean; note: string;
}
export class EvaluationError extends Error {}
export const root = path.resolve(__dirname, '../..');
export function readJson(file: string): any {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
export function loadConfig(): Config { return readJson(path.join(__dirname, 'config.json')); }
export function loadQuestions(): Question[] { return readJson(path.join(__dirname, 'questions.json')).questions; }
export function loadSections(): Record<HelpLanguage, HelpSection[]> {
    const { parseHelpSections } = require('../../scripts/webpack/help-sections.cjs');
    const html = fs.readFileSync(path.join(root, 'docs/help.html'), 'utf8');
    return { ja: parseHelpSections(html, 'ja'), en: parseHelpSections(html, 'en') };
}
export function configHash(provider: Provider): string {
    const files = ['src/lib/help-consult/prompt.ts', 'src/lib/help-consult/consult.ts',
        'src/lib/help-consult/model.ts', 'docs/help.html'];
    const contents = files.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n'));
    return createHash('sha256').update(JSON.stringify([...contents, CONSULT_MODELS[provider]])).digest('hex');
}
export function resultPath(config: Config, provider: Provider, fake: boolean, judge = false): string {
    return path.join(__dirname, 'results',
        `${judge ? 'judge_' : ''}${fake ? 'fake_' : ''}${provider}_${config.ledgerVersion}.jsonl`);
}
export function rowKey(question: Question, provider: Provider, version: string): string {
    return `${question.id}|${provider}|${version}`;
}
export function latestByKey<T extends { key: string }>(rows: readonly T[]): Map<string, T> {
    return new Map(rows.map(row => [row.key, row]));
}
export function isLedgerRow(row: any): row is LedgerRow {
    return row && typeof row.key === 'string' && typeof row.questionId === 'string'
        && ['ja', 'en'].includes(row.lang) && ['gemini', 'openai', 'openrouter'].includes(row.provider)
        && typeof row.model === 'string' && typeof row.configHash === 'string'
        && Number.isFinite(row.latencyMs) && row.latencyMs >= 0 && Number.isFinite(Date.parse(row.at))
        && (row.status === 'no_match' || (row.status === 'failure' && row.kind === 'invalid_response')
            || (row.status === 'success' && Array.isArray(row.sectionIds)
                && row.sectionIds.every((id: unknown) => typeof id === 'string') && typeof row.answer === 'string'));
}
export function isJudgeRow(row: any): row is JudgeRow {
    return row && typeof row.key === 'string' && ['correct', 'partial', 'wrong', 'severe'].includes(row.grade)
        && typeof row.leak === 'boolean' && typeof row.note === 'string';
}
export function readJsonLines<T extends { key: string }>(
    file: string, valid: (row: any) => row is T, expectedHash?: string
): Map<string, T> {
    if (!fs.existsSync(file)) return new Map();
    const rows: T[] = [];
    let broken = 0, mismatched = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row: any;
        try { row = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { broken++; continue; }
        // 重複行も調べ、最終行で古い条件が隠れることを防ぐ。
        if (expectedHash && row && typeof row.configHash === 'string' && row.configHash !== expectedHash) mismatched++;
        if (valid(row)) rows.push(row); else broken++;
    }
    if (broken) console.warn(`${path.basename(file)}: 壊れた行 ${broken} 件`);
    if (mismatched) throw new EvaluationError(`${path.basename(file)}: configHash 不一致 ${mismatched} 件。ledgerVersion を上げてください。`);
    return latestByKey(rows);
}
export function appendLedger(file: string, row: LedgerRow): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    if (fs.existsSync(file)) {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const byte = Buffer.alloc(1);
            if (size) {
                fs.readSync(fd, byte, 0, 1, size - 1);
                if (byte[0] !== 10) prefix = '\n';
            }
        } finally { fs.closeSync(fd); }
    }
    fs.appendFileSync(file, prefix + JSON.stringify(row) + '\n', 'utf8');
}