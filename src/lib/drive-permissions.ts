// drive-permissions.ts - Google Drive の共有権限と管理者権限の確認

import { platform } from '../platform';
import { driveFetch } from './drive-shared-drive';

/**
 * スプレッドシートの権限情報を取得
 */
export interface SpreadsheetPermission {
    role: 'owner' | 'writer' | 'reader';
    emailAddress: string;
    /** 権限ID（permissions.delete に必要。取得できない場合がある） */
    id?: string;
    /** 'user' / 'group' / 'domain' / 'anyone' 等（リンク共有等の判別に使う） */
    type?: string;
    displayName?: string;
}

/**
 * 指定ファイル（スプレッドシート/フォルダ問わず）の権限一覧を取得する。
 * 解除処理で権限IDが必要なため、role/emailAddress に加えて id/type/displayName も取得する。
 */
export async function getFilePermissions(fileId: string): Promise<SpreadsheetPermission[]> {
    const token = await platform().getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`,
        {},
        { token }
    );

    if (!response.ok) {
        throw new Error(`Failed to get permissions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.permissions || [];
}

/**
 * スプレッドシートの権限情報を取得（getFilePermissions への委譲）
 * 呼び出し元（isUserAdmin / project.ts / fulltext.ts 等）への影響を避けるため、
 * シグネチャ・外部挙動は変更しない。
 */
export async function getSpreadsheetPermissions(spreadsheetId: string): Promise<SpreadsheetPermission[]> {
    return getFilePermissions(spreadsheetId);
}

/**
 * Drive Permissions API のエラーレスポンス（ステータスコード・エラーメッセージ）を保持する例外。
 * 呼び出し元で classifyPermissionRemovalError に渡し、権限不足/継承権限などを判別する。
 */
export class DrivePermissionError extends Error {
    status: number;
    apiMessage: string;

    constructor(status: number, apiMessage: string) {
        super(apiMessage);
        this.name = 'DrivePermissionError';
        this.status = status;
        this.apiMessage = apiMessage;
    }
}

/**
 * 指定ファイル（スプレッドシート/フォルダ）から権限を1件削除する。
 *
 * **注意**: フォルダ共有プロジェクトでは、フォルダ側の権限を削除しないと
 * 配下のスプレッドシート/フルテキストPDFへのアクセスが（フォルダからの継承として）
 * 残り続けてしまう。呼び出し側は「共有先（フォルダがあればフォルダ優先）」の各対象に
 * 対して本関数を呼ぶこと。
 */
export async function deletePermission(fileId: string, permissionId: string): Promise<void> {
    const token = await platform().getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
        { method: 'DELETE' },
        { token }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        const apiMessage = error?.error?.message || response.statusText;
        throw new DrivePermissionError(response.status, apiMessage);
    }
}

/**
 * emailMessage クエリパラメータの、encodeURIComponent 後の長さの上限バジェット。
 * Drive REST API の URL 全体には概ね8KB程度の実用上の制限があるため、その半分程度を
 * emailMessage 用に確保する。日本語1文字は encodeURIComponent で最大9文字
 * （UTF-8 3バイト → "%XX%XX%XX"）に膨らむため、元の文字数ではなくエンコード後の
 * 長さを基準に切り詰める。招待文テンプレート（日本語で約300文字）はエンコード後でも
 * 十分このバジェット内に収まるため、実運用で切り詰めが発生することはまず無い。
 */
const EMAIL_MESSAGE_ENCODED_BUDGET = 4000;

/** truncateEmailMessageForQuery が1回のループで末尾から削るコードポイント数 */
const TRUNCATE_CHUNK_SIZE = 50;

/**
 * emailMessage を、encodeURIComponent 後の長さが budget 以内に収まるまで末尾から削る。
 * サロゲートペア（絵文字等）を途中で分断しないよう Array.from でコードポイント単位に
 * 分割してから操作する。ループのたびに配列が必ず短くなるため無限ループにはならない。
 */
function truncateEmailMessageForQuery(message: string, budget: number): string {
    if (encodeURIComponent(message).length <= budget) return message;
    const chars = Array.from(message);
    while (chars.length > 0 && encodeURIComponent(chars.join('')).length > budget) {
        chars.splice(-TRUNCATE_CHUNK_SIZE);
    }
    return chars.join('');
}

/**
 * addPermission のオプション引数（後方互換のため第5引数のオプションオブジェクトとして追加）。
 */
export interface AddPermissionOptions {
    /**
     * Driveの共有通知メールを送るかどうか。省略時はDriveの既定挙動
     * （emailMessage指定時は通知あり、未指定時はDriveの既定＝type=userなら通知あり）に従う。
     * false を明示すると、emailMessage の有無にかかわらず sendNotificationEmail=false を
     * クエリへ付ける（emailMessageを載せていても通知自体を送らないなら本文は届かないため、
     * 明示指定を優先する）。共有先を複数回に分けて呼ぶフロー（例: スプレッドシートに
     * 招待文つきで共有した後、同じ相手へフォルダもベストエフォートで共有する）で、
     * 通知メールが2通届くのを防ぐ用途。
     */
    sendNotificationEmail?: boolean;
}

