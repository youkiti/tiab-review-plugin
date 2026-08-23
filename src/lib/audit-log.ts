// audit-log.ts - key開閉などの監査イベントを Audit_Log タブへ記録するための純粋関数群。
//
// Decisions.context_json（src/lib/decision-context.ts）との役割分担:
// context_json は「判定ごとの暴露状況」を判定行へ相乗りさせて記録するのに対し、
// Audit_Log は判定と無関係な操作（key開閉など）を独立したイベント行として記録する。
// 詳細は AGENTS.md「Audit_Log タブ」を参照。
//
// ここでは行の組み立てのみを純粋関数として持つ（テストのため）。Sheets への書き込み・
// タブ未作成時のリトライ・ベストエフォート方針（失敗を握りつぶす）は
// src/lib/sheets-api.ts の logAuditEvent() 側の責務。

/** Audit_Log タブのヘッダー。新しい列は必ず末尾に追加すること（他の追記専用タブと同じ方針）。 */
export const AUDIT_LOG_HEADERS = ['event_id', 'event_type', 'actor', 'occurred_at', 'client_version', 'detail_json'];

/** 記録するイベント種別。今回のスコープは key の開閉のみ。 */
export type AuditEventType = 'key_opened' | 'key_closed';

export interface AuditLogEvent {
    event_id: string;          // UUID（呼び出し側で crypto.randomUUID() を使って発番する）
    event_type: AuditEventType;
    actor: string;             // 操作者のemail
    occurred_at: string;       // ISO 8601
    client_version: string;
    detail_json?: string;
}

/** AuditLogEvent から AUDIT_LOG_HEADERS と同じ列順の行配列を組み立てる */
export function buildAuditEventRow(event: AuditLogEvent): string[] {
    return [
        event.event_id,
        event.event_type,
        event.actor,
        event.occurred_at,
        event.client_version,
        event.detail_json || '',
    ];
}
