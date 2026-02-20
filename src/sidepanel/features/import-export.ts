/**
 * インポート/エクスポート機能モジュール
 */
import { dom } from '../dom';
import { state } from '../state';
import { showToast, showLoading } from '../ui/feedback';
import { escapeCSVField } from '../utils/csv';
import { getFilteredReferences, renderSourceFilters } from './screening/filters';
import { getSpreadsheetInfo, addReferences, getReferencesWithStatus } from '../../lib/sheets-api';
import { t } from '../../lib/i18n';

// Store互換レイヤー（Phase 5）
import { setReferences as syncSetReferences } from '../store/compat';
import { parseRISFile } from '../../lib/ris-parser';

// 外部レンダリング関数への参照
let _renderCurrentReference: (() => void) | null = null;

export function setImportExportDependencies(deps: {
    renderCurrentReference: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
}

/**
 * RIS/nbibファイルをインポート
 */
export async function handleRISImport(e: Event) {
    const fileInput = e.target as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
        // 同じ名前のファイルが既に存在するかチェック
        if (state.sourceFiles.has(file.name)) {
            const msg = t('import_duplicate', file.name);
            showToast(msg);
            dom.importStatus.textContent = t('import_duplicateStatus');
            fileInput.value = ''; // リセット

            setTimeout(() => {
                if (dom.importStatus.textContent === t('import_duplicateStatus')) {
                    dom.importStatus.textContent = '';
                }
            }, 3000);
            return;
        }

        showLoading(true);
        dom.importStatus.textContent = t('import_parsing');
        // const text = await file.text(); // parseRISFile reads it
        const newReferences = await parseRISFile(file);

        if (newReferences.length === 0) {
            showToast(t('import_noValid'));
            dom.importStatus.textContent = t('import_noValid');
            return;
        }

        // ソースファイル名を付与
        newReferences.forEach(ref => {
            ref.source_file = file.name;
        });

        // 重複チェック
        const existingKeys = new Set(state.references.map(r => r.dedupe_key).filter(k => !!k));
        const uniqueReferences = newReferences.filter(ref => !existingKeys.has(ref.dedupe_key));
        const duplicateCount = newReferences.length - uniqueReferences.length;

        if (duplicateCount > 0) {
            console.log(`Skipped ${duplicateCount} duplicates.`);
            showToast(t('import_skippedDuplicates', String(duplicateCount)));
        }

        if (uniqueReferences.length === 0) {
            dom.importStatus.textContent = t('import_allDuplicate');
            showToast(t('import_noNew'));
            return;
        }

        // スプレッドシートに追加 (分割処理)
        const BATCH_SIZE = 500;
        const total = uniqueReferences.length;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const chunk = uniqueReferences.slice(i, i + BATCH_SIZE);
            const current = Math.min(i + chunk.length, total);

            dom.importStatus.textContent = t('import_uploading', [String(current), String(total)]);
            await addReferences(state.spreadsheetId, chunk);
        }

        // 状態を更新
        dom.importStatus.textContent = t('import_updating');
        state.addSourceFile(file.name);
        state.addSelectedSourceFile(file.name); // 新規ファイルを選択状態にする

        // データを再読み込み（現在のモードに合わせて）
        const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);
        // Store経由で両方に同期
        syncSetReferences(refs);

        // UI更新
        renderSourceFilters();
        if (_renderCurrentReference) _renderCurrentReference();

        const completionMsg = t('import_complete', [String(uniqueReferences.length), String(duplicateCount)]);
        dom.importStatus.textContent = completionMsg;
        showToast(completionMsg);

    } catch (error) {
        console.error('Import error:', error);
        showToast(t('import_error', (error as Error).message));
        dom.importStatus.textContent = t('import_errorStatus');
    } finally {

        showLoading(false);
        fileInput.value = ''; // リセット

        // 5秒後にステータスをクリア
        setTimeout(() => {
            // エラーや完了メッセージが表示されている場合のみクリア
            // "解析中..." や "アップロード中..." が残っている場合は異常なのでクリアしてよい
            if (dom.importStatus.textContent) {
                dom.importStatus.textContent = '';
            }
        }, 5000);
    }
}

/**
 * フィルター結果をCSVとしてエクスポート
 */
