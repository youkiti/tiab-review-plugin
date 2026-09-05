// references.ts - References タブの読み書き（ヘッダー管理・文献CRUD・フルテキスト状態）
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema、行変換は ./codecs を参照。
// Decisions タブ側は ./decisions を参照（本ファイルからは import しない）。

import type { Reference, FulltextStatus } from '../types';
import { t } from '../i18n';
import {
    buildFulltextUrlUpdateData,
    validateFulltextDriveHeaders,
} from '../fulltext-drive-write';
import type { FulltextUrlUpdateEntry } from '../fulltext-drive-write';
import {
    SHEETS_API_BASE,
    getAuthToken,
    getSheetValues,
    getSheetValuesBatch,
    appendRows,
    updateRange,
    getSheetIdByName,
    batchUpdateRanges,
} from './transport';
import {
    REFERENCES_SHEET,
    DECISIONS_SHEET,
    REFERENCES_HEADERS,
    DECISIONS_HEADERS,
    REFERENCES_LAST_COLUMN,
    DECISIONS_LAST_COLUMN,
    columnNumberToLetter,
    validateReferencesManagedHeaders,
} from './schema';
import { parseReferenceValues } from './codecs';

/**
 * シートのヘッダーを確認し、不足があれば更新する
 *
 * References側のヘッダー行の範囲は `A1:${REFERENCES_LAST_COLUMN}1` のように REFERENCES_HEADERS の
 * 長さから導出する（Decisions側の `A1:${DECISIONS_LAST_COLUMN}1` と同じ流儀）。以前は `A1:Z1` を
 * 直書きしていたが、26列目がちょうどZ列なだけの偶然の一致だった。次に列を1本足して27列になった
 * 瞬間、読み取りが打ち切られて毎回ヘッダーPUTを発行し続け、かつ27要素の行をA:Z（26列）の範囲へ
 * 書き込もうとしてSheets APIがエラーを返す事故になるため、直書きに戻さないこと。
 *
 * referencesHeader を渡すと、Referencesヘッダー行のGETを省略してそれを使う
 * （Issue #153 工程2 チャンク2）。connectToSpreadsheet() が validateSpreadsheetFormat() で
 * 既に読んだヘッダー行をそのまま渡すことで、接続時の References ヘッダー確認GETを1回にまとめる。
 * 省略時（未指定）は従来どおりここで自前に読む＝この引数を渡さない既存の呼び出し元
 * （ensureFulltextDriveColumnsOnce・updateReferenceColumnByRefId・既存テスト）の挙動は変えない。
 * Decisions側のヘッダー確認・移行はこの引数と無関係に、これまでどおり独立して毎回読み直す
 * （References側の判定結果に関わらず必ず到達させる、という既存の不変条件は変更していない）。
 */
