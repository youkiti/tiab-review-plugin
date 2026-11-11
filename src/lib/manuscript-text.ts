/**
 * 論文用テキスト（Methods / Results / PRISMA 2020 フロー数値）の組み立て（純関数）
 *
 * state・通信・DOM に依存しない。画面側（sidepanel/features/manuscript.ts）が state と通信から
 * ManuscriptInput を組み立てて buildManuscriptOutput() を呼び、結果を DOM に出す。
 * シートの行から出力までの通しの検査は tests/manuscript-e2e.test.ts にある。
 *
 * 生成ルール:
 *  - 数値・モデル名などは input から自動挿入する
 *  - ツールが持たない情報（不一致の解消方法など）は [ ] で残し、手入力を促す
 *  - 識別件数・重複除去数は Config シートの import_stats（インポート時に記録）を使い、
 *    統計がないファイルは重複除去後の件数に * を付けて明示する
 */

import { buildManuscriptAiSentence, buildFulltextAiMethodsSentence, countManuscriptStoppingRuleExclusions } from './manuscript-ai';
import { collectReviewerKeys } from './decision-summary';
import { isLogicallyDeleted } from './duplicate-detect';
import { getFulltextResultsSummaryByRoute } from './fulltext-results-summary';
import type { FulltextResultsSummary } from './fulltext-results-summary';
import { buildOtherMethodsPrismaLines, splitByIdentificationRoute } from './identification-route';
import { isTiabDecision } from './fulltext-pool';
import type { FulltextPoolRule } from './fulltext-pool';
import type { FulltextAssignmentConfig } from './fulltext-assignment';
import { selectProjectFulltextCandidates } from './fulltext-candidates';
import { isMlDecision, isLlmDecision } from './client-version';
import { isCmhStoppingRule } from './ml/types';
import type { StoppingRule } from './ml/types';
import { computeIdentification } from './prisma-identification';
import type { IdentificationData } from './prisma-identification';
import { collectRefDecisions } from './reference-status';
import type { AssignmentConfig, ImportStatsMap, LlmExecution, ReferenceWithStatus } from './types';
import { excludeReasonLabelEn, EXCLUDE_REASON_LABELS_EN } from './exclude-reasons';
import type { ExcludeReasonItem } from './exclude-reasons';

export type ManuscriptPhase = 'tiab' | 'fulltext';

export interface ManuscriptInput {
    phase: ManuscriptPhase;
    projectTitle: string;
    /** 'YYYY-MM-DD'。PRISMA ブロックの見出しに使う */
    generatedDate: string;
    /** getClientVersion() の値。'unknown' なら '[version]' と書く */
    extensionVersion: string;
    /**
     * Identification 集計の入力。論理削除した行（重複、duplicate_of 非空）を含む全件を渡すこと
     * （除外件数を duplicatesTotal へ合算するため。Issue #145）。
     */
    identificationRefs: Pick<ReferenceWithStatus, 'source_file' | 'related_ref_id' | 'duplicate_of'>[];
    /**
     * 全件の取得に失敗して論理削除行を数えられないとき true。computeIdentification() が
     * duplicatesTotal を null に強制し、数字が黙って過少になることを防ぐ。
     */
    refsMayOmitLogicallyDeleted: boolean;
    /** state.allReferences 相当（論理削除行を除いたもの） */
    references: ReferenceWithStatus[];
    importStats: ImportStatsMap;
    fulltextPoolRule: FulltextPoolRule | null;
    fulltextAssignment: FulltextAssignmentConfig;
    assignmentConfig: AssignmentConfig;
    treatMlAsManual: boolean;
    mlStoppingRule: StoppingRule | null;
    llmIncludeThreshold: number;
    llmExecutions: readonly LlmExecution[];
    /** 呼び出し側で buildManuscriptValidationSentence() から作る（tiab 相のみ） */
    validationSentence: string;
    excludeReasonItems: readonly ExcludeReasonItem[];
    enabledJudges: Set<string> | null;
    userEmail: string;
    isKeyOpened: boolean;
}

