// 文献の取り込み予定を計算し、新規プロジェクトを作成する。
// バッチ単位の保存と共有の結果をまとめ、途中失敗時は確認済みの範囲を伝える。

import type { Reference } from '../lib/types';
import type { DuplicateMatch } from '../lib/duplicate-detect';
import { parseRIS } from '../lib/ris-parser';
import { partitionIncomingReferences } from '../lib/duplicate-import-filter';
import { isAbstractTruncated } from '../lib/import-helpers';
import { createSpreadsheet, addReferences, saveImportStats, saveDuplicateCandidates } from '../lib/sheets-api';
import { setupProjectFolder, ensureFulltextFolder } from '../lib/drive-api';
import { addPermission } from '../lib/drive-permissions';
import { buildInviteMessage, buildSpreadsheetUrl } from '../lib/share-invite';

/** 文献を一度に追記する件数の上限。 */
export const IMPORT_BATCH_SIZE = 500;

export interface ImportPlan {
    references: Reference[];
    toImport: Reference[];
    duplicateCount: number;
    reviewPairs: DuplicateMatch[];
    truncatedAbstractCount: number;
}

/** 文献を解析し、重複除外と抄録の切り詰めを含む取り込み予定を返す。 */
export function planImport(content: string, fileName: string): ImportPlan {
    const references = parseRIS(content, fileName);
    references.forEach(ref => {
        ref.source_file = fileName;
    });
    // Issue #245: 新規作成専用なので、既存行との照合は不要。
    const { toImport, autoSkipped, reviewPairs } = partitionIncomingReferences([], references);
    return {
        references, toImport, duplicateCount: autoSkipped.length, reviewPairs,
        truncatedAbstractCount: references.filter(ref => isAbstractTruncated(ref.abstract)).length,
    };
}

/** 取り込み中断時のシートと、保存確認済み・保存不明の範囲を保持する。 */
export class ImportInterruptedError extends Error {
    constructor(
        public readonly spreadsheetId: string,
        public readonly confirmedCount: number,
        public readonly failedFrom: number,
        public readonly failedTo: number,
        public readonly totalCount: number,
        public readonly cause: unknown,
    ) {
        super('取り込みの途中で失敗しました。失敗したバッチは入ったか不明なのでシートを確認してください。再実行すると行が二重になりうるため、自動では再試行しません。');
        this.name = 'ImportInterruptedError';
    }
}

/** 外部のエラー本文は認証値や URL を含みうるため、そのまま表示しない（Issue #245）。 */
export function safeApiErrorMessage(error: unknown): string {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? `API 処理に失敗しました（HTTP ${status}）。`
        : 'API 処理に失敗しました。通信状態とアクセス権限を確認してください。';
}

export interface CreateProjectResult {
    spreadsheetId: string;
    url: string;
    folderId: string | null;
    importedCount: number;
    duplicateCount: number;
    reviewPairCount: number;
    truncatedAbstractCount: number;
    shared: string[];
    shareFailures: {
        email: string;
        message: string;
    }[];
    folderShareFailures: {
        email: string;
        message: string;
    }[];
    warnings: string[];
}

/**
 * シートとフォルダを作成し、文献・統計・重複候補の保存後に共有する。
 * Issue #245: 取り込み中断は例外で通知し、補助処理の失敗は結果にまとめる。
 *
 * 順序は画面側の handleCreateNew()（sidepanel/features/project.ts）・handleRISImport()
 * （sidepanel/features/import-export.ts）・handleShare()（sidepanel/features/sharing.ts）と
 * 揃えてある。画面側かこちらの手順を変えたら、もう片方も確認すること。
 * フルテキスト保存用フォルダの先行作成だけは、画面側に無い CLI 固有の手順である。
 */
export async function runCreateProject(input: {
    title: string;
    fileName: string;
    plan: ImportPlan;
    share: string[];
    onProgress?: (message: string) => void;
    formatError?: (error: unknown) => string;
}): Promise<CreateProjectResult> {
    const { title, fileName, plan, share, onProgress } = input;
    const formatError = input.formatError ?? safeApiErrorMessage;
    if (plan.toImport.length === 0) {
        throw new Error('有効な文献がありません');
    }
    const spreadsheetId = await createSpreadsheet(title);
    const result: CreateProjectResult = {
        spreadsheetId, url: buildSpreadsheetUrl(spreadsheetId), folderId: null,
        importedCount: 0, duplicateCount: plan.duplicateCount, reviewPairCount: plan.reviewPairs.length,
        truncatedAbstractCount: plan.truncatedAbstractCount,
        shared: [], shareFailures: [], folderShareFailures: [], warnings: [],
    };
    try {
        result.folderId = await setupProjectFolder(spreadsheetId, title);
    } catch (error) {
        result.warnings.push(`プロジェクトフォルダを整理できませんでした: ${formatError(error)}`);
    }
    if (result.folderId) {
        try {
            // Issue #245: CLI が作ったプロジェクトフォルダは拡張機能からは未付与になりうる。
            // フルテキストフォルダIDが Config に無いと、初回 PDF 保存が ensureProjectFolder() の inaccessible で止まる。
            // 記録済みなら未付与でもそのIDでアップロードできるため、CLI で先に作成・保存する。
            await ensureFulltextFolder(spreadsheetId);
        } catch (error) {
            result.warnings.push(`フルテキスト保存用フォルダを作成できませんでした: ${formatError(error)}`);
        }
    }
    for (let i = 0; i < plan.toImport.length; i += IMPORT_BATCH_SIZE) {
        const chunk = plan.toImport.slice(i, i + IMPORT_BATCH_SIZE);
        try {
            await addReferences(spreadsheetId, chunk);
        } catch (error) {
            throw new ImportInterruptedError(spreadsheetId, i, i + 1, i + chunk.length, plan.toImport.length, error);
        }
        result.importedCount += chunk.length;
        onProgress?.(`取り込み済み: ${result.importedCount} / ${plan.toImport.length} 件`);
    }
    try {
        await saveImportStats(spreadsheetId, {
            [fileName]: {
                identified: plan.references.length,
                duplicates: plan.duplicateCount,
                imported_at: new Date().toISOString(),
            },
        });
    } catch (error) {
        result.warnings.push(`インポート統計を保存できませんでした: ${formatError(error)}`);
    }
    if (plan.reviewPairs.length > 0) {
        try {
            await saveDuplicateCandidates(spreadsheetId, plan.reviewPairs);
        } catch (error) {
            result.warnings.push(`重複候補を保存できませんでした: ${formatError(error)}`);
        }
    }
    for (const email of share) {
        try {
            await addPermission(spreadsheetId, email, 'writer', buildInviteMessage(spreadsheetId, title));
        } catch (error) {
            result.shareFailures.push({ email, message: formatError(error) });
            continue;
        }
        result.shared.push(email);
        if (result.folderId) {
            try {
                await addPermission(result.folderId, email, 'writer', undefined, { sendNotificationEmail: false });
            } catch (error) {
                result.folderShareFailures.push({ email, message: formatError(error) });
            }
        }
    }
    return result;
}
