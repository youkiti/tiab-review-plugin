/**
 * Web 版プラットフォームアダプタ: localStorage を用いた chrome.storage.local 互換の
 * key-value ストレージ実装。他アプリとの衝突を避けるため 'tiab:' プレフィックスを付与する。
 */
const PREFIX = 'tiab:';

/** 指定したキー群の値を取得する（JSON デコード済み）。存在しないキーは結果に含めない */
export async function storageGet(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw !== null) { try { out[key] = JSON.parse(raw); } catch { /* 壊れた値は無視 */ } }
    }
    return out;
}

/** 複数キーの値をまとめて保存する（JSON エンコードして保存） */
export async function storageSet(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    }
}

/** 指定したキー（単一 or 複数）を削除する */
export async function storageRemove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(PREFIX + key);
}

/** このアプリの localStorage 領域（'tiab:' プレフィックス付きキー）をすべて削除する */
export async function storageClear(): Promise<void> {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
}
