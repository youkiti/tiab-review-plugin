export type Label = 1 | 0 | -1;

export interface ReferenceRecord {
  id: string | number;
  title?: string;
  abstract?: string;
  label_included?: number;
}

export interface TfidfParams {
  columns: Array<"title" | "abstract">;
  lowercase: boolean;
  tokenPattern: RegExp;
  ngramRange: [number, number];
  maxDf: number;
  minDf: number;
  norm: "l2" | null;
  smoothIdf: boolean;
  sublinearTf: boolean;
  stopWords: "english" | null;
}

export interface TfidfState {
  vocabulary: Map<string, number>;
  idf: Float64Array;
  params: TfidfParams;
}

export interface NbState {
  classLogPrior: Float64Array;
  featureLogProb: Array<Float64Array>;
}

export interface FitResult {
  probaIncluded: Float64Array;
  ranking: number[];
  debugState: {
    vocabulary: string[];
    idf: number[];
    classLogPrior: number[];
    featureLogProb: number[][];
  };
}
