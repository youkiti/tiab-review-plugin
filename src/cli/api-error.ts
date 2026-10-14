/** 外部のエラー本文は認証値や URL を含みうるため、そのまま表示しない（Issue #245）。 */
export function safeApiErrorMessage(error: unknown): string {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? `API 処理に失敗しました（HTTP ${status}）。`
        : 'API 処理に失敗しました。通信状態とアクセス権限を確認してください。';
}