/** 数値が最終値でない可能性の警告。文言は画面側が t(key, args) で作る（翻訳は lib に持ち込まない） */
export type ManuscriptWarning =
    | { key: 'manuscript_warnUnscreened'; args: [string] }
    | { key: 'manuscript_warnUnresolved'; args: [string, string, string] }
    | { key: 'manuscript_warnNoStats' }
    | { key: 'manuscript_warnBlind' };

export interface ManuscriptOutput {
    methods: string;
    results: string;
    prisma: string;
    warnings: ManuscriptWarning[];
    /** テストで数字を直接見るため */
    identification: IdentificationData;
    sought: number;
    fulltext: { database: FulltextResultsSummary; registryLinkage: FulltextResultsSummary } | null;
    stoppingRuleExclusions: number;
    tiabHumanReviewers: number;
}

/**
 * 論文用テキスト・PRISMA フロー図向けの英語ラベル。
 * プロジェクト設定の理由リスト（英語ラベル欄）を使い、未入力なら日本語ラベルで代替する。
 *
 * 現在の理由リストに無いキー（設定変更前に確定した判定など）は、生キーへ落ちる前に
 * 既定リスト（EXCLUDE_REASON_LABELS_EN）を引く。既定キー（population 等）は
 * プロジェクト設定を変えても値自体は変わらないため、これで論文の英文 Results/PRISMA に
 * `study_design (n = 12)` のような生キーが混入するのを防げる。カスタムキー（r1 等）は
 * 既定リストにも無いため、その場合のみ最終的に生キーが残る。
 */
function reasonLabelEn(reason: string, items: readonly ExcludeReasonItem[]): string {
    if (!reason) return 'Reason not recorded';
    if (items.some(i => i.key === reason)) {
        return excludeReasonLabelEn(reason, items);
    }
    return EXCLUDE_REASON_LABELS_EN[reason as keyof typeof EXCLUDE_REASON_LABELS_EN] ?? reason;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** TiAb 相にヒト判定を出したレビュアー数（LLM/ML自動を除く。最低1） */
function countTiabHumanReviewers(references: ReferenceWithStatus[]): number {
    const reviewers = new Set<string>();
    for (const r of references) {
        for (const d of collectRefDecisions(r)) {
            if (!isTiabDecision(d)) continue;
            const id = (d.reviewer_id || '').trim();
            if (!id || id.startsWith('llm:')) continue;
            if (isLlmDecision(d.client_version)) continue;
            if (isMlDecision(d.client_version)) continue;
            reviewers.add(id);
        }
    }
    return Math.max(reviewers.size, 1);
}

/** TiAb 相で ML 判定（確定/自動）が使われたか */
function wasMlUsedInTiab(references: ReferenceWithStatus[]): boolean {
    for (const r of references) {
        for (const d of collectRefDecisions(r)) {
            if (isTiabDecision(d) && isMlDecision(d.client_version)) return true;
        }
    }
    return false;
}

/**
 * TiAb 未判定（誰の非 pending 判定も無い）の文献数
 *
 * Registry linkage 由来の取り込み行（related_ref_id 非空）は設計上 TiAb 票を一切持たない
 * （fulltext-candidates.ts の isProjectFulltextCandidateRef() の JSDoc参照）ため、
 * ここに混ぜると実態のない「TiAb未判定」として全件カウントされてしまう。database腕
 * だけを数える（Issue #120）。0件のときは splitByIdentificationRoute() の性質上
 * database === references になるため、現行の出力から1文字も変わらない。
 */
function countUnscreenedTiab(references: ReferenceWithStatus[]): number {
    let count = 0;
    const { database } = splitByIdentificationRoute(references);
    for (const r of database) {
        const hasJudged = collectRefDecisions(r).some(
            d => isTiabDecision(d) && d.decision !== 'pending'
        );
        if (!hasJudged) count++;
    }
    return count;
}

/** 候補入りせず、停止基準の未読除外だけで除外になった文献を数える。 */
function countStoppingRuleExclusions(input: ManuscriptInput, candidates: ReferenceWithStatus[]): number {
    const { database } = splitByIdentificationRoute(input.references);
    const candidateIds = new Set(candidates.map(ref => ref.ref_id));
    const refs = database.filter(ref => !isLogicallyDeleted(ref))
        .map(ref => ({ ...ref, allDecisions: collectRefDecisions(ref) }));
    const keys = collectReviewerKeys(refs, new Set(), input.treatMlAsManual);
    return countManuscriptStoppingRuleExclusions(
        refs.filter(ref => !candidateIds.has(ref.ref_id)), keys, input.treatMlAsManual, input.assignmentConfig
    );
}

// ---------------------------------------------------------------------------
// テキスト生成（英語固定）
// ---------------------------------------------------------------------------

function extensionVersion(input: ManuscriptInput): string {
    const v = input.extensionVersion;
    return v === 'unknown' ? '[version]' : v;
}

/** 英語の単数/複数形（不規則形は pluralForm で指定） */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
    return n === 1 ? singular : pluralForm;
}

