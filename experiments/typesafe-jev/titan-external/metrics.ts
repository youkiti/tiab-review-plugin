import type { ScoredRecord } from '../ledger';

export function operatingPointAtRecall(items: ScoredRecord[], targetRecall: number) {
    // 百分率を整数に戻してから整数の積を丸める。対応する目標は1〜100%。
    const percent = Math.round(targetRecall * 100);
    if (percent < 1 || percent > 100 || targetRecall !== percent / 100) throw new Error('目標 Recall は整数百分率で指定してください。');
    const positives = items.filter(r => r.label_included === 1).map(r => r.include_probability).sort((a, b) => b - a);
    if (!positives.length) return null;
    const required = Math.ceil(percent * positives.length / 100);
    const threshold = positives[required - 1];
    let screened = 0, tp = 0, tn = 0, negatives = 0;
    for (const item of items) {
        const selected = item.include_probability >= threshold;
        if (selected) screened++;
        if (item.label_included === 1 && selected) tp++;
        if (item.label_included === 0) { negatives++; if (!selected) tn++; }
    }
    const workSaved = (items.length - screened) / items.length;
    return { threshold, screened, achieved_recall: tp / positives.length,
        specificity: negatives ? tn / negatives : null,
        work_saved_at_recall: workSaved, wss_at_recall: workSaved - (100 - percent) / 100 };
}
export function quantile(values: number[], probability: number): number | null {
    if (probability < 0 || probability > 1 || !Number.isFinite(probability)) throw new Error('分位点が不正です。');
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index), fraction = index - lower;
    return sorted[lower] + fraction * (sorted[Math.ceil(index)] - sorted[lower]);
}
export function medianIqr(values: number[]) {
    return { median: quantile(values, 0.5), q1: quantile(values, 0.25), q3: quantile(values, 0.75) };
}
