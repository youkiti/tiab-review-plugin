import type { FulltextStatus, Reference } from './types';

export interface FulltextRefUpdatedMessage {
    type: 'fulltext:ref-updated';
    spreadsheetId: string;
    refId: string;
    fulltextUrl: string;
    fulltextStatus: FulltextStatus;
}

export function buildFulltextRefUpdatedMessage(
    spreadsheetId: string,
    refId: string,
    fulltextUrl: string,
    fulltextStatus: FulltextStatus,
): FulltextRefUpdatedMessage {
    return { type: 'fulltext:ref-updated', spreadsheetId, refId, fulltextUrl, fulltextStatus };
}

export function parseFulltextRefUpdatedMessage(
    message: unknown,
    spreadsheetId: string,
): FulltextRefUpdatedMessage | null {
    if (!message || typeof message !== 'object') return null;
    const msg = message as Record<string, unknown>;
    if (msg.type !== 'fulltext:ref-updated'
        || typeof msg.spreadsheetId !== 'string' || msg.spreadsheetId !== spreadsheetId
        || typeof msg.refId !== 'string' || typeof msg.fulltextUrl !== 'string'
        || (msg.fulltextStatus !== 'not_retrieved' && msg.fulltextStatus !== 'cached'
            && msg.fulltextStatus !== 'retrieved' && msg.fulltextStatus !== 'unavailable')) {
        return null;
    }
    return buildFulltextRefUpdatedMessage(msg.spreadsheetId, msg.refId, msg.fulltextUrl, msg.fulltextStatus);
}

/** 判定画面の取得・アップロード・削除に合わせ、Drive直接取り込みのIDもクリアする。 */
export function applyFulltextRefUpdate(refs: Reference[], update: FulltextRefUpdatedMessage): boolean {
    const ref = refs.find(candidate => candidate.ref_id === update.refId);
    if (!ref) return false;
    ref.fulltext_url = update.fulltextUrl;
    ref.fulltext_status = update.fulltextStatus;
    ref.fulltext_drive_source_id = undefined;
    ref.fulltext_drive_copy_id = undefined;
    return true;
}
