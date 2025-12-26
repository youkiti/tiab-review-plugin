// types.ts - 型定義

export interface Reference {
    ref_id: string;           // UUID
    title: string;
    abstract?: string;
    year?: number;
    authors?: string;
    journal?: string;
    doi?: string;
    pmid?: string;
    url?: string;
    source?: string;
    imported_at?: string;     // ISO 8601
    imported_by?: string;     // email
    dedupe_key?: string;
}

export interface Decision {
    decision_id: string;      // UUID
    ref_id: string;
    reviewer_id: string;      // email
    decision: 'include' | 'exclude' | 'maybe';
    reason?: string;          // exclude時必須
    labels?: string[];        // 配列として管理、保存時はカンマ区切り
    note?: string;
    decided_at: string;       // ISO 8601
    client_version?: string;
    source_url?: string;
}

export interface ReviewerState {
    email: string;
    spreadsheetId: string;
    lastSyncedAt?: string;
    offlineQueue: Decision[];
}

export type DecisionStatus = 'pending' | 'include' | 'exclude' | 'maybe';

export interface ReferenceWithStatus extends Reference {
    myDecision?: Decision;
    status: DecisionStatus;
}

export interface Config {
    spreadsheetId: string;
    referencesSheetName: string;
    decisionsSheetName: string;
}
