import { createSmartRegex } from '../../utils/text';
import type { ReferenceWithStatus } from '../../../lib/types';

import { parseSearchQuery, type SearchMode, type ParsedSearch } from '../../utils/search';

export type MlSearchMode = SearchMode;

export { parseSearchQuery as parseMlSearchQuery };


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
