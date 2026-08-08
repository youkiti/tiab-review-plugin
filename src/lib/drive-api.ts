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
import type { ImportedCopyMatch } from './drive-import-action';
import { t } from './i18n';

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

export interface DriveFileMetadata {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    parents?: string[];
    trashed: boolean;
    capabilities?: { canCopy?: boolean; canTrash?: boolean };
    appProperties?: Record<string, string>;
    /** 共有ドライブ配下のファイルにのみ付与される。マイドライブのファイルには存在しない。 */
    driveId?: string;
}

// ---------------------------------------------------------------------------
// アクセス不能を「存在しない」と誤認しないための型付きエラー
//
// OAuth スコープ drive.file は「アプリ×ユーザー×ファイル」単位でしか付与されない
// （Drive の共有では付与されない）。そのため PDF をアップロードした本人以外が
// プロジェクトの Drive フォルダ/ファイルを GET すると 403/404 になりうるが、これは
// 「見えない」のであって「無い」わけではない。ここを区別せずに握り潰すと、
// 誤ってフォルダを作り直し・他人のスプレッドシートを移動してしまう（Issue #60）。
// sheets-api.ts の SheetsAccessDeniedError と同じ考え方を Drive 側にも適用する。
// ---------------------------------------------------------------------------

/**
 * 現在のアカウントから対象（フォルダ/ファイル/スプレッドシート）にアクセスできない場合のエラー
 * （HTTP 403/404、または所有者チェックで ownedByMe !== true だった場合）。
 * 一時的な問題ではないため、フォルダの作り直しや移動には絶対に使ってはならない。
 * デフォルトメッセージはログ/デバッグ用の中立的な英語文字列とし、UIへ出す文言は
 * describeDriveAccessError() 経由で messages.json（ja/en）から取得する
 * （sheets-api.ts の SheetsAccessDeniedError と同じ方針。2箇所に文言を持たせて drift させない）。
 */
export class DriveAccessDeniedError extends Error {
    constructor(
        public readonly fileId: string,
        public readonly status?: number,
        message = 'Drive folder/file access is not granted for the current account, or it was not found'
    ) {
        super(message);
        this.name = 'DriveAccessDeniedError';
    }
}

/**
 * Drive API 呼び出しが HTTP 401（認証切れ）で失敗した場合のエラー。再ログインで解消しうる。
 * デフォルトメッセージは中立的な英語文字列。UI文言は describeDriveAccessError() を使うこと。
 */
export class DriveAuthError extends Error {
    constructor(
        public readonly fileId: string,
        message = 'Drive API authentication failed (401); re-authentication is required'
    ) {
        super(message);
        this.name = 'DriveAuthError';
    }
}

/**
 * Drive API 呼び出しが 5xx/429・ネットワーク例外・JSONパース失敗などで失敗した場合のエラー。
 * 恒久的な問題ではない可能性が高いため、フォルダの作り直しには使わず再試行を促す。
 * デフォルトメッセージは中立的な英語文字列。UI文言は describeDriveAccessError() を使うこと。
 */
export class DriveTransientError extends Error {
    constructor(
        public readonly fileId: string,
        message = 'Drive API request failed transiently; retry later'
    ) {
        super(message);
        this.name = 'DriveTransientError';
    }
}

/**
 * Drive API のレスポンスステータスを4分類する純粋関数（テストのためネットワーク処理と分離）。
 * 200番台は 'ok'（trashed 判定など後続処理は呼び出し側で行う）。
 */
export function classifyDriveApiStatus(status: number): 'ok' | 'auth-error' | 'inaccessible' | 'transient-error' {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401) return 'auth-error';
    if (status === 403 || status === 404) return 'inaccessible';
    // 5xx, 429, その他未知のステータスは一時エラー扱い
    return 'transient-error';
}

export type FolderAccessState = 'accessible' | 'trashed' | 'inaccessible' | 'auth-error' | 'transient-error';

