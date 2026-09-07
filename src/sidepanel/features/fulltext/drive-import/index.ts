/**
 * Driveへ直接置かれたPDFの取り込み（V1）
 *
 * アプリを経由せずDriveフォルダへ直接保存されたPDFは drive.file スコープでは見えず、
 * Referencesシートにも登録されない。本モジュールは、Picker（mode=pdf）で対象PDFを
 * ユーザーに明示選択させ、選択ファイルIDを launchWebAuthFlow のリダイレクト捕捉で
 * 拡張機能へ直接受け取り、files.copy でfulltextフォルダへ「アプリ作成ファイル」として
 * 取り込む一連のフローを提供する（対応付けUI・冪等性チェック・クリーンアップを含む）。
 *
 * 設計の要点（詳細は pdf-import-plan.md の「V1フロー」と、それに対する
 * コーディネーターレビュー（部分失敗・競合まわりの修正）を参照）:
 *  - 選択ID受け渡しは launchWebAuthFlow のリダイレクトURLフラグメント経由（ポーリングなし）
 *  - 受信JSON・各ファイルのmetadataは信用せず、コピー前に必ず再検証する
 *  - 取り込み状態は3値（未取り込み/未完了/取り込み済み）で扱う。「Driveにコピーはあるが
 *    シート未反映」は取り込み済みと誤表示せず、対応付け可能な「未完了」として扱い、
 *    実行時は既存コピーを再利用してシート更新のみ行う（詳細は drive-import-action.ts）
 *  - 既存コピーの再利用は appProperties.refId が対象文献と一致する場合のみ。
 *    別文献へ対応付けられた既存コピーは流用しない（sourceFileIdの重複は許容）
 *  - 削除してよいのは「今回このattemptで新規作成したコピー」だけ。再利用した既存コピーは
 *    競合が判明しても絶対に削除しない
 *  - 実行直前の冪等性チェック（findImportedCopy）は fail-closed。失敗したらコピーへ進まず
 *    エラーにする（検証フェーズの表示用チェックは fail-open のままでよい）
 *  - 元ファイルの削除は自動で行わない。シート反映まで確認できたファイルのみ
 *    完了画面で明示チェックさせ、ゴミ箱送り（30日間復元可）にする
 *
 * ---
 * ディレクトリ構成（Issue #191 で drive-import.ts から分割。800行超のファイルを避けるため
 * 機能単位に分けたもので、上記フロー自体・中断復帰の契約に変更は無い）:
 *  - validate.ts      : ①Pickerフローと②受信ファイルの検証（3値判定: none/incomplete/done）
 *  - mapping-modal.ts : ③ファイル⇔文献の対応付けモーダルUI
 *  - exec.ts          : ④実行（files.copy・シート更新）。中断・再開の契約はここに集約
 *  - result-view.ts   : ⑤結果表示・クリーンアップ（元ファイルのゴミ箱移動）
 *  - types.ts         : mapping-modal.ts と exec.ts が互いに必要とする型（循環import回避のため
 *                        独立ファイルへ切り出し。詳細は同ファイル冒頭コメント参照）
 * 本ファイル（index.ts）はこれらを束ねる入口で、多重実行ガードとエントリーポイント
 * （handleImportFromDriveClick）を持ち、公開API（setFulltextDriveImportDeps は
 * result-view.ts からの再export、setupFulltextDriveImportListeners は本ファイルで定義）を
 * fulltext/tab.ts へ提供する。
 */

import { dom } from '../dom';
import { state } from '../../../state';
import { t } from '../../../../lib/i18n';
import { showToast } from '../../../ui/feedback';
import { getFulltextClaimsSnapshot } from '../../../../lib/sheets-api';
import type { FulltextClaimsSnapshot } from '../../../../lib/sheets-api';
import { runPickerFlow, validateAndCheckFiles } from './validate';
import { openMappingModal } from './mapping-modal';

export { setFulltextDriveImportDeps } from './result-view';

// モーダルが開いている間（対応付け〜結果表示が終わるまで）は解除しない多重実行ガード。
// Pickerが完了して対応付けモーダルを開いた後は、モーダルのonClose（Cancel/X/結果画面のClose、
// どの経路でも hideModal() 経由で発火する）に解除を委ねる。
let importInProgress = false;

function releaseImportGuard(): void {
    importInProgress = false;
    dom.fulltextImportDriveBtn.disabled = false;
}

function setDriveImportStatus(msg: string | null): void {
    dom.fulltextImportDriveStatus.classList.toggle('hidden', !msg);
    dom.fulltextImportDriveStatus.textContent = msg ?? '';
}

// ---------------------------------------------------------------------------
// エントリーポイント + イベントリスナー
// ---------------------------------------------------------------------------

async function handleImportFromDriveClick(): Promise<void> {
    if (importInProgress) return;
    importInProgress = true;
    dom.fulltextImportDriveBtn.disabled = true;
    setDriveImportStatus(t('fulltext_driveImportRunning'));

    // 対応付けモーダルを開けたら、以降のガード解除はモーダルの onClose に委ねる
    // （Cancel/X/結果画面のCloseのいずれも hideModal() 経由で onClose が発火する）。
    let modalOpened = false;
    try {
        const picked = await runPickerFlow();
        if (picked === null) return; // キャンセル・解析不能（解析不能時は既にtoast済み）
        if (picked.length === 0) {
            showToast(t('fulltext_driveImportNoFiles'), 4000);
            return;
        }

        setDriveImportStatus(t('fulltext_driveImportValidating'));
        // state.allReferences は画面ロード時のスナップショットなので、選択確定直後に
        // クレームスナップショット（source ID→クレーム配列 と ref_id→行状態の両方）だけ
        // Sheetsから1回だけ取り直す（ファイルごとに取り直すとN+1になるため、ここでまとめて取得する）。
        // 失敗しても表示フェーズをブロックしない: fail-open で両マップとも空にし、
        // 従来のDrive検索ベースの判定（classifyDriveImportStateの2.以降）へフォールバックする。
        let claimsSnapshot: FulltextClaimsSnapshot;
        try {
            claimsSnapshot = await getFulltextClaimsSnapshot(state.spreadsheetId);
        } catch (err) {
            console.warn('[fulltext-drive-import] クレームスナップショットの再取得に失敗（fail-open: Drive検索ベースの判定へ続行）:', err);
            claimsSnapshot = { bySourceId: new Map(), byRefId: new Map() };
        }
        const validated = await validateAndCheckFiles(picked, claimsSnapshot);
        setDriveImportStatus(null);
        openMappingModal(validated, releaseImportGuard);
        modalOpened = true;
    } catch (err) {
        console.warn('[fulltext-drive-import] エラー', err);
        showToast(t('fulltext_driveImportError', (err as Error).message), 6000);
    } finally {
        setDriveImportStatus(null);
        if (!modalOpened) releaseImportGuard();
    }
}

export function setupFulltextDriveImportListeners(): void {
    dom.fulltextImportDriveBtn?.addEventListener('click', () => { void handleImportFromDriveClick(); });
}
