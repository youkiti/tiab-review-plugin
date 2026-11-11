/**
 * 一括 OA 検索・論文候補の一括再探索の書き込み（Drive フォルダの作成・取得結果の URL・論文候補）。
 * DOM・state に依存しない依存注入型にして、node のテストから宛先を検証できるようにする
 * （tab.ts は DOM 依存でテストから直接は通せない）。
 *
 * 書き込み先の spreadsheetId は、一括処理の開始時に控えた値を渡して固定する。
 * 実行中に戻る・ログアウトで別のプロジェクトへ切り替わっても、前のプロジェクトの取得結果が
 * 切り替えた後のプロジェクトのシートと Drive フォルダへ書かれないようにするため
 * （一括処理の中で `state.spreadsheetId` を読まない）。
 */

import { t } from '../../../lib/i18n';
import { flushCandidateBuffer } from '../../../lib/publication-candidate-rerun';
import type { PublicationCandidateDraft } from '../../../lib/publication-suggest';
import type { FulltextUrlUpdateEntry } from '../../../lib/fulltext-drive-write';

/** 一括処理の中断フラグ（戻る・ログアウトでも、中止ボタンと同じく cancelled を立てる） */
export interface BulkRun {
    cancelled: boolean;
}

export interface BulkWriterDeps {
    ensureFulltextFolder: (spreadsheetId: string) => Promise<string>;
    updateReferenceFulltextUrls: (spreadsheetId: string, updates: FulltextUrlUpdateEntry[]) => Promise<unknown>;
    savePublicationCandidates: (spreadsheetId: string, candidates: PublicationCandidateDraft[]) => Promise<unknown>;
    /** Drive のアクセス拒否・認証切れ・一時エラーなら、表示する文言を返す */
    describeDriveAccessError: (err: unknown) => string | null;
    showToast: (message: string, duration?: number) => void;
}

export type PendingFulltextWrite = FulltextUrlUpdateEntry & { driveSource: null };

export interface BulkWriter {
    /** 全文フォルダ（最初の取得成功時に一度だけ作る。結果は使い回す） */
    ensureFolder: () => Promise<string>;
    pendingWrites: PendingFulltextWrite[];
    pendingCandidates: PublicationCandidateDraft[];
    /** URL の書き込みと論文候補の保存を行う（互いに独立。失敗した候補はバッファに残して次回へ） */
    flush: () => Promise<void>;
    /** 論文候補だけ保存する。保存できた（またはバッファが空の）ときだけ true */
    flushCandidates: () => Promise<boolean>;
}

export function createBulkWriter(spreadsheetId: string, deps: BulkWriterDeps): BulkWriter {
    // ensureFulltextFolder が fail-fast エラー（アクセス拒否/認証切れ/一時エラー）を
    // 投げた場合はここで一度だけ toast を出す（memo化により2回目以降は再実行されない）。
    // retrieveAndCacheFulltext 側の catch でこのエラーは既存どおり linked へフォールバックする
    // ため、ここでは再送出するだけで分岐は変えない。
    let folderPromise: Promise<string> | null = null;
    const ensureFolder = (): Promise<string> => (folderPromise ??= deps.ensureFulltextFolder(spreadsheetId).catch(err => {
        const knownMessage = deps.describeDriveAccessError(err);
        if (knownMessage) deps.showToast(knownMessage, 6000);
        throw err;
    }));

    const pendingWrites: PendingFulltextWrite[] = [];
    // registration行の論文候補。pendingWrites と同じ流儀でため込み、まとめて保存する。
    // 行ごとに保存すると Sheets API の読み取りクォータを容易に超えるため
    // （詳細は sheets/publication-candidates.ts の savePublicationCandidates() のコメント参照）。
    const pendingCandidates: PublicationCandidateDraft[] = [];

    const flushCandidates = async (): Promise<boolean> => {
        if (pendingCandidates.length === 0) return true;
        // pendingCandidates は保存に成功した分だけ flushCandidateBuffer() が取り除く。
        // 失敗時はバッファをそのまま残し、次回の flush（5件ごと or 最終）で再送する。
        const saved = await flushCandidateBuffer(
            pendingCandidates,
            async batch => { await deps.savePublicationCandidates(spreadsheetId, batch); }
        );
        if (!saved) {
            console.warn('[fulltext-tab] 論文候補の保存に失敗（バッファを保持し次回flushで再送）');
        }
        return saved;
    };

    const flush = async (): Promise<void> => {
        // URL書き込みと候補保存は互いに独立させる: 片方の失敗がもう片方のフラッシュを
        // 巻き込まないよう、try/catch を別々に付ける。
        if (pendingWrites.length > 0) {
            const batch = pendingWrites.splice(0);
            try {
                await deps.updateReferenceFulltextUrls(spreadsheetId, batch);
            } catch (err) {
                console.warn('[fulltext-tab] シートへの保存に失敗:', err);
                deps.showToast(t('fulltext_sheetSaveError', (err as Error).message), 5000);
            }
        }
        await flushCandidates();
    };

    return { ensureFolder, pendingWrites, pendingCandidates, flush, flushCandidates };
}
