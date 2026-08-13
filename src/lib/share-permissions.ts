/**
 * 共有解除（アクセス権削除）まわりの純粋関数群
 *
 * `sidepanel/features/sharing.ts`（共有ユーザー一覧・解除処理）から共通利用する。
 * DOM/fetch に依存しない純粋関数のみを置き、単体テストで検証できるようにする
 * （share-invite.ts と同じ方針）。
 */

/**
 * Google Drive Permissions API のレスポンス（の一部）を表す最小限の型。
 * sheets-api.ts の SpreadsheetPermission とは独立させ、このモジュールを
 * DOM/fetch非依存の純粋関数のみに保つ。
 */
export interface DrivePermissionLike {
    id?: string;
    role: string;
    type?: string;
    emailAddress?: string;
    displayName?: string;
}

/**
 * 指定した権限をアプリ側から解除してよいかどうかを判定する。
 *
 * 以下のいずれかに該当する場合は解除不可（false）:
 * - 管理者権限が無い（isAdmin=false）
 * - 権限IDが無い（Drive の permissions.delete には ID が必須）
 * - オーナー権限（role='owner'）
 * - type が 'user' 以外（リンク共有・ドメイン共有・グループ共有は対象外）
 * - emailAddress が無い
 * - emailAddress が自分自身と一致する（自分自身の解除はUIから禁止）
 */
export function canRemovePermission(
    p: DrivePermissionLike,
    opts: { isAdmin: boolean; selfEmail: string }
): boolean {
    if (!opts.isAdmin) return false;
    if (!p.id) return false;
    if (p.role === 'owner') return false;
    if (p.type && p.type !== 'user') return false;
    if (!p.emailAddress) return false;

    const normalizedTarget = p.emailAddress.trim().toLowerCase();
    const normalizedSelf = opts.selfEmail.trim().toLowerCase();
    if (normalizedTarget === normalizedSelf) return false;

    return true;
}

/**
 * 解除対象のファイルID一覧を「フォルダ優先」の順序で返す。
 * 空文字/null/undefined は除外し、重複も除外する。
 */
export function resolveRemovalTargets(
    folderId: string | null | undefined,
    spreadsheetId: string
): string[] {
    const candidates = [folderId, spreadsheetId];
    const targets: string[] = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (targets.includes(candidate)) continue;
        targets.push(candidate);
    }
    return targets;
}

/**
 * 指定メールアドレスに一致し、かつ解除可能（オーナーではない・type がユーザー・
 * 権限IDを持つ）な権限を1件探して返す。
 * メールアドレスの比較は前後空白除去＋小文字化で行う。
 */
export function findRemovableUserPermission(
    permissions: DrivePermissionLike[],
    email: string
): DrivePermissionLike | undefined {
    const normalizedEmail = email.trim().toLowerCase();
    return permissions.find(p => {
        if (!p.id) return false;
        if (p.role === 'owner') return false;
        if (p.type && p.type !== 'user') return false;
        if (!p.emailAddress) return false;
        return p.emailAddress.trim().toLowerCase() === normalizedEmail;
    });
}

/** 権限削除APIが失敗した際の分類 */
export type PermissionRemovalFailure = 'forbidden' | 'notFound' | 'inherited' | 'unknown';

/**
 * Drive Permissions API の削除エラー（HTTPステータス・エラーメッセージ）を分類する。
 * 親フォルダから継承された権限は 403 で返るが、Drive側の文言に "inherited" を
 * 含むため、通常の権限不足（forbidden）とは区別してユーザーへ案内する。
 */
export function classifyPermissionRemovalError(
    status: number,
    apiMessage?: string
): PermissionRemovalFailure {
    if (apiMessage && /inherited/i.test(apiMessage)) return 'inherited';
    if (status === 404) return 'notFound';
    if (status === 403) return 'forbidden';
    return 'unknown';
}

/** 解除失敗分類から表示する i18n メッセージキーへ変換する */
export function permissionRemovalMessageKey(failure: PermissionRemovalFailure): string {
    switch (failure) {
        case 'forbidden':
            return 'share_removeErrorForbidden';
        case 'notFound':
            return 'share_removeErrorNotFound';
        case 'inherited':
            return 'share_removeErrorInherited';
        case 'unknown':
        default:
            return 'share_removeErrorUnknown';
    }
}

/**
 * 共有リスト表示用にマージした1ユーザー分の権限情報。
 * `DrivePermissionLike` と異なり、表示に必要な role/emailAddress を必須にしている
 * （マージ時に role 不明・emailAddress 無しの権限は除外済みのため）。
 */
export interface MergedSharePermission {
    id?: string;
    role: 'owner' | 'writer' | 'reader';
    type?: string;
    emailAddress: string;
    displayName?: string;
}

/** リンク共有（type='anyone'）の検出結果。null は「リンク共有なし」。 */
export interface LinkSharePermission {
    role: 'writer' | 'reader';
}

/** mergePermissionsForDisplay の戻り値 */
export interface MergedPermissionsForDisplay {
    /** type='anyone' を除いた、メールアドレスでマージ済みのユーザー権限一覧 */
    users: MergedSharePermission[];
    /** リンク共有（type='anyone'）が存在する場合のみ非null */
    linkShare: LinkSharePermission | null;
}

