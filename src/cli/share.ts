// 作成時と作成後で同じ通知・失敗の扱いを使う。
import { addPermission } from '../lib/drive-permissions';
import { buildInviteMessage } from '../lib/share-invite';
import { getProjectDriveFolderId, getSpreadsheetInfo } from '../lib/sheets-api';
import { safeApiErrorMessage } from './api-error';

export async function inviteReviewers(
    spreadsheetId: string, title: string, folderId: string | null, share: string[],
    formatError = safeApiErrorMessage,
) {
    const result = {
        shared: [] as string[],
        shareFailures: [] as { email: string; message: string }[],
        folderShareFailures: [] as { email: string; message: string }[],
    };
    for (const email of share) {
        try {
            await addPermission(spreadsheetId, email, 'writer', buildInviteMessage(spreadsheetId, title));
        } catch (error) {
            result.shareFailures.push({ email, message: formatError(error) });
            continue;
        }
        result.shared.push(email);
        if (folderId) {
            try {
                await addPermission(folderId, email, 'writer', undefined, { sendNotificationEmail: false });
            } catch (error) {
                result.folderShareFailures.push({ email, message: formatError(error) });
            }
        }
    }
    return result;
}

export async function runShare(spreadsheetId: string, share: string[], formatError = safeApiErrorMessage) {
    const { title } = await getSpreadsheetInfo(spreadsheetId);
    const folderId = await getProjectDriveFolderId(spreadsheetId);
    return inviteReviewers(spreadsheetId, title, folderId, share, formatError);
}
