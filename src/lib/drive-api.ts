// drive-api.ts - Google Drive 連携（フルテキストPDFの保存）
//
// フルテキストPDFはプロジェクト専用のDriveフォルダに保存し、
// Referencesシートの fulltext_url には Drive の webViewLink を記録する。
// フォルダIDは Config シート (fulltext_drive_folder キー) でプロジェクト共有する。
//
// OAuth スコープは drive.file（本拡張が作成したファイルのみアクセス可）で足りる。
// 共同レビュアーが閲覧できるよう、フォルダには「リンクを知っている全員（閲覧）」
// 権限を付与する。フォルダ内のファイルは権限を継承する。

import {
    getAuthToken,
    getSpreadsheetInfo,
    getFulltextDriveFolderId,
    saveFulltextDriveFolderId,
} from './sheets-api';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFileInfo {
    id: string;
    webViewLink: string;
}

/**
 * フォルダが存在し、ゴミ箱に入っていないか確認する
 */
async function folderExists(folderId: string): Promise<boolean> {
    try {
        const token = await getAuthToken();
        const resp = await fetch(
            `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,trashed`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!resp.ok) return false;
        const data = await resp.json() as { id?: string; trashed?: boolean };
        return !!data.id && !data.trashed;
    } catch {
        return false;
    }
}

/**
 * フォルダに「リンクを知っている全員（閲覧）」権限を付与する。
 * 失敗してもアップロード自体は valid なので警告に留める。
 */
async function shareFolderByLink(folderId: string): Promise<void> {
    try {
        const token = await getAuthToken();
        const resp = await fetch(
            `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}/permissions`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ role: 'reader', type: 'anyone' }),
            }
        );
        if (!resp.ok) {
            console.warn('[drive-api] フォルダのリンク共有設定に失敗:', resp.status);
        }
    } catch (err) {
        console.warn('[drive-api] フォルダのリンク共有設定に失敗:', err);
    }
}

/**
 * プロジェクト用フルテキストフォルダを作成する
 */
async function createFulltextFolder(name: string): Promise<string> {
    const token = await getAuthToken();
    const resp = await fetch(`${DRIVE_API_BASE}/files?fields=id`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
        }),
    });
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`Driveフォルダの作成に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    const data = await resp.json() as { id: string };
    await shareFolderByLink(data.id);
    return data.id;
}

/**
 * プロジェクトのフルテキスト保存フォルダIDを返す。
 * Configシートに記録済みで実在すればそれを再利用し、なければ作成して記録する。
 */
export async function ensureFulltextFolder(spreadsheetId: string): Promise<string> {
    const saved = await getFulltextDriveFolderId(spreadsheetId);
    if (saved && await folderExists(saved)) {
        return saved;
    }

    const { title } = await getSpreadsheetInfo(spreadsheetId);
    const folderId = await createFulltextFolder(`TiAb Fulltext - ${title}`);
    await saveFulltextDriveFolderId(spreadsheetId, folderId);
    return folderId;
}

/**
 * Windows等で使えない文字を除去したファイル名を作る
 */
export function buildPdfFileName(ref: { ref_id: string; title?: string }): string {
    const base = (ref.title || ref.ref_id)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return `${base} [${ref.ref_id.slice(0, 8)}].pdf`;
}

/**
 * PDFをDriveフォルダにアップロードし、閲覧用リンクを返す
 */
export async function uploadPdfToDrive(
    folderId: string,
    fileName: string,
    pdf: Blob
): Promise<DriveFileInfo> {
    const token = await getAuthToken();

    const boundary = `tiab_review_${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType: 'application/pdf',
    });
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
        pdf,
        `\r\n--${boundary}--`,
    ]);

    const resp = await fetch(
        `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,webViewLink`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body,
        }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`DriveへのPDFアップロードに失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    const data = await resp.json() as { id: string; webViewLink: string };
    return { id: data.id, webViewLink: data.webViewLink };
}
