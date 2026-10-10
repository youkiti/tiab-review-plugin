// 正解ラベルとの混同行列と感度重視の指標を計算する。
export function confusion(rows, labels, threshold) {
    const counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
    for (const row of rows) {
        const label = labels instanceof Map ? labels.get(row.ref_id) : labels[row.ref_id];
        if (label !== 0 && label !== 1) {
            throw new Error(`正解ラベルが不正: ${row.ref_id}`);
        }
        const positive = row.include_probability >= threshold;
        counts[label === 1 ? (positive ? 'tp' : 'fn') : (positive ? 'fp' : 'tn')]++;
    }
    return counts;
}

export function metricsFromConfusion({ tp, fp, tn, fn }) {
    const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
    return {
        recall: ratio(tp, tp + fn),
        specificity: ratio(tn, tn + fp),
        precision: ratio(tp, tp + fp),
        fBeta7: ratio(50 * tp, 50 * tp + 49 * fn + fp),
    };
}

export function sweep(rows, labels, thresholds) {
    return thresholds.map((threshold) => {
        const counts = confusion(rows, labels, threshold);
        return { threshold, ...counts, ...metricsFromConfusion(counts) };
    });
}
