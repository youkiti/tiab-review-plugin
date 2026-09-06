/**
 * latest エイリアスから固定 ID へのマイグレーションマップ
 * 既存ユーザーの保存済み model 設定を起動時に書き換える際に使用。
 *
 * chrome 依存を持たない定数のみを切り出したモジュール。
 * sheets/config-schema.ts（共有コード）が gemini-api（拡張専用・LLM 実行）を巻き込まずに
 * 参照できるようにするため、gemini-api から本ファイルへ分離した。
 */
export const MODEL_ID_MIGRATIONS: Record<string, string> = {
    'gemini-flash-lite-latest': 'gemini-3.1-flash-lite',
    'gemini-flash-latest': 'gemini-3-flash-preview',
};
