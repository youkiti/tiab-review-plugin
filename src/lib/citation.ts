/** Zenodo の concept DOI（全版を束ねる DOI）。初回の Zenodo 保存の後に値を入れる。空文字なら DOI を出さない。 */
export const TIAB_REVIEW_CONCEPT_DOI = '';

export function conceptDoiUrl(): string | null {
    return TIAB_REVIEW_CONCEPT_DOI ? `https://doi.org/${TIAB_REVIEW_CONCEPT_DOI}` : null;
}
