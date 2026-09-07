/**
 * fulltext/drive-import/types.ts - mapping-modal.ts と exec.ts の間で共有する型
 *
 * MappingEntry（対応付けモーダルの行データ）は本来 mapping-modal.ts に、ExecResult（実行結果）は
 * 本来 exec.ts に属する型だが、そのまま置くと import が双方向になる:
 *  - mapping-modal.ts → exec.ts: 実行開始（runImportAndShowResults）を呼ぶ
 *  - exec.ts → mapping-modal.ts: runImportAndShowResults の引数の型として MappingEntry が要る
 *  - exec.ts → result-view.ts: 結果描画（renderResultStep）・モーダル閉じるボタン制御
 *    （setModalCloseEnabled）を呼ぶ
 *  - result-view.ts → exec.ts: renderResultStep 自身の引数・内部処理の型として ExecResult が要る
 * check-structure.mjs は型importも辺として数えるため、これは新しい循環として検出される
 * （AGENTS.md「開発規約（依存方向・ファイル規模・CI 回帰条件）」節）。依存の無いこのファイルへ
 * 両方の型を切り出すことで、mapping-modal.ts / exec.ts / result-view.ts からの参照を
 * 一方向（→types.ts）に揃えて回避した（Issue #191 分割時の対応）。
 *
 * なお retrySingle（実体は exec.ts）は renderResultStep の引数として渡す形にしており
 * （result-view.ts 冒頭コメント参照）、こちらは型ではなく値の受け渡しなので本ファイルには
 * 登場しない。
 */

import type { ValidatedFile } from './validate';

export interface MappingEntry {
    file: ValidatedFile;
    refId: string | null;
    /** ファイル名の最良マッチがcached済み文献だった場合の、そのマッチ先タイトル（既定値はプリセットしない） */
    likelyImportedTitle?: string;
    /**
     * importState==='done' の行で、そのPDFが既に取り込まれている文献のタイトル。
     * done は対応付け候補から外れる（1ソースPDF＝1文献。drive-import-classify.ts 冒頭コメント参照）
     * ため、「どこへ行ったか」と「対応付け直す方法」を示せないとユーザーからは行き止まりに見える。
     * 取り込み先が担当外・ロード後に追加された等で state.allReferences から引けない場合は undefined
     * （その場合はバッジのみで、当て推量のタイトルは出さない）。
     */
    importedIntoTitle?: string;
}

export interface ExecResult {
    file: ValidatedFile;
    refId: string;
    refTitle: string;
    outcome: 'success' | 'skipped-cached' | 'error';
    message: string;
}
