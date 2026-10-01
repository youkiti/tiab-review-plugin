/**
 * ツアーの文言（messages.json）のキーの組み立て。各ツアーのファイルが使う。
 * キーはツアー ID・手順 ID のハイフンをアンダースコアにしたもの。
 * 拡張版だけのツアーは `guideExt_tour_`（Web 版ビルドが `guideExt_` 接頭辞のキーを落とす）、
 * Web 版でも出るツアーは `guide_tour_` を接頭辞にする。
 */

/** ツアー ID から i18n キーの共通部分を作る（例: tourKeyBase('guideExt_tour_', 'ai-first-run') → guideExt_tour_ai_first_run）。 */
export function tourKeyBase(prefix: string, tourId: string): string {
    return `${prefix}${tourId.replace(/-/g, '_')}`;
}

/** 手順の本文のキー（例: stepKey(base, 'project-create') → <base>_project_create）。 */
export function stepKey(base: string, stepId: string): string {
    return `${base}_${stepId.replace(/-/g, '_')}`;
}