/**
 * フォルダIDの現在の状態を判定する（旧 folderExists() のboolean置き換え）。
 * boolean は「見えない」と「無い」を区別できず危険だったため、状態を返す形にした:
 *   - HTTP 200 かつ trashed !== true → accessible
 *   - HTTP 200 かつ trashed === true → trashed（確定した答えなので作り直してよい）
 *   - HTTP 401 → auth-error（認証切れ。作り直し禁止）
 *   - HTTP 403/404 → inaccessible（権限で見えない or 削除済み。作り直し禁止）
 *   - HTTP 5xx/429・ネットワーク例外・JSONパース失敗 → transient-error（作り直し禁止）
 */
export async function resolveFolderState(folderId: string): Promise<FolderAccessState> {
    let resp: Response;
    try {
        const token = await getAuthToken();
        resp = await fetch(
            `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,trashed`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
    } catch {
        return 'transient-error';
    }

    const statusClass = classifyDriveApiStatus(resp.status);
    if (statusClass !== 'ok') return statusClass;

    try {
        const data = await resp.json() as { id?: string; trashed?: boolean };
        if (!data.id) return 'transient-error';
        return data.trashed === true ? 'trashed' : 'accessible';
    } catch {
        return 'transient-error';
    }
}

/**
 * resolveFolderState の非 accessible/trashed 状態を、対応する型付きエラーへ変換する。
 */
function toDriveFolderError(fileId: string, state: 'inaccessible' | 'auth-error' | 'transient-error'): Error {
    if (state === 'auth-error') return new DriveAuthError(fileId);
    if (state === 'transient-error') return new DriveTransientError(fileId);
    return new DriveAccessDeniedError(fileId);
}

/**
 * Drive アクセス関連の型付きエラーを、UIにそのまま出せる原因＋対処の文言に変換する。
 * 該当しないエラーは null を返すので、呼び出し側は既存のエラー表示（フォールバック）に委ねればよい。
 * i18n key は `src/_locales/{ja,en}/messages.json` を参照。
 */
export function describeDriveAccessError(error: unknown): string | null {
    if (error instanceof DriveAccessDeniedError) return t('fulltext_driveAccessDenied');
    if (error instanceof DriveAuthError) return t('fulltext_driveAuthError');
    if (error instanceof DriveTransientError) return t('fulltext_driveTransientError');
    return null;
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
        // 403/404 は「PDFが無い」のではなく「別アカウントがアップロードしたPDFで
        // drive.file スコープが無い」可能性が高い（原因を伝えるため型付きエラーにする）。
        // 401 は認証切れ。呼び出し側のプレビュー埋め込みフォールバックは維持する
        // （instanceof Error である限り既存の catch はそのまま動く）。
        if (resp.status === 401) throw new DriveAuthError(fileId);
        if (resp.status === 403 || resp.status === 404) throw new DriveAccessDeniedError(fileId, resp.status);
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
 * 対象スプレッドシートを現在のユーザーが所有しているか確認する。
 * レガシープロジェクト（project_drive_folder が Config に未設定）では「ID が無いので
 * 作成してよい」に該当してしまい、共同研究者が先に操作するとオーナーのスプレッドシートが
 * 移動されてしまう（Issue #60）。setupProjectFolder が createFolder / moveFileToFolder に
 * 進む前に必ずこれを通す。ownedByMe が判定できない場合も安全側に倒して例外にする
 * （drive.file スコープの追加は不要。対象スプレッドシートは Picker 付与済みでアクセス可能）。
 */
async function assertSpreadsheetOwnedByCurrentUser(spreadsheetId: string): Promise<void> {
    const token = await getAuthToken();
    let resp: Response;
    try {
        resp = await fetch(
            `${DRIVE_API_BASE}/files/${encodeURIComponent(spreadsheetId)}?fields=ownedByMe`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
    } catch {
        throw new DriveTransientError(spreadsheetId);
    }

    const statusClass = classifyDriveApiStatus(resp.status);
    if (statusClass === 'auth-error') throw new DriveAuthError(spreadsheetId);
    if (statusClass === 'inaccessible') throw new DriveAccessDeniedError(spreadsheetId, resp.status);
    if (statusClass === 'transient-error') throw new DriveTransientError(spreadsheetId);

    let data: { ownedByMe?: boolean };
    try {
        data = await resp.json();
    } catch {
        throw new DriveTransientError(spreadsheetId);
    }
    if (data.ownedByMe !== true) {
        // false、またはフィールド欠落（undefined）はどちらも「自分の所有と確認できない」ため作り直さない
        throw new DriveAccessDeniedError(spreadsheetId);
    }
}

/**
 * 新規プロジェクト用のフォルダ階層を構築する。
 *   tiab-reviewer-plugin / {title} / (スプレッドシート本体をここへ移動)
 * 作成したプロジェクトフォルダIDを Config に保存し、そのIDを返す。
 * 失敗してもプロジェクト作成自体は成立しているため、呼び出し側で警告に留めてよい。
 *
 * 所有者チェックは createFolder より前に置く。moveFileToFolder 失敗時に孤児フォルダが
 * 残る問題があるため、フォルダを作る前に「そもそも移動してよいか」を確定させる。
 */
export async function setupProjectFolder(spreadsheetId: string, title: string): Promise<string> {
    await assertSpreadsheetOwnedByCurrentUser(spreadsheetId);
    const rootId = await ensureAppRootFolder();
    const projectFolderId = await createFolder(title, rootId, APP_FOLDER_COLOR);
    await moveFileToFolder(spreadsheetId, projectFolderId);
    await saveProjectDriveFolderId(spreadsheetId, projectFolderId);
    return projectFolderId;
}

/**
 * プロジェクトフォルダ（tiab-reviewer-plugin/{title}）のIDを返す。
 * Config に記録済みで accessible ならそれを再利用し、trashed なら作り直す。
 * inaccessible/auth-error/transient-error の場合は setupProjectFolder（＝作り直し）へ
 * 絶対に進まず、型付きエラーを投げる（「見えない」を「無い」と誤認しないため。Issue #60）。
 */
async function ensureProjectFolder(spreadsheetId: string): Promise<string> {
    const saved = await getProjectDriveFolderId(spreadsheetId);
    if (saved) {
        const folderState = await resolveFolderState(saved);
        if (folderState === 'accessible') return saved;
        if (folderState !== 'trashed') {
            throw toDriveFolderError(saved, folderState);
        }
        // trashed: 確定した答えなので作り直してよい
    }
    const { title } = await getSpreadsheetInfo(spreadsheetId);
    return setupProjectFolder(spreadsheetId, title);
}

/**
 * プロジェクトのフルテキスト保存フォルダIDを返す。
 * Configシートに記録済みで accessible ならそれを再利用し、trashed なら作り直す。
 * inaccessible/auth-error/transient-error の場合は ensureProjectFolder へ進まず、
 * 型付きエラーを投げる（ensureProjectFolder 側の分類は上記コメント参照）。
 */
export async function ensureFulltextFolder(spreadsheetId: string): Promise<string> {
    const saved = await getFulltextDriveFolderId(spreadsheetId);
    if (saved) {
        const folderState = await resolveFolderState(saved);
        if (folderState === 'accessible') return saved;
        if (folderState !== 'trashed') {
            throw toDriveFolderError(saved, folderState);
        }
        // trashed: 確定した答えなので作り直してよい（project フォルダ側は ensureProjectFolder に委譲）
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

// ---------------------------------------------------------------------------
// Driveフォルダへ直接置かれた未登録PDFの取り込み（V1）
// Picker（mode=pdf）で選択されたファイルの検証・fulltextフォルダへのコピー・
// 冪等性チェック（appProperties検索）に使う。
// ---------------------------------------------------------------------------

/**
 * Drive ファイルのメタデータを取得する（Picker選択直後の検証用）。
 * Picker自体のMIME絞り込みは信用せず、mimeType の再確認や canCopy/canTrash の確認に使う。
 * driveId は共有ドライブ配下のファイルにのみ付与されるため、Shared Drive検出にも使う
 * （V1はMy Drive限定。共有ドライブは検出してブロックする）。
 */
export async function getDriveFileMetadata(fileId: string): Promise<DriveFileMetadata> {
    const token = await getAuthToken();
    const fields = 'id,name,mimeType,size,parents,trashed,driveId,capabilities(canCopy,canTrash),appProperties';
    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`Driveファイル情報の取得に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    return resp.json() as Promise<DriveFileMetadata>;
}

/**
 * Picker で選択したPDF（ユーザーのDrive上の既存ファイル）を、files.copy でfulltextフォルダへ
 * アプリ作成ファイルとして複製する。appProperties は呼び出し側が渡す
 * （sourceFileId / refId / spreadsheetId / importOperationId 等、冪等性判定や追跡に使う）。
 * copy を使う理由: move だとアプリ作成属性が付かず、drive.file スコープの他レビュアーから
 * 読めなくなる懸念があるため（.agent/artifacts/picker-drive-file-migration.md 参照）。
 */
export async function copyPdfToFulltextFolder(
    sourceFileId: string,
    folderId: string,
    fileName: string,
    appProperties: Record<string, string>
): Promise<DriveFileInfo> {
    const token = await getAuthToken();
    const resp = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id,webViewLink`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: fileName, parents: [folderId], appProperties }),
        }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`DriveのPDFコピーに失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    const data = await resp.json() as { id: string; webViewLink: string };
    return { id: data.id, webViewLink: data.webViewLink };
}

/**
 * 「Driveへ直接置かれたPDFの取り込み」の冪等性チェック用クエリを組み立てる（純関数）。
 * appProperties の sourceFileId と spreadsheetId の両方が一致し、ゴミ箱に無いファイルを探す。
 * `has { key='...' and value='...' }` の中括弧はDrive APIクエリ構文上必須で、
 * 複数の has 条件は and で連結する（括弧を省略するとASTが崩れて誤ヒットする恐れがあるため注意）。
 */
export function buildImportedCopyQuery(sourceFileId: string, spreadsheetId: string): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return [
        `appProperties has { key='sourceFileId' and value='${esc(sourceFileId)}' }`,
        `appProperties has { key='spreadsheetId' and value='${esc(spreadsheetId)}' }`,
        'trashed=false',
    ].join(' and ');
}

/**
 * 指定フォルダ直下の子ファイル（ゴミ箱を除く）を列挙する files.list 用クエリ（純関数）。
 * エスケープ方式は buildImportedCopyQuery と揃える（バックスラッシュを先に、
 * 続けてシングルクォートをエスケープする）。
 *
 * fulltext-access.ts（読み取り権限の再付与判定）から使われる。drive-api.ts はDrive APIを
 * 叩く低レイヤのモジュールで、fulltext-access.ts はその上のドメイン判定なので、
 * クエリ組み立て自体はここ（低レイヤ側）に置き、fulltext-access.ts からは import するだけの
 * 一方向にする（逆向きの import があると循環参照になり、将来どちらかがモジュール
 * トップレベルで相手のシンボルを使った瞬間にTDZでロード時クラッシュしうる）。
 */
export function buildFolderChildrenQuery(folderId: string): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${esc(folderId)}' in parents and trashed=false`;
}

/**
 * 指定した元ファイル（sourceFileId）が、このプロジェクト（spreadsheetId）向けに
 * 既に取り込み済み（fulltextフォルダへコピー済み）かどうかを調べる。
 * 見つかった場合はそのコピーの id/webViewLink/appProperties.refId を返す
 * （refId は「そのコピーがどの文献向けに作られたか」の判定に使う。
 * appProperties が無い/refIdキーが無い孤立コピーの場合は refId が undefined になる）。
 * ページネーションはしない（該当は通常0〜1件のため pageSize=1 で十分。
 * 同一ファイルが複数のReferenceへ対応付け直された場合に取りこぼす可能性があるのは
 * 既知の限界として許容する。実害は「本来再利用できたはずのコピーを再利用し損ねて
 * 新規コピーが1つ増える」程度で、データ破損には繋がらない）。
 * 検索自体（fetch）が失敗した場合は例外を投げる。検証フェーズ（表示用）の呼び出し側は
 * 「未取り込み」扱いにフォールバックしてよいが、実行直前の呼び出し側は fail-closed
 * （進めずエラーにする）こと。二重コピーを防ぐための冪等性チェックのため。
 */
export async function findImportedCopy(
    sourceFileId: string,
    spreadsheetId: string
): Promise<ImportedCopyMatch | null> {
    const token = await getAuthToken();
    const q = buildImportedCopyQuery(sourceFileId, spreadsheetId);
    const fields = 'files(id,webViewLink,appProperties)';
    const resp = await fetch(
        `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) {
        const error = await resp.json().catch(() => null);
        throw new Error(`取り込み済みファイルの検索に失敗しました: ${error?.error?.message || resp.statusText}`);
    }
    const data = await resp.json() as {
        files?: Array<{ id: string; webViewLink: string; appProperties?: Record<string, string> }>;
    };
    const first = data.files?.[0];
    if (!first) return null;
    return { id: first.id, webViewLink: first.webViewLink, refId: first.appProperties?.refId };
}

// ---------------------------------------------------------------------------
// 読み取り権限の再付与（Issue #60）
// 共同研究者がアップロードしたPDFを、他のメンバーが読めるようにする。
// ---------------------------------------------------------------------------

/**
 * listAccessibleFileIdsInFolder が読みに行くページ数の上限（1ページ pageSize=1000 なので
 * 最大2万件相当）。Drive が異常応答で同じ nextPageToken を返し続けた場合に、拡張機能が
 * ユーザーに進行状況を見せられないまま Drive API を無限に叩き続けるのを防ぐための安全弁。
 * 通常のプロジェクト規模（PDF高々数千件）では到達しない想定。
 */
const MAX_FOLDER_LIST_PAGES = 20;

/**
 * fulltext フォルダ直下の子ファイルのうち、現在のユーザーが実際にアクセスできる
 * ファイルIDの集合を返す（＝「読めるPDF」の真値）。
 *
 * 実測事実（2026-08-08, scripts/drive-file-probe/ ハーネスで確定。再検証不要）:
 * - **files.list は権限が無くても HTTP 200 + files: [] を返す。** HTTPステータスを
 *   「付与されているか」の判定に使ってはならない。中身の files[] を見て判定すること。
 * - **親フォルダ自体が未付与（files.get が 404）でも、files.list はそのフォルダを親に
 *   指定すれば付与済みの子ファイルは返す。** そのため folderId 自体へのアクセス可否は問わず、
 *   ここで得られた files[] の中身だけを「読める/読めない」の根拠にしてよい。
 * - Picker でフォルダを選択しても配下ファイルへは一切カスケードしない（別途確定済みの事実）。
 *   つまり Drive 側から「読めないファイル」を列挙する経路はこの API しか無い。
 *
 * PDFが1000件を超えるプロジェクトで取りこぼすと「読めない」と誤判定し無駄なPickerを
 * 出してしまうため、nextPageToken は MAX_FOLDER_LIST_PAGES に達するまで追う。上限に達した
 * 場合は例外にはせず、console.warn を出してそこまでに集めたIDで打ち切って返す
 * （取りこぼしがあっても「読める」ものを「読めない」と誤判定してPickerを余計に出すだけで、
 * 破壊的なことは起きないため）。
 */
export async function listAccessibleFileIdsInFolder(folderId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
        const token = await getAuthToken();
        const params = new URLSearchParams({
            q: buildFolderChildrenQuery(folderId),
            fields: 'nextPageToken,files(id)',
            pageSize: '1000',
        });
        if (pageToken) params.set('pageToken', pageToken);

        let resp: Response;
        try {
            resp = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
        } catch {
            throw new DriveTransientError(folderId);
        }

        const statusClass = classifyDriveApiStatus(resp.status);
        if (statusClass === 'auth-error') throw new DriveAuthError(folderId);
        if (statusClass === 'inaccessible') throw new DriveAccessDeniedError(folderId, resp.status);
        if (statusClass === 'transient-error') throw new DriveTransientError(folderId);

        let data: { files?: Array<{ id: string }>; nextPageToken?: string };
        try {
            data = await resp.json();
        } catch {
            throw new DriveTransientError(folderId);
        }

        for (const f of data.files ?? []) {
            if (f.id) ids.add(f.id);
        }
        pageToken = data.nextPageToken;
        pageCount += 1;

        if (pageToken && pageCount >= MAX_FOLDER_LIST_PAGES) {
            console.warn(
                `[listAccessibleFileIdsInFolder] ページ数が上限(${MAX_FOLDER_LIST_PAGES})に達したため打ち切ります:`,
                folderId
            );
            break;
        }
    } while (pageToken);

    return ids;
}
