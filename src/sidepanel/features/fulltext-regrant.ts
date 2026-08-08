/**
 * fulltext-regrant.ts - 他のメンバーがアップロードしたPDFの読み取り権限を復旧する
 *
 * 背景（Issue #60 / 実測で確定済み。詳細は AGENTS.md 参照）: drive.file は
 * 「アプリ×ユーザー×ファイル」単位でしか付与されないため、共同研究者がアップロードした
 * PDFは他のメンバーから読めない（オーナーでも同じ）。Drive の共有では付与されず、
 * 付与経路は (1) アプリが作成 (2) ユーザーがPickerで選択 (3) Driveの「アプリで開く」の3つだけ。
 *
 * 本モジュールは fulltext-drive-import.ts と同じ骨格（多重実行ガード・モーダル・
 * releaseGuard を onClose に一本化する形）を踏襲するが、コピー・シート書き込み・
 * 対応付けUIが無いぶん大幅に単純である:
 *  ① 検知: listAccessibleFileIdsInFolder（files.list の真値）と cached 文献を突き合わせ、
 *     現在のユーザーが読めない文献を特定する
 *  ② 再付与: fulltextフォルダを初期表示にしたPickerを複数選択で開く。選択した瞬間に
 *     サーバー側で付与が確定するため、拡張機能側は何もコピーしない
 *  ③ 再確認: Pickerを閉じた後にもう一度①を実行し、解消件数・残り件数をモーダルで表示する
 *
 * フォルダIDの取得に ensureFulltextFolder() を使わない理由: ensureFulltextFolder() は
 * 「無ければ作る」副作用を持つ（trashed の場合に作り直す経路がある）。この機能は
 * 読み取り権限を調べるだけの確認操作なので、確認しただけで Drive にフォルダができるのは
 * 筋が悪い。また「Config にIDが無い＝まだPDFが1件も無い」を null で区別したい。
 * よって Config の生読みである getFulltextDriveFolderId() を使う。
 *
 * 注: 以前は「ensureFulltextFolder() が inaccessible で throw するから使えない」ことも
 * 理由だったが、共同研究者のアップロードを通すため inaccessible では throw しない挙動へ
 * 変更した（2026-08-08）。上記2点の理由は変わらないため、ここは引き続き生読みを使う。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/feedback';
import { showModal, hideModal } from '../ui/modal';
import { buildRegrantPickerUrl } from '../../lib/picker-url';
import { parseRegrantPickerRedirect } from '../../lib/drive-picker-result';
import {
    listAccessibleFileIdsInFolder,
    describeDriveAccessError,
} from '../../lib/drive-api';
import { getFulltextDriveFolderId } from '../../lib/sheets-api';
import { collectCachedFulltextRefs, selectUnreadableRefs } from '../../lib/fulltext-access';
import type { CachedFulltextRef } from '../../lib/fulltext-access';

// モーダルが開いている間（結果表示が終わるまで）は解除しない多重実行ガード。
// モーダルを開けた後は onClose（Close/X いずれも hideModal() 経由で発火する）に解除を委ねる。
let regrantInProgress = false;

function releaseRegrantGuard(): void {
    regrantInProgress = false;
    dom.fulltextRegrantBtn.disabled = false;
}

function setRegrantStatus(msg: string | null): void {
    dom.fulltextRegrantStatus.classList.toggle('hidden', !msg);
    dom.fulltextRegrantStatus.textContent = msg ?? '';
}

/**
 * chrome.identity.launchWebAuthFlow の失敗が「ユーザーがウィンドウを閉じた/キャンセルした」
 * ものかを、例外メッセージ（chrome.runtime.lastError由来）から best-effort で判定する。
 * fulltext-drive-import.ts の isUserCancelledAuthError と同じ判定（export されていないため
 * ここで小さく複製する）。
 */
function isUserCancelledAuthError(message: string): boolean {
    return /did not approve|cancel|closed the window|dismissed/i.test(message || '');
}

/**
 * 現在のユーザーが読めない cached 文献を検知する（副作用: files.list を1回〜複数回呼ぶ）。
 * 「folderId 直下に無い cached ファイル = 読めない」という前提と、それが崩れた場合の
 * 既知の限界（fulltextフォルダの作り直し後は偽陽性になりうる）は
 * selectUnreadableRefs（fulltext-access.ts）のdocコメントを参照。
 */
async function detectUnreadable(folderId: string): Promise<CachedFulltextRef[]> {
    const accessibleIds = await listAccessibleFileIdsInFolder(folderId);
    return selectUnreadableRefs(collectCachedFulltextRefs(state.references), accessibleIds);
}

/**
 * Pickerを開き、選択された（＝再付与された）件数を返す。
 * キャンセル・パース失敗は null を返すのみで例外は投げない（呼び出し側は再検知へ進む）。
 * launchWebAuthFlow 自体の失敗（キャンセル以外。ネットワークエラー等）は投げる。
 */
