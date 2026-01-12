export interface NbState {
    classLogPrior: Float64Array;
    featureLogProb: Array<Float64Array>;
}

function logSumExp(values: Float64Array): number {
    let max = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
        if (values[i] > max) {
            max = values[i];
        }
    }
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        sum += Math.exp(values[i] - max);
    }
    return max + Math.log(sum);
}

export function fitMultinomialNb(X: Float64Array[], y: number[], sampleWeight: Float64Array | null, alpha: number): NbState {
    // Check if X is empty or inputs are invalid
    if (!X || X.length === 0 || !X[0]) {
        throw new Error("Invalid input X for MultinomialNB fit");
    }

    const nFeatures = X[0]?.length ?? 0;
    const classes = [0, 1];
    const classCount = new Float64Array(classes.length);
    const featureCount = [new Float64Array(nFeatures), new Float64Array(nFeatures)];

    for (let i = 0; i < y.length; i += 1) {
        const label = y[i];
        if (label !== 0 && label !== 1) {
            continue;
        }
        const classIndex = label === 1 ? 1 : 0;
        const weight = sampleWeight ? sampleWeight[i] : 1;
        classCount[classIndex] += weight;
        const row = X[i];
        for (let j = 0; j < nFeatures; j += 1) {
            featureCount[classIndex][j] += row[j] * weight;
        }
    }

    const classLogPrior = new Float64Array(classes.length);
    const totalCount = classCount[0] + classCount[1];

    if (totalCount === 0) {
        // Fallback if no valid labels found (shoudln't happen if checked before)
        return {
            classLogPrior: new Float64Array([Math.log(0.5), Math.log(0.5)]),
            featureLogProb: [new Float64Array(nFeatures), new Float64Array(nFeatures)]
        };
    }

    for (let c = 0; c < classes.length; c += 1) {
        // Avoid log(0)
        const count = classCount[c] > 0 ? classCount[c] : 1e-10;
        classLogPrior[c] = Math.log(count / totalCount);
    }

    const featureLogProb = [new Float64Array(nFeatures), new Float64Array(nFeatures)];
    for (let c = 0; c < classes.length; c += 1) {
        let denom = 0;
        for (let j = 0; j < nFeatures; j += 1) {
            denom += featureCount[c][j] + alpha;
        }
        for (let j = 0; j < nFeatures; j += 1) {
            featureLogProb[c][j] = Math.log((featureCount[c][j] + alpha) / denom);
        }
    }

    return { classLogPrior, featureLogProb };
}

export function predictProba(X: Float64Array[], state: NbState): Float64Array {
    const nDocs = X.length;
    const probs = new Float64Array(nDocs);
    const nClasses = state.classLogPrior.length;

    for (let i = 0; i < nDocs; i += 1) {
        const logProbs = new Float64Array(nClasses);
        for (let c = 0; c < nClasses; c += 1) {
            let sum = state.classLogPrior[c];
            const row = X[i];
            const featureLogProb = state.featureLogProb[c];
            for (let j = 0; j < row.length; j += 1) {
                sum += row[j] * featureLogProb[j];
            }
            logProbs[c] = sum;
        }
        const norm = logSumExp(logProbs);
        probs[i] = Math.exp(logProbs[1] - norm);
    }

    return probs;
}
