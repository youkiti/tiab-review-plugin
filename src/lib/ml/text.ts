import { ENGLISH_STOP_WORDS } from "./stopwords";

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

export function mergeTitleAbstract(record: { title?: string; abstract?: string }): string {
    const title = record.title ?? "";
    const abstract = record.abstract ?? "";
    if (title && abstract) {
        return `${title} ${abstract}`;
    }
    return title || abstract;
}

export function tokenize(text: string, params: TfidfParams): string[] {
    const raw = params.lowercase ? text.toLowerCase() : text;
    const matches = raw.match(params.tokenPattern);
    if (!matches) {
        return [];
    }
    if (params.stopWords === "english") {
        return matches.filter((token) => !ENGLISH_STOP_WORDS.has(token));
    }
    return matches;
}

export function createDefaultTfidfParams(): TfidfParams {
    return {
        columns: ["title", "abstract"],
        lowercase: true,
        tokenPattern: /[\p{L}\p{N}_]{2,}/gu,
        ngramRange: [1, 1],
        maxDf: 1.0,
        minDf: 1,
        norm: "l2",
        smoothIdf: true,
        sublinearTf: false,
        stopWords: "english",
    };
}
