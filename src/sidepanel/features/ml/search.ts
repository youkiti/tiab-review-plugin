import { createSmartRegex } from '../../utils/text';
import type { ReferenceWithStatus } from '../../../lib/types';

export type MlSearchMode = 'and' | 'or';

type ParsedSearch = {
    terms: string[];
    mode: MlSearchMode;
};

export function parseMlSearchQuery(raw: string, defaultUseAnd: boolean): ParsedSearch {
    const trimmed = raw.trim();
    const fallbackMode: MlSearchMode = defaultUseAnd ? 'and' : 'or';

    if (!trimmed) {
        return { terms: [], mode: fallbackMode };
    }

    const orSplit = trimmed.split(/\s+OR\s+/i).filter(Boolean);
    if (orSplit.length > 1) {
        return { terms: orSplit, mode: 'or' };
    }

    const andSplit = trimmed.split(/\s+AND\s+/i).filter(Boolean);
    if (andSplit.length > 1) {
        return { terms: andSplit, mode: 'and' };
    }

    const terms = trimmed.split(/\s+/).filter(Boolean);
    return { terms, mode: fallbackMode };
}

export function resolveMlRanking(references: ReferenceWithStatus[], ranking: string[]): string[] {
    if (ranking.length > 0) {
        return ranking;
    }
    return references.map(ref => ref.ref_id);
}

export function getMlFilteredRanking(
    ranking: string[],
    references: ReferenceWithStatus[],
    searchTerms: string[],
    mode: MlSearchMode
): string[] {
    if (searchTerms.length === 0) {
        return ranking;
    }

    const refMap = new Map<string, ReferenceWithStatus>();
    references.forEach(ref => {
        refMap.set(ref.ref_id, ref);
    });

    const regexes = searchTerms.map(term => createSmartRegex(term));

    return ranking.filter(refId => {
        const ref = refMap.get(refId);
        if (!ref) return false;

        const text = `${ref.title} ${ref.abstract || ''}`;
        if (mode === 'and') {
            return regexes.every(regex => {
                regex.lastIndex = 0;
                return regex.test(text);
            });
        }

        return regexes.some(regex => {
            regex.lastIndex = 0;
            return regex.test(text);
        });
    });
}
