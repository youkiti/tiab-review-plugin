import { mergeTitleAbstract, tokenize } from "./text";
import { TfidfParams, TfidfState } from "./types";

interface DocTokens {
  tokens: string[];
  counts: Map<string, number>;
}

function buildDocTokens(texts: string[], params: TfidfParams): DocTokens[] {
  return texts.map((text) => {
    const tokens = tokenize(text, params);
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return { tokens, counts };
  });
}

function resolveDfThreshold(value: number, nDocs: number, isMax: boolean): number {
  if (value <= 1 && value > 0) {
    return isMax ? Math.floor(value * nDocs) : Math.ceil(value * nDocs);
  }
  return Math.floor(value);
}

function buildVocabulary(docTokens: DocTokens[], params: TfidfParams): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docTokens) {
    const unique = new Set(doc.tokens);
    for (const token of unique) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const minDf = resolveDfThreshold(params.minDf, docTokens.length, false);
  const maxDf = resolveDfThreshold(params.maxDf, docTokens.length, true);
  const vocabulary = new Map<string, number>();
  let index = 0;
  for (const [token, count] of df) {
    if (count < minDf) {
      continue;
    }
    if (params.maxDf > 0 && count > maxDf) {
      continue;
    }
    vocabulary.set(token, index++);
  }
  return vocabulary;
}

function computeIdf(docTokens: DocTokens[], vocabulary: Map<string, number>, params: TfidfParams): Float64Array {
  const df = new Float64Array(vocabulary.size);
  for (const doc of docTokens) {
    const unique = new Set(doc.tokens);
    for (const token of unique) {
      const idx = vocabulary.get(token);
      if (idx !== undefined) {
        df[idx] += 1;
      }
    }
  }

  const idf = new Float64Array(vocabulary.size);
  const nDocs = docTokens.length;
  for (let i = 0; i < df.length; i += 1) {
    const dfValue = df[i];
    if (params.smoothIdf) {
      idf[i] = Math.log((1 + nDocs) / (1 + dfValue)) + 1;
    } else {
      idf[i] = Math.log(nDocs / dfValue) + 1;
    }
  }
  return idf;
}

function l2Normalize(vector: Float64Array): void {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    norm += vector[i] * vector[i];
  }
  if (norm === 0) {
    return;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] *= scale;
  }
}

export function fitTfidf(records: Array<{ title?: string; abstract?: string }>, params: TfidfParams): { state: TfidfState; X: Float64Array[] } {
  const texts = records.map(mergeTitleAbstract);
  const docTokens = buildDocTokens(texts, params);
  const vocabulary = buildVocabulary(docTokens, params);
  const idf = computeIdf(docTokens, vocabulary, params);

  const X = docTokens.map((doc) => {
    const vector = new Float64Array(vocabulary.size);
    for (const [token, count] of doc.counts) {
      const idx = vocabulary.get(token);
      if (idx === undefined) {
        continue;
      }
      const tf = params.sublinearTf ? 1 + Math.log(count) : count;
      vector[idx] = tf * idf[idx];
    }
    if (params.norm === "l2") {
      l2Normalize(vector);
    }
    return vector;
  });

  return {
    state: {
      vocabulary,
      idf,
      params,
    },
    X,
  };
}

export function transformTfidf(records: Array<{ title?: string; abstract?: string }>, state: TfidfState): Float64Array[] {
  const texts = records.map(mergeTitleAbstract);
  const docTokens = buildDocTokens(texts, state.params);
  return docTokens.map((doc) => {
    const vector = new Float64Array(state.vocabulary.size);
    for (const [token, count] of doc.counts) {
      const idx = state.vocabulary.get(token);
      if (idx === undefined) {
        continue;
      }
      const tf = state.params.sublinearTf ? 1 + Math.log(count) : count;
      vector[idx] = tf * state.idf[idx];
    }
    if (state.params.norm === "l2") {
      l2Normalize(vector);
    }
    return vector;
  });
}