async function runRegrantPickerFlow(folderId: string): Promise<number | null> {
    const redirectUri = chrome.identity.getRedirectURL('picker');
    const url = buildRegrantPickerUrl({ email: state.userEmail, redirectUri, folderId });

    let redirectUrl: string | undefined;
    try {
        redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (err) {
        if (isUserCancelledAuthError((err as Error).message)) return null;
        throw err;
    }
    if (!redirectUrl) return null;

    // Pickerページの実装不備・想定外の遷移を疑い、拡張機能自身が発行したリダイレクトURIで
    // 始まっていることを確認してから解析する。
    if (!redirectUrl.startsWith(redirectUri)) {
        console.warn('[fulltext-regrant] 想定外のリダイレクトURLを受信しました:', redirectUrl);
        showToast(t('fulltext_regrantParseError'), 5000);
        return null;
    }

    const parsed = parseRegrantPickerRedirect(redirectUrl);
    if (parsed === null) {
        showToast(t('fulltext_regrantParseError'), 5000);
        return null;
    }
    if (parsed === 'cancelled') return null;
    return parsed.granted;
}

// ---------------------------------------------------------------------------
// 結果モーダル
// ---------------------------------------------------------------------------

/**
 * before（Picker起動前に「読めない」と判定した集合）と after（再確認後に「読めない」と
 * 判定した集合）を比較し、解消件数・残り件数のサマリと、残った文献の一覧を表示する。
 */
function showResultModal(before: CachedFulltextRef[], after: CachedFulltextRef[]): void {
    const remainingIds = new Set(after.map(r => r.refId));
    const resolvedCount = before.filter(r => !remainingIds.has(r.refId)).length;

    const body = document.createElement('div');
    body.className = 'ft-regrant-modal';

    const summary = document.createElement('p');
    summary.className = 'ft-regrant-summary';
    summary.textContent = t('fulltext_regrantResultSummary', [String(resolvedCount), String(after.length)]);
    body.appendChild(summary);

    if (after.length === 0) {
        const success = document.createElement('p');
        success.className = 'ft-regrant-success';
        success.textContent = t('fulltext_regrantAllResolved');
        body.appendChild(success);
    } else {
        const intro = document.createElement('p');
        intro.className = 'ft-regrant-remaining-intro';
        intro.textContent = t('fulltext_regrantRemainingIntro');
        body.appendChild(intro);

        const list = document.createElement('ul');
        list.className = 'ft-regrant-remaining-list';
        for (const ref of after) {
            const li = document.createElement('li');
            li.textContent = ref.title || ref.refId;
            list.appendChild(li);
        }
        body.appendChild(list);
    }

    const footer = document.createElement('div');
    footer.className = 'assignment-modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary btn-small';
    closeBtn.textContent = t('fulltext_regrantCloseBtn');
    closeBtn.addEventListener('click', () => hideModal());
    footer.appendChild(closeBtn);

    showModal({
        title: t('fulltext_regrantModalTitle'),
        body,
        footer,
        // Close/X のいずれも hideModal() を呼ぶため、ここに解除ロジックを一本化できる
        onClose: () => releaseRegrantGuard(),
    });
}

// ---------------------------------------------------------------------------
// エントリーポイント + イベントリスナー
// ---------------------------------------------------------------------------

async function handleRegrantClick(): Promise<void> {
    if (regrantInProgress) return;
    regrantInProgress = true;
    dom.fulltextRegrantBtn.disabled = true;
    setRegrantStatus(t('fulltext_regrantChecking'));

    let modalOpened = false;
    try {
        const folderId = await getFulltextDriveFolderId(state.spreadsheetId);
        if (!folderId) {
            // まだPDFが1件も無いプロジェクト。復旧する対象が無いので何もしない。
            showToast(t('fulltext_regrantNoFolder'), 4000);
            return;
        }

        const unreadable = await detectUnreadable(folderId);
        if (unreadable.length === 0) {
            showToast(t('fulltext_regrantAllReadable'), 4000);
            return;
        }

        setRegrantStatus(t('fulltext_regrantOpeningPicker'));
        // 戻り値（選択件数）は表示に使わない。真値は再検知（下のdetectUnreadable）で取り直す
        // （runRegrantPickerFlow / picker.ts のコメント参照）。
        // キャンセル・パース失敗でもここで打ち切らず再検知へ進む（付与は既に起きている可能性があるため）。
        // launchWebAuthFlow自体が失敗した場合（キャンセル以外）はここで例外が飛び、catchへ抜ける。
        await runRegrantPickerFlow(folderId);

        setRegrantStatus(t('fulltext_regrantRechecking'));
        const afterUnreadable = await detectUnreadable(folderId);

        showResultModal(unreadable, afterUnreadable);
        modalOpened = true;
    } catch (err) {
        console.warn('[fulltext-regrant] エラー', err);
        const knownMessage = describeDriveAccessError(err);
        showToast(knownMessage ?? t('fulltext_regrantError', (err as Error).message), 6000);
    } finally {
        setRegrantStatus(null);
        if (!modalOpened) releaseRegrantGuard();
    }
}

export function setupFulltextRegrantListeners(): void {
    dom.fulltextRegrantBtn?.addEventListener('click', () => { void handleRegrantClick(); });
}
