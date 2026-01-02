import { computeBalancedSampleWeight } from "./balanced";
import { fitMultinomialNb, predictProba } from "./nb";
import { queryMax } from "./querier";
import { createDefaultTfidfParams } from "./text";
import { fitTfidf } from "./tfidf";
import { FitResult, Label } from "./types";

export function fitAndRank(records: Array<{ title?: string; abstract?: string }>, labels: Label[]): FitResult {
  const tfidfParams = createDefaultTfidfParams();
  const { state: tfidfState, X } = fitTfidf(records, tfidfParams);

  const labeledIndices: number[] = [];
  const labeledLabels: number[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === 1 || labels[i] === 0) {
      labeledIndices.push(i);
      labeledLabels.push(labels[i]);
    }
  }

  const XTrain = labeledIndices.map((idx) => X[idx]);
  const yTrain = labeledLabels;
  const weights = computeBalancedSampleWeight(yTrain, 1.2);
  const nbState = fitMultinomialNb(XTrain, yTrain, weights, 3.822);

  const probaIncluded = predictProba(X, nbState);
  const ranking = queryMax(probaIncluded);

  const vocabulary = Array.from(tfidfState.vocabulary.keys());
  const idf = Array.from(tfidfState.idf);
  const classLogPrior = Array.from(nbState.classLogPrior);
  const featureLogProb = nbState.featureLogProb.map((row) => Array.from(row));

  return {
    probaIncluded,
    ranking,
    debugState: {
      vocabulary,
      idf,
      classLogPrior,
      featureLogProb,
    },
  };
}
