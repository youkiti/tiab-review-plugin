/**
 * 論文用テキストに書く TiAb Review の版（判定を記録した版の範囲）を求める純関数。
 * UI・state を import しない。
 */
import type { Decision } from './types';

/**
 * client_version から `x.y.z` を取り出す。拡張版 `0.57.2-human`、Web 版 `web-0.57.2-human`
 * （`web-0.57.2+abc1234-human` も可）、コマンドライン版 `cli-0.57.2-human` を読む。
 * 読めない形式（`llm-processor-v1`・`unknown-human` など）は null。
 */
export function parseClientSemver(clientVersion?: string): string | null {
    const match = /^(?:web-|cli-)?(\d+)\.(\d+)\.(\d+)(?=$|[+-])/.exec(clientVersion ?? '');
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** `x.y.z` を数値として比べる（0.9.0 < 0.10.0）。 */
export function compareSemver(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/** 判定（pending の行も含む）を記録した版の最小と最大。1件も読めなければ null。 */
export function collectVersionRange(decisions: readonly Decision[]): { min: string; max: string } | null {
    let min: string | null = null;
    let max: string | null = null;
    for (const decision of decisions) {
        const version = parseClientSemver(decision.client_version);
        if (!version) continue;
        if (min === null || compareSemver(version, min) < 0) min = version;
        if (max === null || compareSemver(version, max) > 0) max = version;
    }
    return min !== null && max !== null ? { min, max } : null;
}

/**
 * Methods の括弧内に入れる版の句。
 * range が null なら現在の版（読めなければ `[version]`）。DOI の URL があれば `; ` に続けて付ける。
 */
export function formatToolVersionClause(
    range: { min: string; max: string } | null,
    currentVersion: string,
    doiUrl: string | null,
): string {
    let clause: string;
    if (range && range.min !== range.max) {
        clause = `versions ${range.min} to ${range.max}`;
    } else {
        const single = range ? range.min : (currentVersion === 'unknown' ? '[version]' : currentVersion);
        clause = `version ${single}`;
    }
    return doiUrl ? `${clause}; ${doiUrl}` : clause;
}
