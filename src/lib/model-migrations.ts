/**
 * latest エイリアスから固定 ID、および提供終了済み・終了しうる旧固定版から後継固定版へのマイグレーションマップ
 * 既存ユーザーの保存済み model 設定を起動時に書き換える際に使用。
 * Jev 1.13.0 は 2026-10-15 時点で直 API で利用可能だが、1.12.0 は新版公開後に 400 Unknown model となった前例がある。
 *
 * chrome 依存を持たない定数のみを切り出したモジュール。
 * sheets/config-schema.ts（共有コード）が gemini-api（拡張専用・LLM 実行）を巻き込まずに
 * 参照できるようにするため、gemini-api から本ファイルへ分離した。
 */
export const MODEL_ID_MIGRATIONS: Record<string, string> = {
    'gemini-flash-lite-latest': 'gemini-3.1-flash-lite',
    'gemini-flash-latest': 'gemini-3-flash-preview',
    'jev-1.13.0': 'jev-1.14.0',
    'typesafe/jev-1.13': 'typesafe/jev-1.14',
};
