// duplicate-candidates.ts - Duplicate_Candidates タブの読み書き（書誌重複候補の保存契約）
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema を参照。
// 候補ペアの重複除去（filterNewDuplicatePairs）は ../duplicate-detect を参照。

import type { DuplicateCandidate, DuplicateCandidateStatus, DuplicateCandidateDraft, DuplicateCandidateStatusUpdate } from '../types';
import { filterNewDuplicatePairs } from '../duplicate-detect';
import {
    getSheetValues,
    appendRows,
    updateRange,
    addSheet,
    batchUpdateRanges,
    isSheetMissingError,
} from './transport';
import {
    DUPLICATE_CANDIDATES_SHEET,
    DUPLICATE_CANDIDATES_HEADERS,
    columnNumberToLetter,
} from './schema';

/**
 * Duplicate_Candidates の既存ヘッダーに不足列があれば末尾へ追加する（書き込みのみ。GETは行わない）。
 * ensureDuplicateCandidatesSheet()（タブ欠落時のensure経路）と readDuplicateCandidatesRows()
 * （通常の読み取り経路。既に読んだヘッダー行をそのまま渡す）の両方から呼ぶ共有ロジックにして、
 * 列追加の判定・書き込みを二重実装しない（Issue #153 工程2 チャンク2 レビュー指摘対応）。
 *
 * existingHeaders が空（ヘッダー行そのものが無い）場合は何もしない。その状態は
 * ensureDuplicateCandidatesSheet() 側の「ヘッダーを丸ごと書く」分岐が別に持っている。
 */
async function migrateDuplicateCandidatesHeaderColumns(spreadsheetId: string, existingHeaders: string[]): Promise<void> {
    if (existingHeaders.length === 0) return;

    const missingHeaders = DUPLICATE_CANDIDATES_HEADERS.filter(h => !existingHeaders.includes(h));
    if (missingHeaders.length === 0) return;

    const newHeaders = [...existingHeaders, ...missingHeaders];
    const startCol = columnNumberToLetter(existingHeaders.length);
    const endCol = columnNumberToLetter(newHeaders.length - 1);
    await updateRange(
        spreadsheetId,
        `${DUPLICATE_CANDIDATES_SHEET}!${startCol}1:${endCol}1`,
        [missingHeaders]
    );
    console.log(`[migrateDuplicateCandidatesHeaderColumns] Added missing columns: ${missingHeaders.join(', ')}`);
}

/**
 * Duplicate_Candidates シートを初期化（存在しない場合）
 * ensurePublicationCandidatesSheet() と完全に同じ ensure パターン（ヘッダー欠落は末尾へ追記、
 * タブ欠落は addSheet → ヘッダー append、それ以外の例外は再送出）。Issue #145 チャンク2。
 */
export async function ensureDuplicateCandidatesSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${DUPLICATE_CANDIDATES_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, [DUPLICATE_CANDIDATES_HEADERS]);
            return;
        }

        await migrateDuplicateCandidatesHeaderColumns(spreadsheetId, existingHeaders);
    } catch (error) {
        if (isSheetMissingError(error)) {
            console.log('[ensureDuplicateCandidatesSheet] Creating Duplicate_Candidates sheet...');
            await addSheet(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);
            await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, [DUPLICATE_CANDIDATES_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * Duplicate_Candidates シートの全行を読む（ensure は呼ばない内部専用ヘルパー）。
 * readPublicationCandidatesRows() と同じ理由で分離している（保存のたびに ensure→全行読み取り→
 * ensure(二重)→appendRows という無駄なリクエストが積み重なるのを避けるため）。
 * 失敗時は例外をそのまま投げる（読み取り失敗を握りつぶすと、既存候補が読めないまま同じ組を
 * 二重に書きかねない。savePublicationCandidates() と同じ判断）。
 *
 * 【ヘッダー不足列の移行をここでも行う】（Issue #153 工程2 チャンク2 レビュー指摘対応）。
 * getDuplicateCandidates() を「まず読む→失敗時だけ ensure」に変えたことで、タブが既に存在する
 * 通常の読み取りでは ensureDuplicateCandidatesSheet() の「不足列を末尾へ追加する」分岐を
 * 経由しなくなった。ヘッダーが古い（新しい列が無い）タブは読み取り自体は成功してしまうため
 * catch にも入らず、移行が永久に走らなくなる（readDuplicateCandidatesRows() はヘッダー駆動の
 * ため、欠けた列は全行で undefined になり、特に status 列が欠けると
 * `(value || 'suggested')` で全件 suggested と誤認識される）。
 * この読み取りで既に得ているヘッダー行（values[0]）を migrateDuplicateCandidatesHeaderColumns()
 * にそのまま渡すことで、追加のGETなしで移行機構を維持する。ヘッダーが既に揃っている通常時は
 * missingHeaders が空になり、書き込みも発生しない。
 *
 * 【読み取り範囲はシート名のみ（全列）】（PR #161 レビュー指摘対応）。以前は
 * `A:${DUPLICATE_CANDIDATES_LAST_COLUMN}`（標準列数ぶんの終端列）で切り詰めて読んでいたが、
 * 「標準列が1本欠けている＋ユーザーが独自列を足している」シートではこの終端列がユーザー列の
 * 途中で切れてしまい、そのヘッダーを渡された migrateDuplicateCandidatesHeaderColumns() の
 * startCol がずれて、追加PUTがユーザー列のヘッダーを上書きしかねない。シート名のみの range は
 * 全列・全行を返すため、行のパースはヘッダー駆動のこのロジックを変更せずに済む。
 */
async function readDuplicateCandidatesRows(spreadsheetId: string): Promise<DuplicateCandidate[]> {
    const values = await getSheetValues(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);

    if (values.length === 0) return [];

    const headers = values[0];
    await migrateDuplicateCandidatesHeaderColumns(spreadsheetId, headers);

    if (values.length <= 1) return [];

    const rows = values.slice(1);

    return rows.map(row => {
        const candidate: Record<string, unknown> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            switch (header) {
                case 'decided_by':
                case 'decided_at':
                case 'kept_ref_id':
                    candidate[header] = value || undefined;
                    break;
                case 'status':
                    candidate[header] = (value || 'suggested') as DuplicateCandidateStatus;
                    break;
                default:
                    candidate[header] = value;
            }
        });
        return candidate as unknown as DuplicateCandidate;
    });
}

/**
 * 重複候補ペアを Duplicate_Candidates シートへ保存する。
 *
 * ensure → 既存行を読んで（readDuplicateCandidatesRows、ensureは呼ばない） filterNewDuplicatePairs()
 * で既出の組を除去 → 残りを appendRows。「取り込みを繰り返しても同じ組が再度積まれない」ことが
 * この重複除去の目的（既に決着済み・提示済みの組は再スキャンでも書き込まない）。
 *
 * 行の組み立ては savePublicationCandidates() と同じ位置ベース（ヘッダ名は見ない。
 * DUPLICATE_CANDIDATES_HEADERS の並びと1対1で対応させる）。candidate_id は crypto.randomUUID()、
 * status は常に 'suggested'、suggested_at は呼び出し時点の ISO 8601。decided_by/decided_at/
 * kept_ref_id はレビューUI（チャンク3）で使う列のため、このチャンクでは常に空文字で書く。
 */
export async function saveDuplicateCandidates(
    spreadsheetId: string,
    candidates: DuplicateCandidateDraft[]
): Promise<void> {
    if (candidates.length === 0) return;

    await ensureDuplicateCandidatesSheet(spreadsheetId);

    const existing = await readDuplicateCandidatesRows(spreadsheetId);
    const newCandidates = filterNewDuplicatePairs(existing, candidates);
    if (newCandidates.length === 0) return;

    const suggestedAt = new Date().toISOString();
    const rows = newCandidates.map(candidate => [
        crypto.randomUUID(),
        candidate.refIdA,
        candidate.refIdB,
        candidate.matchType,
        candidate.matchKey,
        'suggested',
        suggestedAt,
        '', // decided_by（チャンク3で使用）
        '', // decided_at（チャンク3で使用）
        '', // kept_ref_id（チャンク3で使用）
    ]);

    await appendRows(spreadsheetId, DUPLICATE_CANDIDATES_SHEET, rows);
}

/**
 * Duplicate_Candidates シートの全行を取得する（ヘッダ駆動。getPublicationCandidates() と同じ流儀）。
 * レビューUI（チャンク3）向けの公開API。
 *
 * 【まず読む→失敗した場合だけ ensure してから読み直す】（Issue #153 工程2 チャンク2）。
 * 以前は毎回 ensureDuplicateCandidatesSheet()（ヘッダー行のGET）→ 本体読み取り（GET）の
 * 2回GETを払っていたが、タブが既に存在し正しく移行済みという圧倒的多数のケースでも
 * 同じ2回を払い続けていた。シート・ヘッダーが既に存在する通常時は読み取り1回で成功するため、
 * その場合はensureを呼ばず1回のGETで済ませる。シート未作成（初回）の場合のみ
 * 「Unable to parse range」等で読み取りが失敗するので、その時だけ ensure → 再読み取りを行う
 * （ensureDuplicateCandidatesSheet() 自身のシート作成ロジックは変更していない）。
 *
 * 【ヘッダー不足列の移行は読み取り経路からも消していない】（レビュー指摘対応）。
 * タブは既に存在するがヘッダーに新しい列が無い（列追加前の旧シート）場合、読み取り自体は
 * 成功するため上の「まず読む」だけでは ensureDuplicateCandidatesSheet() の列追加分岐を
 * 永久に経由しなくなる。readDuplicateCandidatesRows() が自分の読み取りで得たヘッダー行を
 * migrateDuplicateCandidatesHeaderColumns() にそのまま渡して不足列を追加するため、
 * 追加のGETなしで移行機構を維持している。
 *
 * 【例外はそのまま呼び出し元へ投げる】（Issue #147。以前は
 * getPublicationCandidates() と同じ「読み取り単体は失敗を握りつぶす」流儀で失敗時に空配列を
 * 返していたが、それをやめた）。理由: この関数の失敗を候補0件に握りつぶすと、レビューUI
 * （src/sidepanel/features/duplicate-review.ts）が「未確認候補0件」「候補なし」という
 * 事実と異なる表示を出す。件数はキャッシュされるため、一時的な通信障害でも0件表示が
 * 固定化してしまう。さらに applyPairDecision() の適用直前の再読み込みも同じ関数を使っており、
 * 失敗して `[]` が返ると該当候補が見つからず「他のレビュアーが処理済み」という事実と異なる
 * 表示のまま書き込みを黙ってスキップしてしまう。0件と取得失敗を呼び出し元が区別できることが
 * 必須なため、この関数では例外を握りつぶさない（ensure後の再読み取りが失敗した場合も同様）。
 * 呼び出し元（duplicate-review.ts の全6箇所）はそれぞれ try/catch で取得失敗を検知し、
 * ユーザーへ明示的に伝える。7箇所目の呼び出し元 project.ts の loadDataAndShowScreening は
 * プロジェクト読み込み処理全体を止めないよう、失敗を console.warn で null 化して飲み込み、
 * 独立セクション（duplicate-review.ts）側の renderDuplicateReviewSection() による
 * 再取得・エラー表示に任せる（PR #161 レビュー指摘対応で追記）。
 * getPublicationCandidates() は別機能・別の呼び出し元セットのため、こちらに合わせて変更しない。
 */
export async function getDuplicateCandidates(spreadsheetId: string): Promise<DuplicateCandidate[]> {
    try {
        return await readDuplicateCandidatesRows(spreadsheetId);
    } catch (error) {
        if (isSheetMissingError(error)) {
            await ensureDuplicateCandidatesSheet(spreadsheetId);
            return await readDuplicateCandidatesRows(spreadsheetId);
        }
        throw error;
    }
}

/**
 * Duplicate_Candidates シートの候補ステータス（統合/別文献）を一括更新する（Issue #145 チャンク3向け）。
 *
 * candidate_id 列で行を特定し、status / decided_by / decided_at（この呼び出し時点の
 * ISO 8601、全件同一時刻） / kept_ref_id を更新する。列位置は updatePublicationCandidateStatus()
 * と同じ「ヘッダー行から都度引く」流儀（ハードコード禁止）。1件の候補につき4列を更新するため、
 * 全 update × 4列ぶんの range をまとめて1回の values:batchUpdate（batchUpdateRanges()）で送る。
 * ensureDuplicateCandidatesSheet() を先に呼ぶ。該当 candidate_id が見つからない更新は黙って
 * スキップする（updatePublicationCandidateStatus() と同じ振る舞い）。
 *
 * 読み取り範囲はシート名のみ（全列）。readDuplicateCandidatesRows() と同じ理由
 * （PR #161 レビュー指摘対応）で、終端列を標準列数に切り詰めるとユーザー独自列がある
 * シートで列インデックスがずれ、`Duplicate_Candidates column not found` になりうる。
 */
export async function updateDuplicateCandidateStatus(
    spreadsheetId: string,
    updates: DuplicateCandidateStatusUpdate[]
): Promise<void> {
    if (updates.length === 0) return;

    await ensureDuplicateCandidatesSheet(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, DUPLICATE_CANDIDATES_SHEET);
    if (values.length <= 1) return;

    const headers = values[0];
    const candidateIdIndex = headers.indexOf('candidate_id');
    const statusIndex = headers.indexOf('status');
    const decidedByIndex = headers.indexOf('decided_by');
    const decidedAtIndex = headers.indexOf('decided_at');
    const keptRefIdIndex = headers.indexOf('kept_ref_id');

    if (candidateIdIndex === -1 || statusIndex === -1 || decidedByIndex === -1 ||
        decidedAtIndex === -1 || keptRefIdIndex === -1) {
        throw new Error('Duplicate_Candidates column not found');
    }

    const rowIndexByCandidateId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const candidateId = (row[candidateIdIndex] || '').trim();
        if (candidateId) {
            rowIndexByCandidateId.set(candidateId, index + 2);
        }
    });

    const decidedAt = new Date().toISOString();
    const columnUpdaters: Array<{ index: number; value: (u: DuplicateCandidateStatusUpdate) => string }> = [
        { index: statusIndex, value: (u) => u.status },
        { index: decidedByIndex, value: (u) => u.decidedBy },
        { index: decidedAtIndex, value: () => decidedAt },
        { index: keptRefIdIndex, value: (u) => u.keptRefId || '' },
    ];

    const batchUpdates: Array<{ range: string; values: string[][] }> = [];
    for (const update of updates) {
        const rowIndex = rowIndexByCandidateId.get(update.candidateId);
        if (!rowIndex) continue;
        for (const col of columnUpdaters) {
            batchUpdates.push({
                range: `${DUPLICATE_CANDIDATES_SHEET}!${columnNumberToLetter(col.index)}${rowIndex}`,
                values: [[col.value(update)]],
            });
        }
    }

    if (batchUpdates.length === 0) return;

    const batchSize = 500;
    for (let i = 0; i < batchUpdates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, batchUpdates.slice(i, i + batchSize));
    }
}
