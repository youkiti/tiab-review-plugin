// drive-shared-drive.ts - 共有ドライブ（Shared drives）対応の共通パラメータ
//
// Drive API v3 は、共有ドライブ配下のファイル・フォルダを既定では一切扱わない。
// `drive.file` の付与があっても、パラメータが無ければ「アクセス権が無い」のと
// 区別が付かない失敗の仕方をする（2026-08-15 実測。詳細は AGENTS.md「共有ドライブ
// （Shared drives）で実測して確定した挙動」）:
//
// | API                    | 付けなかったときの失敗の仕方        |
// | ---------------------- | ----------------------------------- |
// | files.get（メタデータ）| 404 notFound                        |
// | files.list             | **HTTP 200 + 0件（silent）**        |
// | files.create           | 404 File not found: <folderId>      |
// | files.copy             | 404 同上                            |
// | alt=media（実体取得）  | — （唯一パラメータ無しでも成功する）|
//
// 最も危険なのが `files.list` で、200 + 0件を返すため「フォルダが空」と区別が付かない。
// そのため**個別の呼び出し側で必要性を判断せず、Drive API を叩く全経路へ機械的に付ける**
// 方針を採り、その適用点をこのモジュールに集約する。マイドライブ上のファイルに対しては
// このパラメータは無害（挙動が変わらない）ので、経路ごとの出し分けはしない。
//
// `alt=media` は実測上パラメータ無しでも成功するが、**付けても成功する**ことを同じ測定で
// 確認済みのため、例外を作らず一律で付ける（「ここは付けなくてよい経路」を残すと、
// 後から増える呼び出しでどちらが正しいのかを毎回判断することになるため）。

/**
 * Drive API の呼び出し種別。
 * - `item`: 単一リソースを指すもの（files.get / create / copy / update / permissions.* など）。
 *   `supportsAllDrives=true` だけで足りる。
 * - `list`: `files.list`。返す集合そのものを広げる必要があるため
 *   `includeItemsFromAllDrives=true` も要る（`supportsAllDrives` 単体では 0件のまま）。
 */
export type DriveCallKind = 'item' | 'list';

/**
 * Drive API のリクエストURLへ共有ドライブ対応パラメータを付与する。
 * クエリ文字列の有無は自動で判別するため、呼び出し側は `?` / `&` を意識しなくてよい。
 *
 * `corpora=drive&driveId=` は不要（`supportsAllDrives` + `includeItemsFromAllDrives` だけで
 * 共有ドライブ配下に到達することを実測で確認済み）。共有ドライブIDを知らなくても済むこの
 * 形を既定とし、`corpora` を足す実装を新設しないこと。
 */
export function withSharedDriveParams(url: string, kind: DriveCallKind = 'item'): string {
    const separator = url.includes('?') ? '&' : '?';
    const params = kind === 'list'
        ? 'supportsAllDrives=true&includeItemsFromAllDrives=true'
        : 'supportsAllDrives=true';
    return `${url}${separator}${params}`;
}
