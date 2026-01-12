export function queryMax(proba: Float64Array, refIds: string[]): string[] {
    const indices = Array.from({ length: proba.length }, (_, i) => i);

    // Sort indices based on probability (descending)
    indices.sort((a, b) => {
        const diff = proba[b] - proba[a];
        if (diff !== 0) {
            return diff;
        }
        // Stable sort fallback
        return a - b;
    });

    // Map back to refIds
    return indices.map(idx => refIds[idx]);
}
