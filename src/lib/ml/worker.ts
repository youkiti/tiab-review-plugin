import { computeBalancedSampleWeight } from "./balanced";
import { fitMultinomialNb, predictProba } from "./nb";
import { queryMax } from "./querier";
import { createDefaultTfidfParams } from "./text";
import { fitTfidf } from "./tfidf";
import { Label, MlRecord, MlWorkerMessage, MlWorkerResponse } from "./types";

// Global state in Worker
let tfidfState: any = null;
let X: Float64Array[] = [];
let records: MlRecord[] = [];
let refIdToIndex = new Map<string, number>();

// Listen for messages
self.onmessage = (event: MessageEvent<MlWorkerMessage>) => {
    const msg = event.data;

    try {
        switch (msg.type) {
            case 'init':
                handleInit(msg.records, msg.labels);
                break;
            case 'updateLabels':
                handleUpdateLabels(msg.labels);
                break;
            case 'reset':
                handleReset();
                break;
        }
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        respond({ type: 'error', message: errorMsg });
    }
};

function respond(resp: MlWorkerResponse) {
    self.postMessage(resp);
}

function handleInit(newRecords: MlRecord[], labels: Record<string, Label>) {
    // 1. Save records and build index map
    records = newRecords;
    refIdToIndex.clear();
    records.forEach((rec, idx) => {
        refIdToIndex.set(rec.refId, idx);
    });

    // 2. TF-IDF Fit (Heavy operation)
    const params = createDefaultTfidfParams();
    const result = fitTfidf(records, params);
    tfidfState = result.state;
    X = result.X;

    // 3. Initial Training if labels exist
    trainAndRank(labels, 'ready');
}

function handleUpdateLabels(labels: Record<string, Label>) {
    if (!tfidfState || !X.length) {
        respond({ type: 'error', message: 'Model not initialized. Call init first.' });
        return;
    }
    trainAndRank(labels, 'updated');
}

function handleReset() {
    tfidfState = null;
    X = [];
    records = [];
    refIdToIndex.clear();
    respond({ type: 'ready', ranking: [], stats: { include: 0, exclude: 0 } });
}

function trainAndRank(labels: Record<string, Label>, responseType: 'ready' | 'updated') {
    // 1. Prepare training data
    const labeledIndices: number[] = [];
    const yTrain: number[] = [];
    let includeCount = 0;
    let excludeCount = 0;

    Object.entries(labels).forEach(([refId, label]) => {
        const idx = refIdToIndex.get(refId);
        if (idx !== undefined && (label === 0 || label === 1)) {
            labeledIndices.push(idx);
            yTrain.push(label);
            if (label === 1) includeCount++;
            else excludeCount++;
        }
    });

    // If no labels or only one class, return default ranking (original order)
    if (includeCount === 0 || excludeCount === 0) {
        const defaultRanking = records.map(r => r.refId);
        respond({
            type: responseType,
            ranking: defaultRanking,
            stats: { include: includeCount, exclude: excludeCount }
        });
        return;
    }

    const XTrain = labeledIndices.map(idx => X[idx]);

    // 2. Sample Weights
    const weights = computeBalancedSampleWeight(yTrain, 1.2); // ratio=1.2 (ASReview default)

    // 3. Fit NB
    const nbState = fitMultinomialNb(XTrain, yTrain, weights, 3.822); // alpha=3.822

    // 4. Predict
    const proba = predictProba(X, nbState);

    // 5. Rank
    const refIds = records.map(r => r.refId);
    const ranking = queryMax(proba, refIds);

    respond({
        type: responseType,
        ranking,
        stats: { include: includeCount, exclude: excludeCount }
    });
}