export async function ensureHeaders(spreadsheetId: string, referencesHeader?: string[]): Promise<void> {
    try {
        const values = referencesHeader
            ? [referencesHeader]
            : await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:${REFERENCES_LAST_COLUMN}1`);
        if (!values || values.length === 0) return;

        const currentHeaders = values[0];

        // アプリの後付け列（W列以降）をユーザーが既に独自ヘッダー名で使っていないか、
        // ヘッダー行をPUTする前に検証する。
        //
        // 【経緯】この検証は元々 W/X列（fulltext_drive_source_id/fulltext_drive_copy_id）限定
        // だった（PR #105 実機確認で発覚。ユーザーが独自の23列目以降を1本だけ足したシートでは、
        // 「列数が足りない」分岐に入って W1 のユーザー独自名を無警告で fulltext_drive_source_id に
        // 改名し、直後の書き込みで W 列のデータごと上書きしてしまっていた）。
        // その後 record_type/related_ref_id（Y/Z列、Issue #118）を追加した際にこの検証が
        // 追従しておらず、同じ穴がそのまま再発した:
        //   - 25列のシート（A〜Xの24列＋ユーザー独自の25列目）: 25 < 26 で「不足」分岐に入るが、
        //     旧検証は W/X（index 22/23）しか見ないため通過し、A1:Z1 を丸ごとPUTしてユーザーの
        //     25列目を無警告で record_type に改名してしまう。
        //   - 26列のシート（A〜X＋ユーザー独自の2列）: 26 は REFERENCES_HEADERS.length と等しく
        //     「移行済み」と誤判定され、検証自体が一切走らない。
        //
        // 二度と列を足すたびにこの穴が再発しないよう、検証対象を「W列（index 22。A〜Vの22列は
        // 旧バージョンから存在する安定プレフィックスで、それ以降がこのアプリの後付け列。
        // ユーザーが独自列を足すならこの位置以降になる）から REFERENCES_HEADERS.length-1 まで」に
        // 一般化した（validateReferencesManagedHeaders）。次に列を1本足せば、その列は自動で
        // この検証範囲に含まれる。また「列数が足りている場合は検証しない」という誤判定も
        // なくすため、列数に関わらず常にこの検証を行う。
        const managedHeaderCheck = validateReferencesManagedHeaders(currentHeaders);
        if (!managedHeaderCheck.ok) {
            console.warn(
                '[ensureHeaders] References header conflict: managed columns conflict with user-defined headers',
                { conflicts: managedHeaderCheck.conflicts }
            );
        } else if (currentHeaders.length < REFERENCES_HEADERS.length) {
            // ヘッダーが不足している場合（例: 古いバージョンで作成されたシート）のみPUTする。
            // 列数が足りている場合（上の else if に入らない）はPUTしない＝挙動不変。
            console.log('[ensureHeaders] Updating headers...', { current: currentHeaders.length, expected: REFERENCES_HEADERS.length });

            // 既存のヘッダーが期待されるヘッダーのプレフィックスと一致するか確認（念のため）
            // A〜V列は一致しなくても、このアプリで管理する以上は更新して良いとする。
            // W列以降（アプリの後付け列）だけは例外で、一致しない場合はこの分岐に入らず
            // （上の managedHeaderCheck.ok により）更新しない

            // 行1全体を更新
            await updateRange(spreadsheetId, `${REFERENCES_SHEET}!A1:${REFERENCES_LAST_COLUMN}1`, [REFERENCES_HEADERS]);
            console.log('[ensureHeaders] Headers updated');
        }
    } catch (error) {
        console.error('[ensureHeaders] Error:', error);
        // エラーはログ出力のみで、処理は続行させる（接続をブロックしない）
    }

    // Decisions タブも同様に移行する（screening_phase 列などの追加分）
    // ヘッダーが欠けていると getDecisions がヘッダー基準で読むため、
    // K列に保存した fulltext 判定が phase 不明 = tiab 扱いになってしまう
    try {
        const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A1:Z1`);
        if (!values || values.length === 0) return;

        const currentHeaders = values[0];

        if (currentHeaders.length < DECISIONS_HEADERS.length) {
            console.log('[ensureHeaders] Updating Decisions headers...', { current: currentHeaders.length, expected: DECISIONS_HEADERS.length });
            await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A1:${DECISIONS_LAST_COLUMN}1`, [DECISIONS_HEADERS]);
            console.log('[ensureHeaders] Decisions headers updated');
        }
    } catch (error) {
        console.error('[ensureHeaders] Decisions error:', error);
        // エラーはログ出力のみで、処理は続行させる（接続をブロックしない）
    }
}

/** ensureFulltextDriveColumnsOnce() の判定結果。usable=false のとき actualW/actualX に実際のヘッダー名が入る */
interface FulltextDriveColumnsStatus {
    usable: boolean;
    actualW: string;
    actualX: string;
}

// spreadsheetId → ensureFulltextDriveColumnsOnce() の実行結果 Promise。
// セッション内で同一スプレッドシートへの2回目以降の書き込みが Sheets を読み直さないための memo。
const fulltextDriveColumnsReadyBySpreadsheetId = new Map<string, Promise<FulltextDriveColumnsStatus>>();

/**
 * References!W/X（fulltext_drive_source_id/fulltext_drive_copy_id）が書き込み可能かどうかを、
 * 書き込み前に一度だけ判定する。
 *
 * 1. ensureHeaders() で列不足（旧22列シート等）を24列へ拡張する
 * 2. 拡張後もW/Xのヘッダーが期待名と一致しない場合（ユーザーが独自の23列目以降を追加していた等）は
 *    usable=false を返す。呼び出し側（updateReferenceFulltextUrls）はこれを見て、
 *    Drive直接取り込み（driveSource が非null）を伴う場合のみ fail-fast でエラーにし、
 *    それ以外（OA検索・手動アップロード等、driveSource=null）は W/X を書かずに T:U だけ書く
 *    （この関数自体は throw しない。書き込み可否の判定だけに専念する）。
 *
 * fulltext ページ（src/fulltext/fulltext.ts）はサイドパネル接続時の ensureHeaders() を経由しないため、
 * この関数がW/X列を保証する唯一の経路になる。書き込みのたびに Sheets を読み直さないよう
 * spreadsheetId 単位でメモ化するが、**メモ化するのは usable=true（正常）の結果だけ**。
 * usable=false（ユーザー独自列と衝突）をキャッシュしてしまうと、エラーメッセージの指示どおり
 * ユーザーがシートの列名を直しても、拡張機能を再読み込みするまで反映されない。衝突している
 * 間は呼び出しのたびに ensureHeaders() + ヘッダー読み取りが走ることになるが、稀なケースなので
 * 許容する。読み取り自体が失敗した場合も同様にメモを残さず、次回呼び出しで再試行できるようにする。
 */
function ensureFulltextDriveColumnsOnce(spreadsheetId: string): Promise<FulltextDriveColumnsStatus> {
    const cached = fulltextDriveColumnsReadyBySpreadsheetId.get(spreadsheetId);
    if (cached) return cached;

    const promise = (async (): Promise<FulltextDriveColumnsStatus> => {
        await ensureHeaders(spreadsheetId);
        const headerValues = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:X1`);
        const check = validateFulltextDriveHeaders(headerValues[0] ?? []);
        return { usable: check.ok, actualW: check.actualW, actualX: check.actualX };
    })().then((result) => {
        if (!result.usable) {
            // 衝突が解消されたかもしれないため、次回呼び出しで再判定できるようキャッシュに残さない
            fulltextDriveColumnsReadyBySpreadsheetId.delete(spreadsheetId);
        }
        return result;
    }).catch((error) => {
        fulltextDriveColumnsReadyBySpreadsheetId.delete(spreadsheetId);
        throw error;
    });

    fulltextDriveColumnsReadyBySpreadsheetId.set(spreadsheetId, promise);
    return promise;
}

