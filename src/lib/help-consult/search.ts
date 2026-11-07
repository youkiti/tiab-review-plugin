// 日本語の文字二つ組と英単語で端末内のヘルプを検索する。
import type { HelpSection } from './types';

function tokens(text: string): Set<string> {
    const normalized = text.normalize('NFKC').toLowerCase();
    const result = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
    for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []) {
        const chars = Array.from(run);
        for (let i = 0; i < chars.length - 1; i++) {
            result.add(chars[i] + chars[i + 1]);
        }
    }
    return result;
}

export function searchHelpSections(sections: readonly HelpSection[], query: string, limit = 3): HelpSection[] {
    if (!Number.isFinite(limit) || limit <= 0) {
        return [];
    }
    const wanted = tokens(query);
    const matches = (text: string) => [...tokens(text)].filter(token => wanted.has(token)).length;
    return sections.map((section, index) => ({
        section, index,
        score: matches(section.when.join(' ')) * 3 + matches(section.title) * 2 + matches(section.body),
    })).filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, Math.floor(limit)).map(item => item.section);
}
