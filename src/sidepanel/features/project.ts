/**
 * プロジェクト管理モジュール
 * handleConnect, handleCreateNew, loadRecentSheets, loadConfig, loadDataAndShowScreening, handleBack
 */

import { dom } from '../dom';
import { state } from '../state';
import { showLoading, showStatus, hideStatus, showToast } from '../ui/feedback';
import {
    getSpreadsheetInfo,
    validateSpreadsheetFormat,
    createSpreadsheet,
    getRecentSpreadsheets,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    getHighlightKeywords,
    getKeyOpenedStatus,
    isUserAdmin,
    forceReauth,
    ensureHeaders,
    saveDecision as apiSaveDecision,
} from '../../lib/sheets-api';
import { getReviewerKey } from './screening/reviewer-utils';
import { flushDecisionQueue } from '../utils/offline-queue';

// Store互換レイヤー（Phase 3）
import {
    showProjectView,
    showScreeningView,
    resetForBack as syncResetForBack,
    setSpreadsheetId as syncSetSpreadsheetId,
    setReferences as syncSetReferences,
    setKeywords as syncSetKeywords,
    setIsKeyOpened as syncSetIsKeyOpened,
    setIsAdmin as syncSetIsAdmin,
    setSourceFiles as syncSetSourceFiles,
    setSelectedSourceFiles as syncSetSelectedSourceFiles,
    setAvailableReviewers as syncSetAvailableReviewers,
    setEnabledReviewers as syncSetEnabledReviewers,
    setCurrentIndex as syncSetCurrentIndex,
} from '../store/compat';

// 外部関数への参照（循環依存回避）
let _renderKeywords: (() => void) | null = null;
let _renderSourceFilters: (() => void) | null = null;
let _renderCurrentReference: (() => void) | null = null;
let _renderKeyStatus: (() => void) | null = null;
let _renderReviewerFilter: (() => void) | null = null;

export function setProjectDependencies(deps: {
    renderKeywords: () => void;
    renderSourceFilters: () => void;
    renderCurrentReference: () => void;
    renderKeyStatus: () => void;
    renderReviewerFilter: () => void;
}) {
    _renderKeywords = deps.renderKeywords;
    _renderSourceFilters = deps.renderSourceFilters;
    _renderCurrentReference = deps.renderCurrentReference;
    _renderKeyStatus = deps.renderKeyStatus;
    _renderReviewerFilter = deps.renderReviewerFilter;
}

/**
 * 戻るボタン処理
 */
export function handleBack() {
    // 状態をリセット（Store経由で両方に同期）
    syncResetForBack();

    // プロジェクト選択画面を表示（Store経由でrenderLayoutが自動更新）
    showProjectView();
}

/**
 * スプレッドシート接続処理
 */