/** テスト用: ensureFulltextDriveColumnsOnce() のメモ化キャッシュを破棄する */
export function invalidateFulltextDriveColumnsMemo(): void {
    fulltextDriveColumnsReadyBySpreadsheetId.clear();
}

/**
 * スプレッドシートの形式を検証
 * - Referencesタブが存在するか
 * - 最初の3列が ref_id, title, abstract か
 *
 * 検証自体はA1:C1で足りるが、直後に呼ばれる ensureHeaders() が同じ行をヘッダー移行の
 * 判定に必要とする（Issue #153 工程2 チャンク2）。ここでReferencesヘッダー行を
 * フル幅（A1:{REFERENCES_LAST_COLUMN}1）で1回読み、有効な場合は referencesHeader として
 * 返すことで、connectToSpreadsheet() 側が ensureHeaders() へ渡し直し、
 * ensureHeaders() 内での再取得（2回目のGET）を省略できるようにする。
 * 妥当性判定のロジック自体（先頭3列の一致確認）は変更していない。
 */
export async function validateSpreadsheetFormat(spreadsheetId: string): Promise<{ valid: boolean; error?: string; referencesHeader?: string[] }> {
    try {
        const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:${REFERENCES_LAST_COLUMN}1`);

        if (!values || values.length === 0) {
            return {
                valid: false,
                error: t('error_unsupportedFormat')
            };
        }

        const headers = values[0];
        const expectedHeaders = ['ref_id', 'title', 'abstract'];

        if (headers.length < 3 ||
            headers[0] !== expectedHeaders[0] ||
            headers[1] !== expectedHeaders[1] ||
            headers[2] !== expectedHeaders[2]) {
            return {
                valid: false,
                error: t('error_unsupportedFormat')
            };
        }

        return { valid: true, referencesHeader: headers };
    } catch (error) {
        // Referencesタブが存在しない場合もエラーになる
        return {
            valid: false,
            error: t('error_unsupportedFormat')
        };
    }
}

/**
 * References タブから文献一覧を取得する。
 *
 * 【除外なしの経路】論理削除された行（duplicate_of 非空、isLogicallyDeleted() 参照）も
 * 含めて全件返す。重複レビューUI（src/sidepanel/features/duplicate-review.ts）が
 * 論理削除済みの行を必要とする理由は2つ: ① resolveSurvivor() が「論理削除済みの相手から
 * 残っている側」を辿り直すのに duplicate_of の指す先の行が要る、② isPairAlreadySettled() が
 * survivor の収束判定・相互削除（同時更新の競合）の検出に論理削除済みの行を見る必要がある
 * （Issue #147 外部レビュー指摘。以前は「重複レビューUIの『やっぱり戻す』操作に必要」と
 * 書いていたが、個別の統合判断をユーザーが取り消す一般的なUIは実装されていない。実際に
 * duplicateOf: null を書くのは相互削除の自動修復と手動の「修復する」ボタンに限られる）。
 * 除外を反映してほしい呼び出し元（TiAb スクリーニング画面など）は getReferencesWithStatus() を使うこと。
 */
export async function getReferences(spreadsheetId: string): Promise<Reference[]> {
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:${REFERENCES_LAST_COLUMN}`);
    return parseReferenceValues(values);
}

