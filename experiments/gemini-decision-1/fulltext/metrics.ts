// 同じ成功集合の分類指標・研究単位 Recall・対の DeLong 推定を計算する。
import { ExperimentError, RecordRow } from './common';

export interface Score { record: RecordRow; p: number }
export interface DifferenceCi {
    difference: number | null;
    lower: number | null;
    upper: number | null;
    replicates: number;
    discarded: number;
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const ratio = (a: number, b: number) => b ? a / b : null;
export function metrics(items: Score[], threshold: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    const studies = new Set<string>(), found = new Set<string>();
    for (const { record, p } of items) {
        const included = p >= threshold;
        if (record.label === 'included') {
            if (included) {
                tp++;
            } else {
                fn++;
            }
            for (const study of record.study_keys) {
                const key = JSON.stringify([record.pmcid, study]);
                studies.add(key);
                if (included) {
                    found.add(key);
                }
            }
        } else if (included) {
            fp++;
        } else {
            tn++;
        }
    }
    return { tp, fp, tn, fn, recall: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp), precision: ratio(tp, tp + fp),
        studyRecall: ratio(found.size, studies.size), found: found.size, includedStudies: studies.size };
}
export function chooseThreshold(items: Score[], jevRecall: number | null): number {
    if (jevRecall === null) {
        throw new ExperimentError('陽性がないため閾値を凍結できません。');
    }
    const candidates = [...new Set(items.map(item => item.p))].sort((a, b) => b - a);
    const selected = candidates.find(t => metrics(items, t).recall! >= jevRecall);
    if (selected === undefined) {
        throw new ExperimentError('Recall を満たす閾値がありません。');
    }
    return selected;
}
function randomFromSeed(seed: number): () => number {
    let state = seed >>> 0;
    // mulberry32 で seed から決まる乱数列を作る。
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}
export function pairedDifferenceCi(
    a: Score[], b: Score[], thresholdA: number, thresholdB: number,
    metric: 'recall' | 'specificity', replicates: number, seed: number,
): DifferenceCi {
    if (a.length !== b.length || a.some((item, i) => item.record.key !== b[i].record.key
        || item.record.pmcid !== b[i].record.pmcid || item.record.label !== b[i].record.label)) {
        throw new ExperimentError('対の指標の記録またはキーの並びが一致しません。');
    }
    if (!Number.isInteger(replicates) || replicates <= 0 || !Number.isInteger(seed)) {
        throw new ExperimentError('ブートストラップの回数または seed が不正です。');
    }
    const valueA = metrics(a, thresholdA)[metric], valueB = metrics(b, thresholdB)[metric];
    if (valueA === null || valueB === null) {
        return { difference: null, lower: null, upper: null, replicates: 0, discarded: replicates };
    }
    // レビューごとの分母と正解数を足すことで、記録を複製する micro 指標と同じ値を得る。
    const clusters = new Map<string, { denominator: number; correctA: number; correctB: number }>();
    for (let i = 0; i < a.length; i++) {
        const { record, p } = a[i];
        const cluster = clusters.get(record.pmcid) ?? { denominator: 0, correctA: 0, correctB: 0 };
        if ((record.label === 'included') === (metric === 'recall')) {
            cluster.denominator++;
            cluster.correctA += Number(metric === 'recall' ? p >= thresholdA : p < thresholdA);
            cluster.correctB += Number(metric === 'recall' ? b[i].p >= thresholdB : b[i].p < thresholdB);
        }
        clusters.set(record.pmcid, cluster);
    }
    const reviews = [...clusters.values()], random = randomFromSeed(seed), differences: number[] = [];
    let discarded = 0;
    for (let r = 0; r < replicates; r++) {
        let denominator = 0, correctA = 0, correctB = 0;
        for (let i = 0; i < reviews.length; i++) {
            const review = reviews[Math.floor(random() * reviews.length)];
            denominator += review.denominator;
            correctA += review.correctA;
            correctB += review.correctB;
        }
        if (!denominator) {
            discarded++;
            continue;
        }
        differences.push(correctA / denominator - correctB / denominator);
    }
    differences.sort((x, y) => x - y);
    // 分位点は R type 7: 昇順の添字 (n−1)p の両隣を線形補間する。
    const percentile = (p: number): number | null => {
        if (!differences.length) {
            return null;
        }
        const index = (differences.length - 1) * p, lower = Math.floor(index), upper = Math.ceil(index);
        return differences[lower] + (differences[upper] - differences[lower]) * (index - lower);
    };
    return { difference: valueA - valueB, lower: percentile(0.025), upper: percentile(0.975),
        replicates: differences.length, discarded };
}
function covariance(a: number[], b: number[]): number | null {
    if (a.length < 2) {
        return null;
    }
    const ma = mean(a), mb = mean(b);
    return a.reduce((sum, v, i) => sum + (v - ma) * (b[i] - mb), 0) / (a.length - 1);
}
export function structural(labels: boolean[], scores: number[]) {
    const positives = scores.filter((_, i) => labels[i]);
    const negatives = scores.filter((_, i) => !labels[i]);
    if (!positives.length || !negatives.length) {
        return null;
    }
    const kernel = (p: number, n: number) => p > n ? 1 : p === n ? 0.5 : 0;
    const v10 = positives.map(p => mean(negatives.map(n => kernel(p, n))));
    const v01 = negatives.map(n => mean(positives.map(p => kernel(p, n))));
    return { auc: mean(v10), v10, v01 };
}
export function delong(labels: boolean[], a: number[], b: number[]) {
    if (labels.length !== a.length || a.length !== b.length) {
        throw new ExperimentError('対の AUC の記録数が一致しません。');
    }
    const x = structural(labels, a), y = structural(labels, b);
    if (!x || !y) {
        return { aucA: null, aucB: null, varianceA: null, varianceB: null, covariance: null, difference: null, ci: null };
    }
    const m = x.v10.length, n = x.v01.length;
    const cov = (p: typeof x, q: typeof x) => {
        const positive = covariance(p.v10, q.v10), negative = covariance(p.v01, q.v01);
        return positive === null || negative === null ? null : positive / m + negative / n;
    };
    const varianceA = cov(x, x), varianceB = cov(y, y), pairedCov = cov(x, y);
    const difference = x.auc - y.auc;
    const variance = varianceA === null || varianceB === null || pairedCov === null ? null
        : Math.max(0, varianceA + varianceB - 2 * pairedCov);
    const margin = variance === null ? null : 1.959963984540054 * Math.sqrt(variance);
    return { aucA: x.auc, aucB: y.auc, varianceA, varianceB, covariance: pairedCov, difference,
        ci: margin === null ? null : [difference - margin, difference + margin] };
}
