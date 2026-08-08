/**
 * drive-picker-result.ts - Picker（mode=pdf）からのlaunchWebAuthFlowリダイレクトを解釈する
 *
 * src/webapp/picker.ts の returnFilesToExtension / returnCancelledToExtension が
 * URLフラグメントへ書き込む `files=<JSON>` / `cancelled=1` を解析する。
 * Pickerはブラウザ拡張の外（GitHub Pagesでホストされる別オリジン）で動くページのため、
 * ここで返ってくるJSONの形状は信用せず、利用側で必ず validatePickedFiles を通すこと。
 */

export interface PickedDriveFile {
    id: string;
    name: string;
    mimeType: string;
}

export type PdfPickerRedirectResult =
    | { files: unknown[] }
    | 'cancelled'
    | null;

/**
 * launchWebAuthFlow のリダイレクトURLを解析する。
 * フラグメントが読めない/JSONとして壊れている場合は null（呼び出し側でエラー表示する）。
 */
export function parsePdfPickerRedirect(redirectUrl: string): PdfPickerRedirectResult {
    let hash: string;
    try {
        hash = new URL(redirectUrl).hash.replace(/^#/, '');
    } catch {
        return null;
    }
    const params = new URLSearchParams(hash);
    if (params.get('cancelled') === '1') return 'cancelled';
    const filesParam = params.get('files');
    if (!filesParam) return null;
    try {
        const parsed: unknown = JSON.parse(filesParam);
        if (!Array.isArray(parsed)) return null;
        return { files: parsed };
    } catch {
        return null;
    }
}

function isValidPickedFile(value: unknown): value is PickedDriveFile {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.id === 'string' && v.id.length > 0
        && typeof v.name === 'string'
        && typeof v.mimeType === 'string';
}

/** 一度に取り込み対応付け処理へ渡すファイル数の上限。超過分は無視して呼び出し側に通知する。 */
export const MAX_PICKED_FILES = 50;

export interface PickedFilesValidation {
    valid: PickedDriveFile[];
    invalidCount: number;
    duplicateCount: number;
    overflowCount: number;
}

// ---------------------------------------------------------------------------
// mode=regrant（読み取り権限の再付与）用リダイレクトの解釈
//
// mode=pdf と違い、選択ファイルの一覧ではなく選択件数だけを granted=<件数> として受け取る。
// 再付与は数百件を一度に選びうるため、ファイル一覧をURLフラグメントに載せると巨大化して
// リダイレクト捕捉が壊れる恐れがある。また付与はユーザーが「選択」を押した時点で
// サーバー側に確定済みのため、拡張機能が一覧そのものを受け取る必要が無い
// （表示に使う真値は listAccessibleFileIdsInFolder による再度の files.list で取り直す）。
// ---------------------------------------------------------------------------

export type RegrantPickerRedirectResult = { granted: number } | 'cancelled' | null;

/**
 * mode=regrant のPickerからのlaunchWebAuthFlowリダイレクトを解析する。
 * granted は非負整数としてパースできる場合のみ受理し、それ以外（欠落・小数・負数・非数値）は
 * null（呼び出し側でエラー表示する）。
 */
export function parseRegrantPickerRedirect(redirectUrl: string): RegrantPickerRedirectResult {
    let hash: string;
    try {
        hash = new URL(redirectUrl).hash.replace(/^#/, '');
    } catch {
        return null;
    }
    const params = new URLSearchParams(hash);
    if (params.get('cancelled') === '1') return 'cancelled';
    const grantedParam = params.get('granted');
    if (grantedParam === null || !/^\d+$/.test(grantedParam)) return null;
    const granted = Number(grantedParam);
    if (!Number.isSafeInteger(granted)) return null;
    return { granted };
}

/**
 * Picker応答の各要素が PickedDriveFile として妥当か（id/name/mimeTypeがすべてstring）を検証し、
 * 同一idの重複を除去し、MAX_PICKED_FILES件を超える分は切り捨てる。
 * 形状不正・重複・上限超過はいずれも該当件数を除外して数だけ数える
 * （1件の不正/重複で全体を捨てない）。
 */
export function validatePickedFiles(files: unknown[]): PickedFilesValidation {
    const dedupedValid: PickedDriveFile[] = [];
    const seenIds = new Set<string>();
    let invalidCount = 0;
    let duplicateCount = 0;

    for (const f of files) {
        if (!isValidPickedFile(f)) {
            invalidCount += 1;
            continue;
        }
        if (seenIds.has(f.id)) {
            duplicateCount += 1;
            continue;
        }
        seenIds.add(f.id);
        dedupedValid.push(f);
    }

    const overflowCount = Math.max(0, dedupedValid.length - MAX_PICKED_FILES);
    const valid = overflowCount > 0 ? dedupedValid.slice(0, MAX_PICKED_FILES) : dedupedValid;

    return { valid, invalidCount, duplicateCount, overflowCount };
}
