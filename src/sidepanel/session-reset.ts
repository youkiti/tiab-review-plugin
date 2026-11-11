/**
 * 遅延チャンクの機能（全文タブなど）が、戻る・ログアウト時の自分の初期化を登録する仕組み。
 * compat.ts から遅延チャンクのモジュールを直接 import すると初期 JS に入ってしまうため、
 * 読み込まれたモジュール側が登録する。一度も読み込まれていない機能は登録されず、何もしない
 * （初期値のままなので正しい）。
 */

export type SessionResetReason = 'back' | 'logout';

/** 初期化の関数。実行中の処理を中止したら true を返す */
export type SessionResetHandler = (reason: SessionResetReason) => boolean;

const handlers = new Map<string, SessionResetHandler>();

/** 初期化を登録する。同じ name は上書きする（登録順は最初の登録のまま） */
export function registerSessionReset(name: string, handler: SessionResetHandler): void {
    handlers.set(name, handler);
}

/**
 * 登録順に全部呼ぶ。1つが例外を投げても残りは呼ぶ。
 * @returns 1つでも true を返したら true（実行中の処理を中止した）
 */
export function runSessionResets(reason: SessionResetReason): boolean {
    let aborted = false;
    for (const [name, handler] of handlers) {
        try {
            if (handler(reason)) aborted = true;
        } catch (error) {
            console.error(`[session-reset] ${name} の初期化に失敗しました`, error);
        }
    }
    return aborted;
}

export function _getSessionResetNamesForTest(): string[] {
    return [...handlers.keys()];
}

export function _clearSessionResetsForTest(): void {
    handlers.clear();
}