function wasWere(n: number): string {
    return n === 1 ? 'was' : 'were';
}

function buildTiabMethods(input: ManuscriptInput, id: IdentificationData, stoppingExcluded: number): string {
    const fileList = id.files.map(f => f.file).join('; ');
    const nReviewers = countTiabHumanReviewers(input.references);

    const paragraphs: string[] = [];
    // レビュアー1名のときは blinded 節が意味を成さないので省く
    const blindClause = nReviewers > 1 ? ", without access to each other's decisions" : '';
    paragraphs.push(
        `Records exported from each database (${fileList}) were imported into TiAb Review (version ${extensionVersion(input)}) and deduplicated automatically. ` +
        `Titles and abstracts were screened against the predefined eligibility criteria by ${nReviewers} ${plural(nReviewers, 'reviewer')}${blindClause}.`
    );

    if (wasMlUsedInTiab(input.references)) {
        let sentence = 'Records were prioritized for screening by an active-learning model.';
        const rule = input.mlStoppingRule;
        if (rule && isCmhStoppingRule(rule)) {
            sentence += ` Screening was stopped when the Callaghan–Müller-Hansen stopping criterion (target recall ${rule.targetRecall}, confidence level ${Math.round(rule.confidence * 100)}%) was met; this criterion estimates, but does not guarantee, the recall achieved.`;
        } else if (rule) {
            sentence += ` Screening was stopped after ${rule.threshold} consecutive excluded records, a heuristic rule that provides no statistical estimate of recall.`;
        }
        paragraphs.push(sentence);
    }

    if (stoppingExcluded > 0) {
        paragraphs.push(`${stoppingExcluded} records were excluded without reviewer screening when the ML stopping criterion was met; these exclusions were reported separately from reviewer exclusions.`);
    }

    const { database } = splitByIdentificationRoute(input.references);
    const aiSentence = buildManuscriptAiSentence(
        database.filter(ref => !isLogicallyDeleted(ref)).flatMap(collectRefDecisions), id.screened, input.llmIncludeThreshold,
        input.llmExecutions,
    );
    if (aiSentence) {
        paragraphs.push(aiSentence);
    }
    if (input.validationSentence) {
        paragraphs.push(input.validationSentence);
    }
    const rule = input.fulltextPoolRule;
    const threshold = rule ? rule.threshold : 1;
    paragraphs.push(
        `Records judged include at the title/abstract stage by at least ${threshold} of the selected screeners proceeded to full-text review. ` +
        `Disagreements were resolved by [discussion / a third reviewer].`
    );

    return paragraphs.join('\n\n');
}

