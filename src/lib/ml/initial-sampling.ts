/**
 * 初期ランダムサンプリング
 * 
 * シード付き疑似乱数でランダムサンプリングを行い、再現性を確保する
 */

/**
 * シード付き疑似乱数生成器（Mulberry32）
 * 
 * @param seed - シード値
 * @returns 0〜1 の乱数を返す関数
 */
function mulberry32(seed: number): () => number {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Fisher-Yates シャッフル（シード付き）
 * 
 * @param array - シャッフル対象の配列
 * @param random - 乱数生成器
 * @returns シャッフルされた新しい配列
 */
function shuffleWithRandom<T>(array: T[], random: () => number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * シード付きランダムサンプリング
 * 
 * @param recordIds - サンプリング対象の ID 配列
 * @param sampleSize - サンプルサイズ
 * @param seed - シード値
 * @returns サンプリングされた ID 配列
 */
export function sampleInitialRecords(
    recordIds: string[],
    sampleSize: number,
    seed: number
): string[] {
    if (sampleSize >= recordIds.length) {
        // サンプルサイズがレコード数以上なら全件返す
        return [...recordIds];
    }

    const random = mulberry32(seed);
    const shuffled = shuffleWithRandom(recordIds, random);
    return shuffled.slice(0, sampleSize);
}

/**
 * 初期フェーズが完了したかチェック
 * 
 * @param initialIds - 初期ランダムサンプルの ID 配列
 * @param labeledIds - ラベル済み ID のセット
 * @returns 全ての初期サンプルがラベル済みなら true
 */
export function isInitialPhaseComplete(
    initialIds: string[],
    labeledIds: Set<string>
): boolean {
    return initialIds.every(id => labeledIds.has(id));
}

/**
 * 監査サンプルを抽出
 * 
 * @param remainingIds - 残り未読 ID 配列
 * @param sampleSize - サンプルサイズ
 * @param seed - シード値
 * @returns 監査サンプルの ID 配列
 */
export function sampleAuditRecords(
    remainingIds: string[],
    sampleSize: number,
    seed: number
): string[] {
    return sampleInitialRecords(remainingIds, sampleSize, seed);
}

/**
 * ランダムシードを生成
 * 
 * @returns 現在時刻ベースのシード値
 */
export function generateRandomSeed(): number {
    return Date.now() ^ Math.floor(Math.random() * 0x100000000);
}