export async function handleConnect() {
    const selectedId = dom.recentSheetsSelect.value;
    if (!selectedId) {
        showStatus('スプレッドシートを選択してください', 'error');
        return;
    }

    try {
        showLoading(true);
        hideStatus();

        // スプレッドシートの存在確認
        const info = await getSpreadsheetInfo(selectedId);

        // スプレッドシート形式の検証
        const validation = await validateSpreadsheetFormat(selectedId);
        if (!validation.valid) {
            showStatus(validation.error || '対応していない形式です', 'error');
            return;
        }

        // ヘッダーの整合性を確認（不足があれば追加）
        await ensureHeaders(selectedId);

        showStatus(`接続成功: ${info.title}`, 'success');

        // Store経由で両方に同期
        syncSetSpreadsheetId(selectedId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId: selectedId });

        // データを読み込んで画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Connection error:', error);
        showStatus(`接続エラー: ${(error as Error).message}`, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * 最近使用したスプレッドシートをドロップダウンに読み込み
 */
export async function loadRecentSheets() {
    try {
        dom.recentSheetsSelect.innerHTML = '<option value="">読み込み中...</option>';

        const sheets = await getRecentSpreadsheets(15);

        dom.recentSheetsSelect.innerHTML = '';

        if (sheets.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'スプレッドシートが見つかりません';
            dom.recentSheetsSelect.appendChild(opt);
            return;
        }

        // 空の選択肢
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '— スプレッドシートを選択 —';
        dom.recentSheetsSelect.appendChild(emptyOpt);

        for (const sheet of sheets) {
            const opt = document.createElement('option');
            opt.value = sheet.id;
            opt.textContent = sheet.name;
            dom.recentSheetsSelect.appendChild(opt);
        }
    } catch (error) {
        console.error('Failed to load recent sheets:', error);

        dom.recentSheetsSelect.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '読み込み失敗';
        dom.recentSheetsSelect.appendChild(opt);

        // 再認証ボタンを表示
        showStatus(`シート一覧取得失敗 - 権限を再設定してください`, 'error');

        // 再認証リンクを追加
        const reauthBtn = document.createElement('button');
        reauthBtn.textContent = '🔄 権限を再設定';
        reauthBtn.className = 'btn btn-primary';
        reauthBtn.style.marginTop = '12px';
        reauthBtn.style.width = '100%';
        reauthBtn.onclick = async () => {
            try {
                showLoading(true);
                await forceReauth();
                await loadRecentSheets();
                hideStatus();
            } catch (e) {
                showStatus('再認証に失敗しました', 'error');
            } finally {
                showLoading(false);
            }
        };
        dom.statusMessage.appendChild(reauthBtn);
    }
}

/**
 * 新規プロジェクト作成
 */
export async function handleCreateNew() {
    const title = prompt('新しいレビュープロジェクトの名前を入力してください:', 'TiAb Review Project');
    if (!title) return;

    try {
        showLoading(true);
        hideStatus();

        const newId = await createSpreadsheet(title);
        showStatus(`作成成功: ${title}`, 'success');

        // Store経由で両方に同期
        syncSetSpreadsheetId(newId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId: newId });

        // 画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Create error:', error);
        showStatus(`作成エラー: ${(error as Error).message}`, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * データを読み込んでスクリーニング画面を表示
 */
export async function loadDataAndShowScreening() {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;

    try {
        showLoading(true);

        // 管理者権限とキーオープン状態を確認
        const [adminStatus, keyOpenedStatus, keywords] = await Promise.all([
            isUserAdmin(spreadsheetId, userEmail),
            getKeyOpenedStatus(spreadsheetId),
            getHighlightKeywords(spreadsheetId),
        ]);

        // Store経由で両方に同期
        syncSetIsAdmin(adminStatus);
        syncSetIsKeyOpened(keyOpenedStatus);
        syncSetKeywords(keywords);

        // キーオープン状態に応じてデータを読み込み
        const refs = keyOpenedStatus
            ? await getReferencesWithAllDecisions(spreadsheetId, userEmail)
            : await getReferencesWithStatus(spreadsheetId, userEmail);
        syncSetReferences(refs);

        // ソースファイルを抽出
        const sourceFiles = new Set<string>();
        refs.forEach(ref => {
            if (ref.source_file) sourceFiles.add(ref.source_file);
        });
        syncSetSourceFiles(sourceFiles);
        syncSetSelectedSourceFiles(new Set(sourceFiles));

        // レビュアーを抽出（キーオープン時のみ）
        const reviewers = new Set<string>();
        if (keyOpenedStatus) {
            refs.forEach(ref => {
                if (ref.allDecisions) {
                    ref.allDecisions.forEach(d => {
                        const reviewerKey = getReviewerKey(d);
                        if (reviewerKey) reviewers.add(reviewerKey);
                    });
                }
            });
            if (userEmail) {
                reviewers.add(userEmail);
            }
        } else {
            reviewers.add(userEmail);
        }
        syncSetAvailableReviewers(reviewers);
        syncSetEnabledReviewers(new Set(reviewers)); // デフォルトは全員有効


        // 管理者の場合、キーオープンボタンを表示
        console.log('[loadDataAndShowScreening] isAdmin =', adminStatus);

        // ユーザー情報に権限を表示
        dom.userInfoDiv.textContent = `ログイン中: ${userEmail} (${adminStatus ? '管理者' : '一般'})`;

        // 注意: キーセクションの表示はrenderLayoutで管理されるようになった
        // ただし、レガシーなrenderKeyStatusとrenderReviewerFilterは既存コードを維持
        if (adminStatus) {
            console.log('[loadDataAndShowScreening] Admin mode');
            if (_renderKeyStatus) _renderKeyStatus();
            if (_renderReviewerFilter) _renderReviewerFilter();
        }

        // スクリーニング画面を表示（Store経由でrenderLayoutが自動更新）
        // ログイン成功時のステータスメッセージを非表示にする
        hideStatus();
        showScreeningView();

        // 表示（Store経由で同期）
        syncSetCurrentIndex(0);
        if (_renderKeywords) _renderKeywords();
        if (_renderSourceFilters) _renderSourceFilters();
        if (_renderCurrentReference) _renderCurrentReference();

        try {
            await flushDecisionQueue(spreadsheetId, userEmail, (queued) =>
                apiSaveDecision(spreadsheetId, queued)
            );
        } catch (error) {
            console.error('Queue flush error:', error);
        }
    } catch (error) {
        console.error('Load data error:', error);
        showStatus(`データ読み込みエラー: ${(error as Error).message}`, 'error');
        // 設定画面に戻す（Store経由）
        showProjectView();
    } finally {
        showLoading(false);
    }
}

/**
 * 保存済み設定を読み込み
 */
export async function loadConfig() {
    const result = await chrome.storage.local.get(['spreadsheetId']);
    if (result.spreadsheetId) {
        // ドロップダウンで選択
        dom.recentSheetsSelect.value = result.spreadsheetId;
    }
}