/**
 * 共有設定を追加（Google Drive API）
 *
 * @param fileId 共有対象のファイル/フォルダID
 * @param emailAddress 共有相手のメールアドレス
 * @param role 付与する権限（既定: writer）
 * @param emailMessage Driveの共有通知メールに載せる本文（省略時はDrive既定の通知文のみ）。
 *   **注意**: Drive API v3 permissions.create の仕様上、emailMessage は
 *   リクエストボディではなく **URLのクエリパラメータ** で渡す
 *   （https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create）。
 *   Permission リソース（ボディ）のスキーマに emailMessage フィールドは存在せず、
 *   ボディに入れても Drive 側は無視する（＝通知メール本文が変わらない）ので注意すること。
 *   emailMessage 指定時は sendNotificationEmail=true も明示的にクエリへ付ける
 *   （type=user 時は本来既定で true だが、本文を載せる以上メール送信自体を必須要件として
 *   明示する）。emailMessage 未指定時はクエリを一切付けず、従来と同一のリクエストにする。
 *   URL長制限に配慮し、エンコード後の長さが EMAIL_MESSAGE_ENCODED_BUDGET を超える場合は
 *   末尾を切り詰める。
 * @param options 通知抑制など追加オプション（省略時は既存呼び出しと同一挙動。後方互換）。
 *   詳細は {@link AddPermissionOptions} を参照。
 */
export async function addPermission(
    fileId: string,
    emailAddress: string,
    role: 'writer' | 'reader' = 'writer',
    emailMessage?: string,
    options?: AddPermissionOptions
): Promise<void> {
    const token = await platform().getAuthToken();

    const body = {
        role: role,
        type: 'user',
        emailAddress: emailAddress,
    };

    // クエリ文字列は URLSearchParams ではなく encodeURIComponent を自前で使って組み立てる。
    // URLSearchParams.toString() は application/x-www-form-urlencoded 形式のため、
    // 空白を %20 ではなく + にエンコードしてしまう。招待文には「TiAb Review Plugin」
    // 「Google Chrome」など空白を含む文字列が多数あり、Google側が + をリテラルの
    // プラス記号として解釈した場合、共有相手に届くメール本文が「TiAb+Review+Plugin」の
    // ように壊れて見えるリスクがある。%20（RFC 3986）はどちらの解釈でも確実に空白になる
    // ため、こちらに寄せている。「URLSearchParamsの方が綺麗」という理由で戻さないこと。
    let queryString = '';
    if (emailMessage) {
        const truncated = truncateEmailMessageForQuery(emailMessage, EMAIL_MESSAGE_ENCODED_BUDGET);
        const sendNotificationEmail = options?.sendNotificationEmail === false ? 'false' : 'true';
        queryString = `?emailMessage=${encodeURIComponent(truncated)}&sendNotificationEmail=${sendNotificationEmail}`;
    } else if (options?.sendNotificationEmail === false) {
        // emailMessage が無い場合のみ、明示的な通知抑制指定を反映する。
        // 未指定（options自体が無い、または sendNotificationEmail が無い）ときは
        // 従来どおりクエリを一切付けない（Drive既定の通知ありの挙動を変えない）。
        queryString = '?sendNotificationEmail=false';
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions${queryString}`;

    const response = await driveFetch(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        { token }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || response.statusText);
    }
}

/**
 * ユーザーが管理者権限（編集権限）を持っているかチェック
 * - Permissions APIがつかえない場合（drive.fileスコープの制限など）は
 *   ファイルのcapabilitiesをチェックする
 */
export async function isUserAdmin(spreadsheetId: string, userEmail: string): Promise<boolean> {
    console.log('[isUserAdmin] Starting check for:', userEmail);
    try {
        // 方法1: Permissions API (既存)
        try {
            console.log('[isUserAdmin] Trying permissions API...');
            const permissions = await getSpreadsheetPermissions(spreadsheetId);
            console.log('[isUserAdmin] Got permissions:', permissions.length);

            const userPermission = permissions.find(p => p.emailAddress === userEmail);
            console.log('[isUserAdmin] User permission:', userPermission);

            if (userPermission) {
                const isAdmin = userPermission.role === 'owner' || userPermission.role === 'writer';
                console.log('[isUserAdmin] Result from permissions:', isAdmin);
                return isAdmin;
            }
        } catch (permError) {
            console.warn('[isUserAdmin] Permissions check failed:', permError);
        }

        // 方法2: Capabilities API (Fallback)
        console.log('[isUserAdmin] Trying capabilities fallback...');
        const token = await platform().getAuthToken();
        const response = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=capabilities(canEdit,canShare)`,
            {},
            { token }
        );

        console.log('[isUserAdmin] Capabilities response status:', response.status);
        if (response.ok) {
            const data = await response.json();
            console.log('[isUserAdmin] Capabilities data:', data);
            const canEdit = data.capabilities?.canEdit === true;
            console.log('[isUserAdmin] Result from capabilities:', canEdit);
            return canEdit;
        }

        console.log('[isUserAdmin] All checks failed, returning false');
        return false;
    } catch (error) {
        console.error('[isUserAdmin] Error:', error);
        return false;
    }
}