function buildTiabResults(id: IdentificationData, sought: number, stoppingExcluded: number): string {
    const perFile = id.files
        .map(f => `${f.file}, n = ${f.identified}${f.hasStats ? '' : '*'}`)
        .join('; ');
    const duplicates = id.duplicatesTotal === null ? '[n]' : String(id.duplicatesTotal);
    const dupNoun = id.duplicatesTotal === 1 ? 'duplicate' : 'duplicates';
    const excluded = id.screened - sought;

    let text =
        `The searches identified ${id.identifiedTotal} ${plural(id.identifiedTotal, 'record')} (${perFile}). ` +
        `After removal of ${duplicates} ${dupNoun}, ${id.screened} ${plural(id.screened, 'record')} ${wasWere(id.screened)} screened, ` +
        `${excluded} ${wasWere(excluded)} excluded, and ${sought} ${wasWere(sought)} retained for full-text review.`;

    if (stoppingExcluded > 0) {
        text += ` Of the ${excluded} excluded records, ${stoppingExcluded} were excluded without being screened by a reviewer when the ML stopping criterion was met.`;
    }

    if (!id.statsComplete) {
        text += '\n\n* Import statistics were not recorded for this file; the count shown is after deduplication.';
    }
    return text;
}

function buildFulltextMethods(input: ManuscriptInput, summary: FulltextResultsSummary, registryLinkage: FulltextResultsSummary): string {
    const humanJudges = summary.judges.filter(j => !j.startsWith('llm:'));
    const paragraphs: string[] = [];
    // 通常の人判定者数を示し、AI評価と人の裁定の関与は後続の文に記す。
    const reviewerClause = humanJudges.length > 0
        ? ` by ${humanJudges.length} ${plural(humanJudges.length, 'reviewer')}`
        : '';
    const retrievedIntro = summary.sought === 1
        ? 'The full text of the single candidate report was'
        : `Full texts of the ${summary.sought} candidate reports were`;
    paragraphs.push(
        `${retrievedIntro} retrieved and assessed for eligibility${reviewerClause} in TiAb Review (version ${extensionVersion(input)}), with reasons for exclusion recorded.`
    );

    const aiSentence = buildFulltextAiMethodsSentence(summary);
    if (aiSentence) {
        paragraphs.push(aiSentence);
    }

    paragraphs.push(
        `Disagreements between screeners (n = ${summary.conflict}) were resolved by [discussion / a third reviewer].`
    );

    // Registry linkage 由来（related_ref_id 非空）の行が1件以上あるときだけ、
    // other methods 腕の記述を追加する（Issue #120。0件なら現行の文面と完全に一致させる）。
    if (registryLinkage.sought > 0) {
        const retrievedIntroRl = registryLinkage.sought === 1
            ? 'The full text of the single additional report'
            : `Full texts of the ${registryLinkage.sought} additional reports`;
        paragraphs.push(
            `${retrievedIntroRl} identified through linkage to trial registrations (without title/abstract screening) ${wasWere(registryLinkage.sought)} retrieved and assessed for eligibility using the same criteria, and reported separately as an "other methods" identification route in the PRISMA 2020 flow diagram.`
        );
    }

    return paragraphs.join('\n\n');
}

/** Registry linkage（other methods 腕）の Results 文案（1件以上のときのみ呼ばれる） */
function buildRegistryLinkageResultsSentence(registryLinkage: FulltextResultsSummary, labelOf: (reason: string) => string): string {
    const reasonText = registryLinkage.reasons
        .map(r => `${labelOf(r.reason)} (n = ${r.count})`)
        .join('; ');
    const excludedPhrase =
        `${registryLinkage.exclude} ${plural(registryLinkage.exclude, 'report')} ${wasWere(registryLinkage.exclude)} excluded`;
    const excludedPart = registryLinkage.exclude > 0 && reasonText
        ? `${excludedPhrase}: ${reasonText}.`
        : `${excludedPhrase}.`;

    return (
        `Separately, ${registryLinkage.sought} additional ${plural(registryLinkage.sought, 'report')} identified through registry linkage ${wasWere(registryLinkage.sought)} sought for retrieval, of which ${registryLinkage.notRetrieved} could not be obtained ` +
        `and ${registryLinkage.obtained} ${wasWere(registryLinkage.obtained)} assessed for eligibility. ${excludedPart} ` +
        `In total, ${registryLinkage.include} ${plural(registryLinkage.include, 'study', 'studies')} ${wasWere(registryLinkage.include)} included in the review from this route.`
    );
}