/**
 * 1件の Reference を REFERENCES_HEADERS の並び順（A〜Z列）の行配列に組み立てる（addReferences 用の純関数）。
 *
 * fulltext_url 〜 fulltext_drive_copy_id（index 19〜23、T〜X列）はインポート時点では
 * どのパーサ（RIS/CTG/ICTRP）も値を持たないが、record_type / related_ref_id（index 24〜25、
 * Y/Z列）を末尾に書くには、その手前の5列を明示的に空文字でパディングして位置を合わせる必要がある。
 * パディングを省略すると record_type/related_ref_id が fulltext_url/fulltext_status の位置に
 * ずれ込み、既存のフルテキスト取得状態列を破壊してしまう。
 *
 * record_type は未設定なら空文字で書く（インポート時点で確定値を持つのは CTG/ICTRP パーサのみ。
 * 判定自体は isRegistrationRecord() を参照）。
 *
 * duplicate_of（index 26、AA列）は Issue #145 チャンク2 で追加。インポート時点では重複判定が
 * 済んでいない（自動スキップ対象は addReferences() の呼び出し前に取り除かれる想定）ため常に
 * 空文字で書く。この行を後から重複として除外するのは setDuplicateOf() の役割。
 *
 * 【この関数は位置ベースで配列を組み立てている】列を足すときは必ず配列の末尾に追加すること。
 * 途中に差し込むと、それ以降の既存列がすべて1つずつずれて破壊される。
 */
export function buildReferenceInsertRow(ref: Reference): string[] {
    return [
        ref.ref_id,
        ref.title,
        ref.abstract || '',
        ref.year?.toString() || '',
        ref.authors || '',
        ref.journal || '',
        ref.volume || '',
        ref.issue || '',
        ref.pages || '',
        ref.issn || '',
        ref.doi || '',
        ref.pmid || '',
        ref.url || '',
        ref.source || '',
        ref.imported_at || '',
        ref.imported_by || '',
        ref.dedupe_key || '',
        ref.source_file || '',
        ref.screening_set || '',
        '', // fulltext_url（index 19） — インポート時点では未設定のため空文字パディング
        '', // fulltext_status（index 20）
        '', // fulltext_set（index 21）
        '', // fulltext_drive_source_id（index 22）
        '', // fulltext_drive_copy_id（index 23）
        ref.record_type || '', // index 24
        ref.related_ref_id || '', // index 25
        ref.duplicate_of || '', // index 26
    ];
}

/**
 * 文献を追加（RISインポート用）
 */
export async function addReferences(spreadsheetId: string, references: Reference[]): Promise<void> {
    if (references.length === 0) return;

    const rows = references.map(buildReferenceInsertRow);

    await appendRows(spreadsheetId, REFERENCES_SHEET, rows);
}

/**
 * 文献の fulltext_url / fulltext_status と、Drive直接取り込みの冪等性の真値
 * （fulltext_drive_source_id / fulltext_drive_copy_id）を更新する（OA URL 解決後・
 * Drive直接取り込み後に呼び出す）。
 *
 * REFERENCES_HEADERS での列位置:
 *   fulltext_url             = 20列目 (T列, 0-indexed: 19)
 *   fulltext_status          = 21列目 (U列, 0-indexed: 20)
 *   fulltext_set             = 22列目 (V列, 0-indexed: 21) ※ここでは触れない
 *   fulltext_drive_source_id = 23列目 (W列, 0-indexed: 22)
 *   fulltext_drive_copy_id   = 24列目 (X列, 0-indexed: 23)
 *
 * driveSource は Driveへ直接置かれたPDFの取り込み（fulltext-drive-import.ts）でのみ値を持つ。
 * それ以外の経路は必ず null を渡し、W/X 列を空文字でクリアする（省略ではなくクリア。
 * 詳細は FulltextUrlUpdateEntry の JSDoc を参照）。
 */
