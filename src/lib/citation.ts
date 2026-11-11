/** Zenodo の concept DOI（全版を束ねる DOI）。初回の Zenodo 保存の後に値を入れる。空文字なら DOI を出さない。 */
export const TIAB_REVIEW_CONCEPT_DOI = '';

export function conceptDoiUrl(): string | null {
    return TIAB_REVIEW_CONCEPT_DOI ? `https://doi.org/${TIAB_REVIEW_CONCEPT_DOI}` : null;
}

/**
 * 評価結果のデータセット（AI 判定の評価の生の結果とレポート）の Zenodo concept DOI。
 * 初回の Zenodo 公開の後に値を入れる。空文字なら論文用テキストに出さない。
 */
export const AI_EVALUATION_DATASET_DOI = '';
