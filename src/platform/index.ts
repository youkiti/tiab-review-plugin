import type { PlatformAdapter } from './types';

let impl: PlatformAdapter | null = null;

/** 各エントリポイントの先頭（他モジュールの副作用より前）で必ず呼ぶ */
export function setPlatform(p: PlatformAdapter): void {
    impl = p;
}

export function platform(): PlatformAdapter {
    if (!impl) throw new Error('Platform not initialized. Call setPlatform() at the entry point.');
    return impl;
}