function buildFulltextResults(summary: FulltextResultsSummary, registryLinkage: FulltextResultsSummary, labelOf: (reason: string) => string): string {
    const reasonText = summary.reasons
        .map(r => `${labelOf(r.reason)} (n = ${r.count})`)
        .join('; ');
    const excludedPhrase =
        `${summary.exclude} ${plural(summary.exclude, 'report')} ${wasWere(summary.exclude)} excluded`;
    const excludedPart = summary.exclude > 0 && reasonText
        ? `${excludedPhrase}: ${reasonText}.`
        : `${excludedPhrase}.`;

    let text = (
        `Of the ${summary.sought} ${plural(summary.sought, 'report')} sought for retrieval, ${summary.notRetrieved} could not be obtained ` +
        `and ${summary.obtained} ${wasWere(summary.obtained)} assessed for eligibility. ${excludedPart} ` +
        `In total, ${summary.include} ${plural(summary.include, 'study', 'studies')} ${wasWere(summary.include)} included in the review.`
    );

    // Registry linkage 由来の行が1件以上あるときだけ追記する（0件なら現行の文面と完全に一致）。
    if (registryLinkage.sought > 0) {
        text += `\n\n${buildRegistryLinkageResultsSentence(registryLinkage, labelOf)}`;
    }

    return text;
}