export async function handleExportCSV() {
    const filtered = getFilteredReferences();

    if (filtered.length === 0) {
        showToast(t('export_noData'));
        return;
    }

    try {
        // プロジェクトタイトルを取得
        let projectTitle = 'TiAb_Review';
        try {
            const info = await getSpreadsheetInfo(state.spreadsheetId);
            projectTitle = info.title.replace(/[\\/:*?"<>|]/g, '_');
        } catch {
            console.log('[handleExportCSV] Could not get spreadsheet title');
        }

        // フィルター条件ラベル
        const filterLabels: Record<string, string> = {
            'pending': t('export_filterPending'),
            'all': t('export_filterAll'),
            'include': 'Include',
            'exclude': 'Exclude',
            'maybe': 'Maybe',
            'conflict': t('export_filterConflict'),
        };
        const filterLabel = filterLabels[state.currentFilter] || state.currentFilter;

        // 日付
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // ファイル名
        const filename = `${projectTitle}_${filterLabel}_${dateStr}_${filtered.length}${t('export_countSuffix')}.csv`;

        // CSVヘッダー
        const headers = [
            'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'issn',
            'doi', 'pmid', 'status', 'note', 'source_file'
        ];

        // CSVデータを構築
        const csvRows: string[] = [];
        csvRows.push(headers.map(escapeCSVField).join(','));

        for (const ref of filtered) {
            const row = [
                ref.title || '',
                ref.authors || '',
                ref.year?.toString() || '',
                ref.journal || '',
                ref.volume || '',
                ref.issue || '',
                ref.pages || '',
                ref.issn || '',
                ref.doi || '',
                ref.pmid || '',
                ref.status || '',
                ref.myDecision?.note || '',
                ref.source_file || '',
            ];
            csvRows.push(row.map(escapeCSVField).join(','));
        }

        downloadBlob(csvRows.join('\r\n'), filename, 'text/csv;charset=utf-8');
        showToast(t('export_csvDone', String(filtered.length)));
    } catch (error) {
        console.error('[handleExportCSV] Error:', error);
        showToast(t('export_csvError'));
    }
}

/**
 * フィルター結果をRIS形式でエクスポート
 */
export async function handleExportRIS() {
    const filtered = getFilteredReferences();

    if (filtered.length === 0) {
        showToast(t('export_noData'));
        return;
    }

    try {
        // プロジェクトタイトルを取得
        let projectTitle = 'TiAb_Review';
        try {
            const info = await getSpreadsheetInfo(state.spreadsheetId);
            projectTitle = info.title.replace(/[\\/:*?"<>|]/g, '_');
        } catch {
            console.log('[handleExportRIS] Could not get spreadsheet title');
        }

        const filterLabels: Record<string, string> = {
            'pending': t('export_filterPending'),
            'all': t('export_filterAll'),
            'include': 'Include',
            'exclude': 'Exclude',
            'maybe': 'Maybe',
            'conflict': t('export_filterConflict'),
        };
        const filterLabel = filterLabels[state.currentFilter] || state.currentFilter;
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const filename = `${projectTitle}_${filterLabel}_${dateStr}_${filtered.length}${t('export_countSuffix')}.ris`;

        const risLines: string[] = [];

        for (const ref of filtered) {
            risLines.push('TY  - JOUR');
            if (ref.title) risLines.push(`TI  - ${ref.title}`);

            if (ref.authors) {
                const authors = ref.authors.split(/;\s*/);
                for (const author of authors) {
                    if (author && author !== 'et al.') {
                        risLines.push(`AU  - ${author.trim()}`);
                    }
                }
            }

            if (ref.year) risLines.push(`PY  - ${ref.year}`);
            if (ref.journal) risLines.push(`JO  - ${ref.journal}`);
            if (ref.volume) risLines.push(`VL  - ${ref.volume}`);
            if (ref.issue) risLines.push(`IS  - ${ref.issue}`);

            if (ref.pages) {
                const pageMatch = ref.pages.match(/^(\d+)\s*-\s*(\d+)$/);
                if (pageMatch) {
                    risLines.push(`SP  - ${pageMatch[1]}`);
                    risLines.push(`EP  - ${pageMatch[2]}`);
                } else {
                    risLines.push(`SP  - ${ref.pages}`);
                }
            }

            if (ref.issn) risLines.push(`SN  - ${ref.issn}`);
            if (ref.doi) risLines.push(`DO  - ${ref.doi}`);
            if (ref.pmid) risLines.push(`AN  - ${ref.pmid}`);
            if (ref.abstract) risLines.push(`AB  - ${ref.abstract}`);

            // URL
            if (ref.pmid) {
                risLines.push(`UR  - https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`);
            } else if (ref.doi) {
                risLines.push(`UR  - https://doi.org/${ref.doi}`);
            }

            // カスタムフィールド
            if (ref.myDecision?.note) {
                risLines.push(`N1  - ${ref.myDecision.note}`);
            }
            if (ref.status) {
                risLines.push(`C1  - Status: ${ref.status}`);
            }
            if (ref.source_file) {
                risLines.push(`DB  - ${ref.source_file}`);
            }

            risLines.push('ER  - ');
            risLines.push('');
        }

        downloadBlob(risLines.join('\r\n'), filename, 'application/x-research-info-systems;charset=utf-8');
        showToast(t('export_risDone', String(filtered.length)));

    } catch (error) {
        console.error('[handleExportRIS] Error:', error);
        showToast(t('export_risError'));
    }
}

/**
 * ファイルダウンロードヘルパー
 */
function downloadBlob(content: string, filename: string, type: string) {
    const bom = '\uFEFF';
    const blob = new Blob([bom + content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