export async function updateReferenceFulltextUrl(
    spreadsheetId: string,
    refId: string,
    fulltextUrl: string,
    status: FulltextStatus,
    driveSource: FulltextUrlUpdateEntry['driveSource']
): Promise<void> {
    await updateReferenceFulltextUrls(spreadsheetId, [{ refId, fulltextUrl, status, driveSource }]);
}

/**
 * 複数文献の fulltext_url / fulltext_status / fulltext_drive_source_id / fulltext_drive_copy_id を
 * まとめて更新する（一括OA検索・Drive直接取り込み等で使用）。
 * ref_id 列の読み取り1回 + values:batchUpdate 1回（T:U と、可能な場合は W:X の2つの非連続レンジ×件数）
 * で済ませ、APIクォータを節約する。V列（fulltext_set）は触れない。
 *
 * W/X 列が書き込み可能かどうかは ensureFulltextDriveColumnsOnce() で判定する
 * （fulltext ページは ensureHeaders() を経由しないため、ここが唯一の保証経路になる）。
 * ヘッダーがユーザー独自の別用途と衝突している場合（usable=false）の扱いは2通り:
 *   - 今回の updates に driveSource が非null のエントリ（Drive直接取り込み）が1件でもあれば、
 *     クレームを記録できず機能が成立しないため fail-fast でエラーを投げ、何も書き込まない
 *   - driveSource が全件 null（OA検索・手動アップロード等）なら、T:U だけを書き W:X はスキップする。
 *     ヘッダー不一致時の W/X は「我々のクレームが元から存在しない」状態なので、書かないことが
 *     安全側（クリアし忘れによる誤判定は起こり得ず、逆に空文字を書くとユーザーの独自データを破壊する）
 */