function buildPrismaBlock(
    phase: ManuscriptPhase,
    projectTitle: string,
    dateStr: string,
    id: IdentificationData,
    sought: number,
    summary: FulltextResultsSummary | null,
    registryLinkage: FulltextResultsSummary | null,
    labelOf: (reason: string) => string
): string {
    const lines: string[] = [];
    lines.push(`PRISMA 2020 flow — ${projectTitle} (generated ${dateStr})`);
    lines.push('');
    lines.push('Identification');
    lines.push(`  Records identified from databases (n = ${id.identifiedTotal})`);
    for (const f of id.files) {
        lines.push(`    ${f.file}: n = ${f.identified}${f.hasStats ? '' : ' *'}`);
    }
    lines.push(`  Records removed before screening (duplicates) (n = ${id.duplicatesTotal ?? '[n]'})`);
    lines.push('Screening');
    lines.push(`  Records screened (n = ${id.screened})`);
    lines.push(`  Records excluded (n = ${id.screened - sought})`);
    lines.push('Retrieval');
    lines.push(`  Reports sought for retrieval (n = ${sought})`);

    if (phase === 'fulltext' && summary) {
        lines.push(`  Reports not retrieved (n = ${summary.notRetrieved})`);
        lines.push('Eligibility');
        lines.push(`  Reports assessed for eligibility (n = ${summary.obtained})`);
        lines.push(`  Reports excluded (n = ${summary.exclude})${summary.reasons.length > 0 ? ':' : ''}`);
        for (const r of summary.reasons) {
            lines.push(`    ${labelOf(r.reason)} (n = ${r.count})`);
        }
        lines.push('Included');
        lines.push(`  Studies included in review (n = ${summary.include})`);
    }

    // other methods腕（Registry linkage）: registryLinkage が null または該当0件なら
    // buildOtherMethodsPrismaLines() が空配列を返すため、以下は現行の出力から1文字も変わらない。
    //
    // 脚注（* Import statistics …）より前に置くこと。脚注はブロック全体の末尾に来る注記なので、
    // その後ろに本文の節を足すと注記が文中に挟まって読めなくなる。
    const otherMethodsLines = buildOtherMethodsPrismaLines(registryLinkage, labelOf);
    if (otherMethodsLines.length > 0) {
        lines.push('');
        lines.push(...otherMethodsLines);
    }

    if (!id.statsComplete) {
        lines.push('');
        lines.push('* Import statistics were not recorded for this file; the count shown is after deduplication.');
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 論文用テキスト（Methods / Results / PRISMA）と警告を組み立てる。
 */
export function buildManuscriptOutput(input: ManuscriptInput): ManuscriptOutput {
    const id = computeIdentification(input.identificationRefs, input.importStats, {
        refsMayOmitLogicallyDeleted: input.refsMayOmitLogicallyDeleted,
    });
    const candidates = selectProjectFulltextCandidates(input.references, input.fulltextPoolRule, input.fulltextAssignment);
    // sought はデータベース腕の件数のみ（Issue #120: Registry linkage 由来の候補と合算しない）。
    // splitByIdentificationRoute() を使うことで tiab相・fulltext相のどちらでも同じ計算になる
    // （fulltext は tiab相で null になるため、そちらには依存しない）。0件のときは
    // database === candidates になるため、現行の出力から1文字も変わらない。
    const sought = splitByIdentificationRoute(candidates).database.length;
    // database腕とother methods腕（Registry linkage由来）を分けて集計する（Issue #120）。
    // tiab相ではフルテキスト評価自体が未実施のため、従来どおり null のままにする。
    const fulltext = input.phase === 'fulltext'
        ? getFulltextResultsSummaryByRoute(candidates, {
            enabledJudges: input.enabledJudges,
            excludeReasonItems: input.excludeReasonItems,
            userEmail: input.userEmail,
        })
        : null;
    const labelOf = (reason: string) => reasonLabelEn(reason, input.excludeReasonItems);
    const stoppingRuleExclusions = countStoppingRuleExclusions(input, candidates);

    const methods = fulltext
        ? buildFulltextMethods(input, fulltext.database, fulltext.registryLinkage)
        : buildTiabMethods(input, id, stoppingRuleExclusions);
    const results = fulltext
        ? buildFulltextResults(fulltext.database, fulltext.registryLinkage, labelOf)
        : buildTiabResults(id, sought, stoppingRuleExclusions);
    const prisma = buildPrismaBlock(
        input.phase, input.projectTitle, input.generatedDate, id, sought,
        fulltext ? fulltext.database : null, fulltext ? fulltext.registryLinkage : null, labelOf
    );

    // 警告（数値が最終値でない可能性の明示）
    const warnings: ManuscriptWarning[] = [];
    if (input.phase === 'tiab') {
        const unscreened = countUnscreenedTiab(input.references);
        if (unscreened > 0) warnings.push({ key: 'manuscript_warnUnscreened', args: [String(unscreened)] });
    } else if (fulltext) {
        // database腕とother methods腕（Registry linkage由来）の未決着を合算して警告する（Issue #120）。
        // database腕だけを見ると、registry腕側に未決着が残っていても「数値は最終値」と
        // 誤読されてしまう。registry行0件のときは全て0が足されるだけなので、
        // 現行の判定・表示から1文字も変わらない。
        const pending = fulltext.database.pending + fulltext.registryLinkage.pending;
        const maybe = fulltext.database.maybe + fulltext.registryLinkage.maybe;
        const unresolved = fulltext.database.unresolved + fulltext.registryLinkage.unresolved;
        if (pending > 0 || maybe > 0 || unresolved > 0) {
            warnings.push({
                key: 'manuscript_warnUnresolved',
                args: [String(pending), String(maybe), String(unresolved)],
            });
        }
    }
    if (!id.statsComplete) warnings.push({ key: 'manuscript_warnNoStats' });
    if (!input.isKeyOpened) warnings.push({ key: 'manuscript_warnBlind' });

    return {
        methods, results, prisma, warnings,
        identification: id,
        sought,
        fulltext,
        stoppingRuleExclusions,
        tiabHumanReviewers: countTiabHumanReviewers(input.references),
    };
}
