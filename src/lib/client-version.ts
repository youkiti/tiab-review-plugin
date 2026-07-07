/**
 * client_version 共通ユーティリティ
 * manifest.jsonからバージョンを取得し、処理種別サフィックスを付与
 */
import { platform } from '../platform';

/**
 * manifest.jsonからバージョンを取得し、サフィックスを付与
 * 非拡張環境(Node.js等)では 'unknown' を返す
 * 
 * @param suffix - 処理種別サフィックス
 *   - '-human': ヒト判定
 *   - '-ml': ML手動判定
 *   - '-ml-auto': ML自動判定
 *   - '-llm': LLM判定
 */
export function getClientVersion(suffix: string = ''): string {
    let manifestVersion: string;
    try {
        manifestVersion = platform().getVersionString();
    } catch {
        // 非拡張環境(Node.js等) では platform() 未初期化のため 'unknown'
        manifestVersion = 'unknown';
    }
    return `${manifestVersion}${suffix}`;
}

// ========== 判定種別の識別関数（サフィックスベース + 後方互換） ==========

/**
 * ヒト判定か判定する
 * 旧形式 '0.1.0' も認識
 */
export function isHumanDecision(clientVersion?: string): boolean {
    if (!clientVersion) return false;
    // 旧形式との後方互換
    if (clientVersion === '0.1.0') return true;
    return clientVersion.includes('-human');
}

/**
 * ML系判定か判定する（手動/自動問わず）
 */
export function isMlDecision(clientVersion?: string): boolean {
    if (!clientVersion) return false;
    return clientVersion.includes('-ml');
}

/**
 * ML手動判定（ユーザー確認済み）か判定する
 * 旧形式 '0.7.0-ml' も認識
 */
export function isConfirmedMlDecision(clientVersion?: string): boolean {
    if (!clientVersion) return false;
    // 旧形式との後方互換
    if (clientVersion.startsWith('0.7.0-ml') && !clientVersion.includes('auto')) return true;
    // 新形式: -ml を含み -auto を含まない
    return clientVersion.includes('-ml') && !clientVersion.includes('-auto');
}

/**
 * ML自動判定か判定する
 */
export function isMlAutoDecision(clientVersion?: string): boolean {
    if (!clientVersion) return false;
    return clientVersion.includes('-ml-auto');
}

/**
 * LLM判定か判定する
 * 旧形式 'llm-processor-v1' も認識
 */
export function isLlmDecision(clientVersion?: string): boolean {
    if (!clientVersion) return false;
    // 旧形式との後方互換
    if (clientVersion === 'llm-processor-v1') return true;
    return clientVersion.includes('-llm');
}