export async function updateReferenceFulltextUrls(
    spreadsheetId: string,
    updates: FulltextUrlUpdateEntry[]
): Promise<void> {
    if (updates.length === 0) return;

    const columnsStatus = await ensureFulltextDriveColumnsOnce(spreadsheetId);
    let includeDriveColumns = columnsStatus.usable;
    if (!columnsStatus.usable) {
        if (updates.some(u => u.driveSource !== null)) {
            throw new Error(t('fulltext_driveColumnsConflict', [columnsStatus.actualW, columnsStatus.actualX]));
        }
        console.warn(
            '[updateReferenceFulltextUrls] References の W/X 列がユーザー独自列と衝突しているため、' +
            'Drive取り込み列（fulltext_drive_source_id/fulltext_drive_copy_id）の更新をスキップしました:',
            { actualW: columnsStatus.actualW, actualX: columnsStatus.actualX }
        );
        includeDriveColumns = false;
    }

    // ref_id 列 (A列) で行番号を特定
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:A`);
    const rowByRefId = new Map<string, number>();
    values.forEach((row, i) => {
        if (i > 0 && row[0]) rowByRefId.set(row[0], i + 1); // 1-indexed (ヘッダー行=1)
    });

    const data = buildFulltextUrlUpdateData(updates, rowByRefId, REFERENCES_SHEET, includeDriveColumns);
    if (data.length === 0) return;

    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ valueInputOption: 'RAW', data }),
        }
    );
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(`Failed to update fulltext urls: ${error?.error?.message || response.statusText}`);
    }
}

/** 対象文献のフルテキスト状態（Drive直接取り込みの取り込み元/コピーIDを含む） */
export interface ReferenceFulltextRowState {
    status: FulltextStatus;
    url: string;
    sourceFileId: string;
    copyFileId: string;
}

/** ある source PDF（fulltext_drive_source_id）を取り込み元として持つ、1文献分のクレーム */
export interface FulltextSourceClaim {
    refId: string;
    copyId: string;
    status: FulltextStatus;
    url: string;
}

/**
 * source ID・ref_id の両方から引ける、全行分のフルテキスト取り込みスナップショット。
 * classifyDriveImportState（drive-import-classify.ts）の入力に使う。
 */
export interface FulltextClaimsSnapshot {
    /**
     * source ID（fulltext_drive_source_id）→ その source を取り込み元とする全文献のクレーム配列。
     * W列（fulltext_drive_source_id）が空の行は含まれない（クレームが無い行のため）。
     *
     * 1対1マップにせず配列で持つ理由は、**無効なクレームに紛れた有効なクレームを取りこぼさない
     * ため**である（同一sourceを指す行が複数あるとき、片方が旧版クライアントのT:U単独書き込みで
     * 失効していることがある。`isFulltextClaimValid` を通して有効な1件を選ぶ必要がある）。
     * 実行フェーズの `resolveImportAction` が別文献への `copy-and-update` を許容している以上、
     * 同一sourceの重複行はデータとして成立しうる。
     * ただし**表示フェーズは「有効なクレームが1件でもあれば取り込み済み」**として扱い、
     * 2件目の文献への対応付けは行わない（`drive-import-classify.ts` の冒頭コメント参照）。
     */
    bySourceId: Map<string, FulltextSourceClaim[]>;
    /**
     * ref_id → その行の現在のフルテキスト状態。W/X列の有無に関わらず**全行**を含む
     * （bySourceId と違い、W列が空の行も含む）。「Driveコピーは見えているがクレームが
     * 無い（＝本Issue修正前に取り込まれた既存ファイル）」行の現在URLを引くために必要。
     */
    byRefId: Map<string, ReferenceFulltextRowState>;
}

/**
 * getReferenceFulltextState / getFulltextClaimsSnapshot の共通実装。
 * References!A:A（ref_id列）と References!T:X（fulltext_url/status/set/source_id/copy_id）を
 * values:batchGet で1リクエストにまとめて読み、全行を横断した状態を組み立てる。
 * V列（fulltext_set）は読み込むが無視する（フルテキスト担当割り振りはここでは扱わない）。
 * 巨大な abstract 列等を含む References!A:X 全体を毎回読むより軽量。
 *
 * targetRefId を渡した場合のみ、その ref_id の行状態（target）もあわせて拾う
 * （target は byRefId.get(targetRefId) と同じ値になるが、既存の戻り値契約
 * （行が見つからなければ undefined）を壊さないための専用フィールドとして残す）。
 * byRefId は常に全行ぶん構築する（行スキャン自体は既に全行を回っているため、
 * マップを1つ増やすだけで追加のAPI呼び出しは発生しない。ロジックの二重実装を避けるため、
 * 行スキャンはこの1関数に集約する）。
 *
 * buildBySourceId=false（既定 true）を渡すと、「source ID → クレーム配列」の逆引きマップ
 * （bySourceId）を組み立てない。getReferenceFulltextState は target（対象1行の状態）しか
 * 使わないため、呼ばれるたびに全行分の bySourceId を組み立てては捨てていた無駄を避ける。
 */
async function scanFulltextRows(
    spreadsheetId: string,
    targetRefId?: string,
    buildBySourceId: boolean = true
): Promise<{
    target: ReferenceFulltextRowState | undefined;
    bySourceId: Map<string, FulltextSourceClaim[]>;
    byRefId: Map<string, ReferenceFulltextRowState>;
}> {
    const [idColumn, twxValues] = await getSheetValuesBatch(spreadsheetId, [
        `${REFERENCES_SHEET}!A:A`,
        `${REFERENCES_SHEET}!T:X`,
    ]);

    let target: ReferenceFulltextRowState | undefined;
    const bySourceId = new Map<string, FulltextSourceClaim[]>();
    const byRefId = new Map<string, ReferenceFulltextRowState>();

    for (let i = 1; i < idColumn.length; i++) {
        const rowRefId = idColumn[i][0];
        if (!rowRefId) continue;

        // Sheets は末尾の空セルを省いて返すため、A列より短い場合がある
        const row = twxValues[i] ?? [];
        const url = row[0] || '';
        const status = (row[1] || 'not_retrieved') as FulltextStatus;
        // row[2] = fulltext_set（V列）は無視する
        const sourceFileId = row[3] || '';
        const copyFileId = row[4] || '';
        const rowState: ReferenceFulltextRowState = { status, url, sourceFileId, copyFileId };

        byRefId.set(rowRefId, rowState);
        if (targetRefId !== undefined && rowRefId === targetRefId) {
            target = rowState;
        }
        if (buildBySourceId && sourceFileId) {
            const claims = bySourceId.get(sourceFileId) ?? [];
            claims.push({ refId: rowRefId, copyId: copyFileId, status, url });
            bySourceId.set(sourceFileId, claims);
        }
    }

    return { target, bySourceId, byRefId };
}

/**
 * 対象文献の fulltext_status / fulltext_url / Drive取り込み元・コピーIDを最新値で読み直す。
 * Driveへ直接置かれたPDFの取り込み実行時、files.copy 成功後・シート書き込み前に
 * 「他のユーザーが自分より先に同じ文献へ取り込み済みでないか」を確認するために使う
 * （楽観ロック相当。競合していれば呼び出し側は上書きせずコピーをゴミ箱へ戻す。
 * URLまで返すのは、cached済みのURLが自分がこれから書こうとしているコピーと同一かどうか
 * ＝「応答喪失後の再試行」かどうかを呼び出し側で判定するために必要なため）。
 *
 * 対象行が見つからない場合は undefined を返す（呼び出し側はエラー扱いにすること。従来の
 * 戻り値契約を維持）。全行を横断した逆引きマップ（bySourceId/byRefId）が必要な場合は
 * getFulltextClaimsSnapshot を使うこと（唯一の呼び出し側 fulltext-drive-import.ts は
 * 対象1行の状態しか使わないため、ここでは組み立てない）。
 */
export async function getReferenceFulltextState(
    spreadsheetId: string,
    refId: string
): Promise<ReferenceFulltextRowState | undefined> {
    const { target } = await scanFulltextRows(spreadsheetId, refId, false);
    return target;
}

/**
 * 「source ID → 取り込みクレーム配列」と「ref_id → 行状態」の両方の逆引きマップを取得する。
 * Driveへ直接置かれたPDFの取り込みで、Picker選択直後（実行前の表示フェーズ）に
 * クレームマップを鮮度よく取り直すために使う（fulltext-drive-import.ts）。
 * ファイルごとに取り直すとN+1になるため、選択確定後に1回だけ呼ぶこと。
 * getReferenceFulltextState と行スキャンのロジックは共通化しており（scanFulltextRows）、
 * 二重実装にはなっていない。
 *
 * byRefId は classifyDriveImportState の判定順2（Driveコピーのみ見えている場合の
 * フォールバック）で使う。bySourceId だけでは W/X が空の行（本Issue修正前に取り込まれた
 * 既存ファイル）の現在状態を引けず、「実は取り込み済みなのに未完了と誤表示される」退行に
 * なるため、byRefId（全行対象）を別途用意している。
 */
export async function getFulltextClaimsSnapshot(spreadsheetId: string): Promise<FulltextClaimsSnapshot> {
    const { bySourceId, byRefId } = await scanFulltextRows(spreadsheetId);
    return { bySourceId, byRefId };
}

/**
 * 特定のソースファイルの文献を削除
 */
export async function deleteReferencesBySourceFile(spreadsheetId: string, sourceFileName: string): Promise<number> {
    // 1. 全文献のソースファイル列（R列）を取得
    // source_fileはindex 17 (0-indexed) = R列
    // Referencesシートのデータは2行目から（1行目はヘッダー）

    // 効率のため、必要な列だけ取得したいが、行番号を知る必要があるため、A:Rを取得するか、
    // まるごと取得してJS側でフィルタする。
    // R列だけ取得して、インデックスをマッピングするのが効率的。
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!R:R`);

    if (values.length <= 1) return 0;

    const rangesToDelete: { startIndex: number; endIndex: number }[] = [];

    // ヘッダー(0)を除外してスキャン
    for (let i = 1; i < values.length; i++) {
        // R列の値が sourceFileName と一致するか
        if (values[i][0] === sourceFileName) {
            // iは配列のインデックス = シートの行番号 (0-indexed API用)
            // シートの行番号は i+1 だが、APIのstartIndexは0-indexedで行番号そのもの。
            // 例: 配列index 1 (2行目) -> startIndex 1

            // 連続する行をまとめる
            const lastRange = rangesToDelete[rangesToDelete.length - 1];
            if (lastRange && lastRange.endIndex === i) {
                lastRange.endIndex = i + 1;
            } else {
                rangesToDelete.push({ startIndex: i, endIndex: i + 1 });
            }
        }
    }

    if (rangesToDelete.length === 0) return 0;

    // 削除リクエストを作成（後ろから順に削除しないとインデックスがずれる可能性があるが、
    // batchUpdateのdeleteDimensionは "The requests are applied in the order they appear in the request."
    // とあるため、インデックスの大きい方（後ろ）から指定するのが定石）
    rangesToDelete.sort((a, b) => b.startIndex - a.startIndex);

    const requests = rangesToDelete.map(range => ({
        deleteDimension: {
            range: {
                sheetId: 0, // ReferencesシートのIDが必要。通常0だが、明示的に取得すべきか？
                // シートIDを取得する処理を入れると安全だが、オーバーヘッドになる。
                // 名前からIDを取得するヘルパーが必要。
                dimension: 'ROWS',
                startIndex: range.startIndex,
                endIndex: range.endIndex
            }
        }
    }));

    // シートIDを取得
    const sheetId = await getSheetIdByName(spreadsheetId, REFERENCES_SHEET);
    if (sheetId === null) throw new Error('References sheet not found');

    // sheetIdをセット
    requests.forEach(req => req.deleteDimension.range.sheetId = sheetId);

    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: requests
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to delete rows: ${error.error?.message || response.statusText}`);
    }

    return rangesToDelete.reduce((acc, range) => acc + (range.endIndex - range.startIndex), 0);
}

export async function updateReferenceScreeningSets(
    spreadsheetId: string,
    assignments: Array<{ refId: string; screeningSet: string }>
): Promise<void> {
    await updateReferenceColumnByRefId(
        spreadsheetId,
        'screening_set',
        assignments.map(({ refId, screeningSet }) => ({ refId, value: screeningSet }))
    );
}

/**
 * References タブの fulltext_set 列（フルテキスト担当セット）を一括更新する
 */
export async function updateReferenceFulltextSets(
    spreadsheetId: string,
    assignments: Array<{ refId: string; fulltextSet: string }>
): Promise<void> {
    await updateReferenceColumnByRefId(
        spreadsheetId,
        'fulltext_set',
        assignments.map(({ refId, fulltextSet }) => ({ refId, value: fulltextSet }))
    );
}

/**
 * References タブの duplicate_of 列（重複の論理削除フラグ）を一括更新する（Issue #145 チャンク2）。
 *
 * duplicateOf が文字列なら、その ref_id を書いて重複として除外する。null なら空文字を書いて
 * 除外を取り消す（「やっぱり戻す」）。列位置はヘッダー行から indexOf() で解決する
 * updateReferenceColumnByRefId() の既存の流儀をそのまま再利用する（列位置のハードコード禁止）。
 */
export async function setDuplicateOf(
    spreadsheetId: string,
    updates: { refId: string; duplicateOf: string | null }[]
): Promise<void> {
    await updateReferenceColumnByRefId(
        spreadsheetId,
        'duplicate_of',
        updates.map(({ refId, duplicateOf }) => ({ refId, value: duplicateOf ?? '' }))
    );
}

/**
 * References タブの任意の1列を ref_id をキーに一括更新する共通処理
 */
async function updateReferenceColumnByRefId(
    spreadsheetId: string,
    columnName: string,
    entries: Array<{ refId: string; value: string }>
): Promise<void> {
    if (entries.length === 0) return;

    await ensureHeaders(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:${REFERENCES_LAST_COLUMN}`);
    if (values.length <= 1) return;

    const headers = values[0];
    const refIdIndex = headers.indexOf('ref_id');
    const columnIndex = headers.indexOf(columnName);

    if (refIdIndex === -1 || columnIndex === -1) {
        throw new Error(`${columnName} column not found`);
    }

    const rowIndexByRefId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const refId = (row[refIdIndex] || '').trim();
        if (refId) {
            rowIndexByRefId.set(refId, index + 2);
        }
    });

    const column = columnNumberToLetter(columnIndex);
    const updates = entries
        .map(({ refId, value }) => {
            const rowIndex = rowIndexByRefId.get(refId);
            if (!rowIndex) return null;
            return {
                range: `${REFERENCES_SHEET}!${column}${rowIndex}`,
                values: [[value]],
            };
        })
        .filter((update): update is { range: string; values: string[][] } => update !== null);

    const batchSize = 500;
    for (let i = 0; i < updates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, updates.slice(i, i + batchSize));
    }
}
