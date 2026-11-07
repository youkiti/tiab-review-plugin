// ヘルプ小節と、一問一答の相談結果を表す共通型。
export type HelpLanguage = 'ja' | 'en';

export interface HelpSection {
    id: string;
    level: 3 | 4;
    sectionId: string;
    sectionTitle: string;
    title: string;
    when: string[];
    body: string;
}

export type ConsultFailureKind = 'no_key' | 'unsupported_provider' | 'rate_limited' | 'auth'
    | 'timeout' | 'aborted' | 'network' | 'invalid_response' | 'unknown';

export type ConsultResult =
    | { status: 'success'; sectionIds: string[]; answer: string }
    | { status: 'no_match' }
    | { status: 'failure'; kind: ConsultFailureKind };