/** role の強さ（owner > writer > reader）。同一メールのマージで強い方を残すために使う */
const ROLE_STRENGTH: Record<'owner' | 'writer' | 'reader', number> = {
    owner: 3,
    writer: 2,
    reader: 1,
};

function isDisplayableRole(role: string): role is 'owner' | 'writer' | 'reader' {
    return role === 'owner' || role === 'writer' || role === 'reader';
}

/**
 * フォルダ権限とスプレッドシート権限をマージし、共有リスト表示用の形にする純粋関数。
 *
 * `loadSharedUsers`（フォルダ・スプレッドシートの両方の権限をマージ表示する）から使う。
 * DOM/fetch には依存しない（このモジュールの既存方針を踏襲）。
 *
 * - `type === 'anyone'`（リンク共有）は users から除外し、`linkShare` として別枠で返す。
 *   role は writer 系（writer/owner）なら 'writer'、それ以外なら 'reader' に正規化する。
 *   フォルダ・スプレッドシート双方に別々の anyone 権限が付いているケースも想定し、
 *   どちらか一方でも writer 相当があれば 'writer' を優先する
 * - `emailAddress` が無い権限（グループ・ドメイン共有等）や、role が
 *   owner/writer/reader のいずれでもない権限（commenter 等）は users から除外する
 * - 同一メール（大文字小文字を無視）がフォルダ・スプレッドシート双方に存在する場合は、
 *   強い方の role（owner > writer > reader）で1行にまとめる
 * - `folderPerms` / `sheetPerms` は片方または両方が null/undefined/空配列でもよい
 *   （取得に失敗した側は呼び出し元が null を渡す想定。縮退時も残った側だけで表示できる）
 */
export function mergePermissionsForDisplay(
    folderPerms: DrivePermissionLike[] | null | undefined,
    sheetPerms: DrivePermissionLike[] | null | undefined
): MergedPermissionsForDisplay {
    const all = [...(folderPerms ?? []), ...(sheetPerms ?? [])];

    const anyonePerms = all.filter(p => p.type === 'anyone');
    let linkShare: LinkSharePermission | null = null;
    if (anyonePerms.length > 0) {
        const hasWriter = anyonePerms.some(p => p.role === 'writer' || p.role === 'owner');
        linkShare = { role: hasWriter ? 'writer' : 'reader' };
    }

    const byEmail = new Map<string, MergedSharePermission>();
    for (const p of all) {
        if (p.type === 'anyone') continue;
        if (!p.emailAddress) continue;
        if (!isDisplayableRole(p.role)) continue;

        const key = p.emailAddress.trim().toLowerCase();
        const existing = byEmail.get(key);
        if (!existing || ROLE_STRENGTH[p.role] > ROLE_STRENGTH[existing.role]) {
            byEmail.set(key, {
                id: p.id,
                role: p.role,
                type: p.type,
                emailAddress: p.emailAddress,
                displayName: p.displayName,
            });
        }
    }

    return { users: Array.from(byEmail.values()), linkShare };
}

/** handleRemoveShare の結果トーストを組み立てるための判定結果 */
export interface RemovalOutcomeSummary {
    /** 表示に使う i18n キー */
    key: string;
    /** t() に渡す引数の種別（'none' の場合は引数無しで t() を呼ぶ） */
    arg: 'email' | 'apiMessage' | 'none';
}

/**
 * 解除処理（成功件数・失敗分類の一覧）から、表示すべきトーストの i18n キーと
 * 引数の種別を判定する。
 *
 * 一部のターゲット（フォルダ/スプレッドシート）だけ成功し、他が失敗した場合を
 * 「成功」として隠さないよう、成功と失敗が両方ある場合は share_removePartial を返す
 * （「外したつもりで残っている」状態を利用者に気づかせるため）。
 *
 * 判定規則（この順で評価）:
 * - 成功1件以上・失敗0件 → share_removed（$1=メール）
 * - 成功1件以上・失敗1件以上 → share_removePartial（$1=メール）
 * - 成功0件・失敗0件（対象が見つからない） → share_removeNotFound（$1=メール）
 * - 成功0件・失敗1件以上 → 先頭の failure を permissionRemovalMessageKey で変換したキー
 *   （'unknown' のときのみ apiMessage を引数に、それ以外は引数無し）
 */
export function summarizeRemovalOutcome(
    successCount: number,
    failures: PermissionRemovalFailure[]
): RemovalOutcomeSummary {
    if (successCount > 0 && failures.length === 0) {
        return { key: 'share_removed', arg: 'email' };
    }
    if (successCount > 0 && failures.length > 0) {
        return { key: 'share_removePartial', arg: 'email' };
    }
    if (successCount === 0 && failures.length === 0) {
        return { key: 'share_removeNotFound', arg: 'email' };
    }

    const firstFailure = failures[0];
    const key = permissionRemovalMessageKey(firstFailure);
    return { key, arg: firstFailure === 'unknown' ? 'apiMessage' : 'none' };
}
