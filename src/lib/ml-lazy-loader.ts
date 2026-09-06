/** ML機能のロードを共有し、成功だけをキャッシュする。DOMには依存しない。 */
export function createMlFeatureLoader<T>(importer: () => Promise<T>): () => Promise<T> {
    let cached: Promise<T> | null = null;
    return () => {
        if (!cached) {
            // 同期例外も読み込み失敗として返し、次の操作で再試行できるようにする。
            cached = Promise.resolve().then(importer).catch(error => {
                cached = null;
                throw error;
            });
        }
        return cached;
    };
}
