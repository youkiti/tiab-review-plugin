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
    getProjectDriveFolderId,
    saveProjectDriveFolderId,
} from './sheets-api';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// 全プロジェクトを束ねるマイドライブ直下のルートフォルダ名。
// 構成: TiAb Review Plugin / {プロジェクト名} / (スプレッドシート, fulltext/)
const APP_ROOT_FOLDER_NAME = 'TiAb Review Plugin';
const FULLTEXT_SUBFOLDER_NAME = 'fulltext';
// フォルダを Drive 上で見分けやすくするための色。
// アプリアイコンの緑（#81BD3B〜#99CC44）に最も近い Drive 既定パレット色。
// folderColorRgb は Drive の既定パレットに丸められる。
const APP_FOLDER_COLOR = '#7bd148';

export interface DriveFileInfo {
    id: string;
    webViewLink: string;
}

/**
 * Drive の閲覧リンク（webViewLink / open?id= 形式）からファイルIDを取り出す。
 * Drive 以外の URL は null を返す。
 */
export function extractDriveFileId(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.hostname !== 'drive.google.com' && u.hostname !== 'drive.usercontent.google.com') {
            return null;
        }
        const pathMatch = /\/file\/d\/([\w-]+)/.exec(u.pathname);
        if (pathMatch) return pathMatch[1];
        const idParam = u.searchParams.get('id');
        return idParam && /^[\w-]+$/.test(idParam) ? idParam : null;
    } catch {
        return null;
    }
}

/**
 * Drive ファイルの実体（PDFバイト）をダウンロードする。
 * drive.file スコープのため、本拡張で保存したファイル以外は 404 になりうる
 * （その場合は呼び出し側で Drive プレビュー埋め込みへフォールバックする）。
 */
export async function downloadDriveFile(fileId: string): Promise<Blob> {
    const token = await getAuthToken();
    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) {
        throw new Error(`DriveからのPDF取得に失敗しました (HTTP ${resp.status})`);
    }
    return resp.blob();
}

/**
 * Drive ファイルをゴミ箱へ移動する（誤って保存したPDFの削除用）。
 * 完全削除ではなくゴミ箱送りにすることで、誤操作からの復元余地を残す。
 * drive.file スコープのため、本拡張が保存したファイルのみ対象にできる。
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
    const token = await getAuthToken();
    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ trashed: true }),
        }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`DriveのPDF削除に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
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
 * Drive フォルダを作成する。
 * parentId を指定するとそのフォルダ内に、省略するとマイドライブ直下に作る。
 *
 * 注: フォルダ自体には公開（anyone）権限を付けない。論文PDFは著作権物のため
 * 「リンクを知っている全員が閲覧可」は使わず、プロジェクトフォルダを
 * 特定メンバーに共有して下方向の継承でアクセスさせる方針とする。
 */
async function createFolder(name: string, parentId?: string, colorRgb?: string): Promise<string> {
    const token = await getAuthToken();
    const metadata: { name: string; mimeType: string; parents?: string[]; folderColorRgb?: string } = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentId) metadata.parents = [parentId];
    if (colorRgb) metadata.folderColorRgb = colorRgb;

    const resp = await fetch(`${DRIVE_API_BASE}/files?fields=id`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
    });
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`Driveフォルダの作成に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    const data = await resp.json() as { id: string };
    return data.id;
}

/**
 * マイドライブ直下の name に一致する（ゴミ箱外の）フォルダIDを探す。
 * drive.file スコープでは本拡張が作成したファイルのみが対象になるため、
 * 自分が作ったルートフォルダだけに正しく収束する。見つからなければ null。
 */
async function findFolderInRoot(name: string): Promise<string | null> {
    try {
        const token = await getAuthToken();
        const q = [
            `name='${name.replace(/'/g, "\\'")}'`,
            "mimeType='application/vnd.google-apps.folder'",
            "'root' in parents",
            'trashed=false',
        ].join(' and ');
        const resp = await fetch(
            `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!resp.ok) return null;
        const data = await resp.json() as { files?: Array<{ id: string }> };
        return data.files && data.files.length > 0 ? data.files[0].id : null;
    } catch {
        return null;
    }
}

/**
 * 全プロジェクト共通のアプリルートフォルダ（tiab-reviewer-plugin）の ID を返す。
 * 既存を検索→無ければ作成。アカウント切替に備えてIDはキャッシュせず都度確認する。
 */
export async function ensureAppRootFolder(): Promise<string> {
    const existing = await findFolderInRoot(APP_ROOT_FOLDER_NAME);
    if (existing) return existing;
    return createFolder(APP_ROOT_FOLDER_NAME, undefined, APP_FOLDER_COLOR);
}

/**
 * ファイル（スプレッドシート等）を parentId フォルダ配下へ移動する。
 * Sheets API の create は親フォルダを指定できないため、作成後にこれで移動する。
 */
async function moveFileToFolder(fileId: string, parentId: string): Promise<void> {
    const token = await getAuthToken();
    // 現在の親（通常は 'root'）を取得して removeParents に渡す
    const getResp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=parents`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    let removeParents = '';
    if (getResp.ok) {
        const data = await getResp.json() as { parents?: string[] };
        removeParents = (data.parents || []).join(',');
    }

    const params = new URLSearchParams({ addParents: parentId, fields: 'id,parents' });
    if (removeParents) params.set('removeParents', removeParents);

    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`Driveフォルダへの移動に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
}

/**
 * 新規プロジェクト用のフォルダ階層を構築する。
 *   tiab-reviewer-plugin / {title} / (スプレッドシート本体をここへ移動)
 * 作成したプロジェクトフォルダIDを Config に保存し、そのIDを返す。
 * 失敗してもプロジェクト作成自体は成立しているため、呼び出し側で警告に留めてよい。
 */
export async function setupProjectFolder(spreadsheetId: string, title: string): Promise<string> {
    const rootId = await ensureAppRootFolder();
    const projectFolderId = await createFolder(title, rootId, APP_FOLDER_COLOR);
    await moveFileToFolder(spreadsheetId, projectFolderId);
    await saveProjectDriveFolderId(spreadsheetId, projectFolderId);
    return projectFolderId;
}

/**
 * プロジェクトフォルダ（tiab-reviewer-plugin/{title}）のIDを返す。
 * Config に記録済みで実在すればそれを再利用し、無ければ新構成で作成して記録する。
 */
async function ensureProjectFolder(spreadsheetId: string): Promise<string> {
    const saved = await getProjectDriveFolderId(spreadsheetId);
    if (saved && await folderExists(saved)) {
        return saved;
    }
    const { title } = await getSpreadsheetInfo(spreadsheetId);
    return setupProjectFolder(spreadsheetId, title);
}

/**
 * プロジェクトのフルテキスト保存フォルダIDを返す。
 * Configシートに記録済みで実在すればそれを再利用し、なければ
 * プロジェクトフォルダ配下に fulltext サブフォルダを作成して記録する。
 */
export async function ensureFulltextFolder(spreadsheetId: string): Promise<string> {
    const saved = await getFulltextDriveFolderId(spreadsheetId);
    if (saved && await folderExists(saved)) {
        return saved;
    }

    const projectFolderId = await ensureProjectFolder(spreadsheetId);
    // 公開共有はしない。アクセスは親プロジェクトフォルダの共有メンバーが継承する。
    const folderId = await createFolder(FULLTEXT_SUBFOLDER_NAME, projectFolderId);
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
