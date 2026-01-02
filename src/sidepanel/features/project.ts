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
} from '../../lib/sheets-api';
import { getReviewerKey } from './screening/reviewer-utils';

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
    // スクリーニング画面を隠してプロジェクト選択画面を表示
    dom.screeningSection.classList.add('hidden');
    dom.llmSection.classList.add('hidden');
    dom.headerTabs?.classList.add('hidden');
    dom.configSection.classList.remove('hidden');

    // 状態をリセット
    state.resetForBack();
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

        state.setSpreadsheetId(selectedId);

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

        state.setSpreadsheetId(newId);

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

        state.setIsAdmin(adminStatus);
        state.setIsKeyOpened(keyOpenedStatus);
        state.setHighlightKeywords(keywords);

        // キーオープン状態に応じてデータを読み込み
        if (keyOpenedStatus) {
            state.setReferences(await getReferencesWithAllDecisions(spreadsheetId, userEmail));
        } else {
            state.setReferences(await getReferencesWithStatus(spreadsheetId, userEmail));
        }

        // ソースファイルを抽出
        state.clearSourceFiles();
        state.references.forEach(ref => {
            if (ref.source_file) state.addSourceFile(ref.source_file);
        });
        state.setSelectedSourceFiles(new Set(state.sourceFiles));

        // レビュアーを抽出（キーオープン時のみ）
        const reviewers = new Set<string>();
        if (keyOpenedStatus) {
            state.references.forEach(ref => {
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
        state.setAvailableReviewers(reviewers);
        state.setEnabledReviewers(new Set(reviewers)); // デフォルトは全員有効


        // 管理者の場合、キーオープンボタンを表示
        console.log('[loadDataAndShowScreening] isAdmin =', adminStatus);

        // ユーザー情報に権限を表示
        dom.userInfoDiv.textContent = `ログイン中: ${userEmail} (${adminStatus ? '管理者' : '一般'})`;

        if (adminStatus) {
            console.log('[loadDataAndShowScreening] Showing keySection');
            dom.keySection.classList.remove('hidden');
            if (_renderKeyStatus) _renderKeyStatus();
            if (_renderReviewerFilter) _renderReviewerFilter();
        } else {
            console.log('[loadDataAndShowScreening] Hiding keySection');
            dom.keySection.classList.add('hidden');
        }

        // 画面を切り替え
        dom.configSection.classList.add('hidden');
        dom.screeningSection.classList.remove('hidden');
        dom.headerTabs?.classList.remove('hidden');

        // 表示
        state.setCurrentIndex(0);
        if (_renderKeywords) _renderKeywords();
        if (_renderSourceFilters) _renderSourceFilters();
        if (_renderCurrentReference) _renderCurrentReference();
    } catch (error) {
        console.error('Load data error:', error);
        showStatus(`データ読み込みエラー: ${(error as Error).message}`, 'error');
        // 設定画面に戻す
        dom.configSection.classList.remove('hidden');
        dom.screeningSection.classList.add('hidden');
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
