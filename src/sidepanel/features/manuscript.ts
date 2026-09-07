/**
 * 論文用テキスト（Methods / Results / PRISMA 2020 フロー数値）の自動生成
 *
 * TiAb エクスポートメニューとフルテキスト結果ビューから呼び出し、
 * 現在のプロジェクトデータから英語の下書きを生成してモーダルで表示する。
 * 各セクションはボタンでクリップボードへコピーできる。
 *
 * 生成ルール:
 *  - 数値・モデル名などは state から自動挿入する
 *  - ツールが持たない情報（不一致の解消方法など）は [ ] で残し、手入力を促す
 *  - 識別件数・重複除去数は Config シートの import_stats（インポート時に記録）を使い、
 *    統計がないファイルは重複除去後の件数に * を付けて明示する
 */

import { state } from '../state';
import { t } from '../../lib/i18n';
import { showModal, hideModal } from '../ui/modal';
import { showToast } from '../ui/feedback';
import { getProjectFulltextCandidateList } from './screening/filters';
import { getFulltextResultsSummaryByRoute } from './fulltext-results';
import type { FulltextResultsSummary } from './fulltext-results';
import { buildOtherMethodsPrismaLines, splitByIdentificationRoute } from '../../lib/identification-route';
import { isTiabDecision } from '../../lib/fulltext-pool';
import { isMlDecision, isLlmDecision, getClientVersion } from '../../lib/client-version';
import { isCmhStoppingRule } from '../../lib/ml/types';
import { getSpreadsheetInfo, getReferences } from '../../lib/sheets-api';
import { computeIdentification } from '../../lib/prisma-identification';
import type { IdentificationData } from '../../lib/prisma-identification';
import type { Decision, ReferenceWithStatus } from '../../lib/types';
import { excludeReasonLabelEn, EXCLUDE_REASON_LABELS_EN } from '../../lib/exclude-reasons';

export type ManuscriptPhase = 'tiab' | 'fulltext';

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
function reasonLabelEn(reason: string): string {
    if (!reason) return 'Reason not recorded';
    const items = state.excludeReasonItems;
    if (items.some(i => i.key === reason)) {
        return excludeReasonLabelEn(reason, items);
    }
    return EXCLUDE_REASON_LABELS_EN[reason as keyof typeof EXCLUDE_REASON_LABELS_EN] ?? reason;
}

/** 文献の全判定を集める（allDecisions + myDecision、重複排除） */
function collectRefDecisions(r: ReferenceWithStatus): Decision[] {
    const list: Decision[] = [...(r.allDecisions ?? [])];
    if (r.myDecision && !list.some(d => d.decision_id === r.myDecision!.decision_id)) {
        list.push(r.myDecision);
    }
    return list;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/**
 * Identification 相の数値（import_stats + シート上の件数）。
 *
 * 集計の核は src/lib/prisma-identification.ts の computeIdentification()（純関数、
 * state 非依存）へ切り出した。ここでは state から引数を組み立てるだけの薄い層にする。
 *
 * allReferences は state.allReferences ではなく、呼び出し元（showManuscriptModal）が
 * getReferences() で取り直した「論理削除された行も含む全件」を渡すこと。
 * selectReferencesWithStatus() 経由の state.allReferences は論理削除された行（重複）が
 * 除外済みのため、そのまま渡すと論理削除件数を集計できない（Issue #145 チャンク2）。
 *
 * refsMayOmitLogicallyDeleted は、getReferences() の取得に失敗して state.allReferences へ
 * フォールバックしたときに true を渡す。computeIdentification() 側で duplicatesTotal を
 * null に強制し、数字が黙って過少になることを防ぐ（詳細は computeIdentification() の JSDoc）。
 */
function collectIdentification(
    allReferences: Pick<ReferenceWithStatus, 'source_file' | 'related_ref_id' | 'duplicate_of'>[],
    refsMayOmitLogicallyDeleted: boolean
): IdentificationData {
    return computeIdentification(allReferences, state.importStats, { refsMayOmitLogicallyDeleted });
}

/** TiAb 相にヒト判定を出したレビュアー数（LLM/ML自動を除く。最低1） */
function countTiabHumanReviewers(): number {
    const reviewers = new Set<string>();
    for (const r of state.allReferences) {
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

/** reviewer_id `llm:{model}@{timestamp}` からモデル名を抽出 */
function llmModelFromReviewerId(reviewerId: string): string {
    const body = reviewerId.slice('llm:'.length);
    const at = body.lastIndexOf('@');
    return at > 0 ? body.slice(0, at) : body;
}

/** TiAb 相で使われた LLM モデル名（重複除去） */
function collectTiabLlmModels(): string[] {
    const models = new Set<string>();
    for (const r of state.allReferences) {
        for (const d of collectRefDecisions(r)) {
            if (!isTiabDecision(d)) continue;
            const id = (d.reviewer_id || '').trim();
            if (id.startsWith('llm:')) models.add(llmModelFromReviewerId(id));
        }
    }
    return [...models].sort();
}

/** TiAb 相で ML 判定（確定/自動）が使われたか */
function wasMlUsedInTiab(): boolean {
    for (const r of state.allReferences) {
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
 * database === state.allReferences になるため、現行の出力から1文字も変わらない。
 */
function countUnscreenedTiab(): number {
    let count = 0;
    const { database } = splitByIdentificationRoute(state.allReferences);
    for (const r of database) {
        const hasJudged = collectRefDecisions(r).some(
            d => isTiabDecision(d) && d.decision !== 'pending'
        );
        if (!hasJudged) count++;
    }
    return count;
}

// ---------------------------------------------------------------------------
// テキスト生成（英語固定）
// ---------------------------------------------------------------------------

function extensionVersion(): string {
    const v = getClientVersion();
    return v === 'unknown' ? '[version]' : v;
}

/** 英語の単数/複数形（不規則形は pluralForm で指定） */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
    return n === 1 ? singular : pluralForm;
}

function wasWere(n: number): string {
    return n === 1 ? 'was' : 'were';
}

function buildTiabMethods(id: IdentificationData): string {
    const fileList = id.files.map(f => f.file).join('; ');
    const nReviewers = countTiabHumanReviewers();

    const paragraphs: string[] = [];
    // レビュアー1名のときは blinded 節が意味を成さないので省く
    const blindClause = nReviewers > 1 ? ", blinded to each other's decisions" : '';
    paragraphs.push(
        `Records exported from each database (${fileList}) were imported into TiAb Review (version ${extensionVersion()}) and deduplicated automatically. ` +
        `Titles and abstracts were screened against the predefined eligibility criteria by ${nReviewers} ${plural(nReviewers, 'reviewer')}${blindClause}.`
    );

    if (wasMlUsedInTiab()) {
        let sentence = 'Records were prioritized for screening by an active-learning model.';
        const rule = state.mlState.stoppingRule;
        if (rule && isCmhStoppingRule(rule)) {
            sentence += ` Screening was stopped when the Callaghan–Müller-Hansen statistical stopping criterion indicated that a recall of ${rule.targetRecall} had been reached with ${Math.round(rule.confidence * 100)}% confidence.`;
        } else if (rule) {
            sentence += ` Screening was stopped after ${rule.threshold} consecutive excluded records.`;
        }
        paragraphs.push(sentence);
    }

    const llmModels = collectTiabLlmModels();
    if (llmModels.length > 0) {
        const cfg = state.llmConfig;
        paragraphs.push(
            `A large language model (${llmModels.join(', ')}; temperature = ${cfg.llm_temperature}) screened all records against the same eligibility criteria as an additional independent screener (inclusion threshold ${cfg.llm_include_threshold}).`
        );
    }

    const rule = state.fulltextPoolRule;
    const threshold = rule ? rule.threshold : 1;
    paragraphs.push(
        `Records judged include at the title/abstract stage by at least ${threshold} of the selected screeners proceeded to full-text review. ` +
        `Disagreements were resolved by [discussion / a third reviewer].`
    );

    return paragraphs.join('\n\n');
}

function buildTiabResults(id: IdentificationData, sought: number): string {
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

    if (!id.statsComplete) {
        text += '\n\n* Import statistics were not recorded for this file; the count shown is after deduplication.';
    }
    return text;
}

function buildFulltextMethods(summary: FulltextResultsSummary, registryLinkage: FulltextResultsSummary): string {
    const humanJudges = summary.judges.filter(j => !j.startsWith('llm:'));
    const aiModels = [...new Set(
        summary.judges.filter(j => j.startsWith('llm:')).map(llmModelFromReviewerId)
    )].sort();

    const paragraphs: string[] = [];
    // ヒト判定者が0（AI判定のみ採用）の場合はレビュアー数の記述を省く
    const reviewerClause = humanJudges.length > 0
        ? ` by ${humanJudges.length} ${plural(humanJudges.length, 'reviewer')}`
        : '';
    const retrievedIntro = summary.sought === 1
        ? 'The full text of the single candidate report was'
        : `Full texts of the ${summary.sought} candidate reports were`;
    paragraphs.push(
        `${retrievedIntro} retrieved and assessed for eligibility${reviewerClause} in TiAb Review (version ${extensionVersion()}), with reasons for exclusion recorded.`
    );

    if (aiModels.length > 0) {
        paragraphs.push(
            `Retrieved PDFs were additionally assessed by ${aiModels.join(', ')} as an independent screener.`
        );
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
function buildRegistryLinkageResultsSentence(registryLinkage: FulltextResultsSummary): string {
    const reasonText = registryLinkage.reasons
        .map(r => `${reasonLabelEn(r.reason)} (n = ${r.count})`)
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

function buildFulltextResults(summary: FulltextResultsSummary, registryLinkage: FulltextResultsSummary): string {
    const reasonText = summary.reasons
        .map(r => `${reasonLabelEn(r.reason)} (n = ${r.count})`)
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
        text += `\n\n${buildRegistryLinkageResultsSentence(registryLinkage)}`;
    }

    return text;
}

function buildPrismaBlock(
    phase: ManuscriptPhase,
    projectTitle: string,
    id: IdentificationData,
    sought: number,
    summary: FulltextResultsSummary | null,
    registryLinkage: FulltextResultsSummary | null
): string {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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
            lines.push(`    ${reasonLabelEn(r.reason)} (n = ${r.count})`);
        }
        lines.push('Included');
        lines.push(`  Studies included in review (n = ${summary.include})`);
    }

    // other methods腕（Registry linkage）: registryLinkage が null または該当0件なら
    // buildOtherMethodsPrismaLines() が空配列を返すため、以下は現行の出力から1文字も変わらない。
    //
    // 脚注（* Import statistics …）より前に置くこと。脚注はブロック全体の末尾に来る注記なので、
    // その後ろに本文の節を足すと注記が文中に挟まって読めなくなる。
    const otherMethodsLines = buildOtherMethodsPrismaLines(registryLinkage, reasonLabelEn);
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
// モーダル表示
// ---------------------------------------------------------------------------

function buildSectionElement(label: string, text: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'manuscript-section';

    const head = document.createElement('div');
    head.className = 'manuscript-section-head';

    const title = document.createElement('span');
    title.className = 'manuscript-section-title';
    title.textContent = label;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-small btn-secondary';
    copyBtn.textContent = t('manuscript_copy');
    copyBtn.addEventListener('click', () => {
        void (async () => {
            try {
                await navigator.clipboard.writeText(text);
                showToast(t('manuscript_copied'), 2000);
            } catch (error) {
                console.error('[manuscript] clipboard write failed:', error);
                showToast(t('manuscript_copyFailed'), 3000);
            }
        })();
    });

    head.appendChild(title);
    head.appendChild(copyBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'manuscript-textarea';
    textarea.readOnly = true;
    textarea.value = text;
    const lineCount = text.split('\n').length;
    textarea.rows = Math.min(Math.max(lineCount + 1, 4), 14);

    section.appendChild(head);
    section.appendChild(textarea);
    return section;
}

/**
 * 論文用テキストのモーダルを表示する
 * @param phase 'tiab' = TiAb相まで / 'fulltext' = フルテキスト相を含む全体
 */
export async function showManuscriptModal(phase: ManuscriptPhase): Promise<void> {
    // プロジェクト名（PRISMAブロックの見出し用。取得失敗時はフォールバック）
    let projectTitle = 'TiAb Review project';
    try {
        projectTitle = (await getSpreadsheetInfo(state.spreadsheetId)).title;
    } catch {
        console.log('[manuscript] Could not get spreadsheet title');
    }

    // Identification 集計は論理削除された行（重複、duplicate_of 非空）も含めた全件が必要
    // （Issue #145 チャンク2。除外件数を duplicatesTotal へ合算するため）。state.allReferences は
    // selectReferencesWithStatus() 経由で論理削除済みの行が既に取り除かれているため使えず、
    // ここで getReferences() を呼んで全件を取り直す。取得に失敗した場合は state.allReferences へ
    // フォールバックするが、その場合は論理削除件数を数えられない（黙って過少になる）ため、
    // refsMayOmitLogicallyDeleted=true を collectIdentification() へ渡し、duplicatesTotal を
    // 明示的に「合計不明」にする（数字が断りなく狂うことを防ぐ）。
    let allReferencesForIdentification: Pick<ReferenceWithStatus, 'source_file' | 'related_ref_id' | 'duplicate_of'>[] = state.allReferences;
    let refsMayOmitLogicallyDeleted = false;
    try {
        allReferencesForIdentification = await getReferences(state.spreadsheetId);
    } catch {
        console.log('[manuscript] Could not get full references (including logically-deleted); falling back to state.allReferences');
        refsMayOmitLogicallyDeleted = true;
    }

    const id = collectIdentification(allReferencesForIdentification, refsMayOmitLogicallyDeleted);
    // sought はデータベース腕の件数のみ（Issue #120: Registry linkage 由来の候補と合算しない）。
    // splitByIdentificationRoute() を使うことで tiab相・fulltext相のどちらでも同じ計算になる
    // （summaryByRoute は tiab相で null になるため、そちらには依存しない）。0件のときは
    // database === getProjectFulltextCandidateList() になるため、現行の出力から1文字も変わらない。
    const sought = splitByIdentificationRoute(getProjectFulltextCandidateList()).database.length;
    // database腕とother methods腕（Registry linkage由来）を分けて集計する（Issue #120）。
    // tiab相ではフルテキスト評価自体が未実施のため、従来どおり summary は null のままにする。
    const summaryByRoute = phase === 'fulltext' ? getFulltextResultsSummaryByRoute() : null;
    const summary = summaryByRoute ? summaryByRoute.database : null;
    const registryLinkage = summaryByRoute ? summaryByRoute.registryLinkage : null;

    const methods = summaryByRoute
        ? buildFulltextMethods(summaryByRoute.database, summaryByRoute.registryLinkage)
        : buildTiabMethods(id);
    const results = summaryByRoute
        ? buildFulltextResults(summaryByRoute.database, summaryByRoute.registryLinkage)
        : buildTiabResults(id, sought);
    const prisma = buildPrismaBlock(phase, projectTitle, id, sought, summary, registryLinkage);

    // 警告（数値が最終値でない可能性の明示）
    const warnings: string[] = [];
    if (phase === 'tiab') {
        const unscreened = countUnscreenedTiab();
        if (unscreened > 0) warnings.push(t('manuscript_warnUnscreened', String(unscreened)));
    } else if (summary) {
        // database腕とother methods腕（Registry linkage由来）の未決着を合算して警告する（Issue #120）。
        // summary はここで database腕だけの集計になっているため、registry腕側に未決着が
        // 残っていても片方だけを見ると「数値は最終値」と誤読されてしまう。registryLinkage が
        // null（tiab相）またはregistry行0件のときは全て0が足されるだけなので、現行の判定・
        // 表示から1文字も変わらない。
        const pending = summary.pending + (registryLinkage?.pending ?? 0);
        const maybe = summary.maybe + (registryLinkage?.maybe ?? 0);
        const unresolved = summary.unresolved + (registryLinkage?.unresolved ?? 0);
        if (pending > 0 || maybe > 0 || unresolved > 0) {
            warnings.push(t('manuscript_warnUnresolved', [
                String(pending), String(maybe), String(unresolved),
            ]));
        }
    }
    if (!id.statsComplete) warnings.push(t('manuscript_warnNoStats'));
    if (!state.isKeyOpened) warnings.push(t('manuscript_warnBlind'));

    const body = document.createElement('div');
    body.className = 'manuscript-modal';

    const disclaimer = document.createElement('div');
    disclaimer.className = 'manuscript-note';
    disclaimer.textContent = t('manuscript_disclaimer');
    body.appendChild(disclaimer);

    for (const warning of warnings) {
        const el = document.createElement('div');
        el.className = 'manuscript-warning';
        el.textContent = `⚠ ${warning}`;
        body.appendChild(el);
    }

    body.appendChild(buildSectionElement('Methods', methods));
    body.appendChild(buildSectionElement('Results', results));
    body.appendChild(buildSectionElement(t('manuscript_sectionPrisma'), prisma));

    const footer = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = t('manuscript_close');
    closeBtn.addEventListener('click', () => hideModal());
    footer.appendChild(closeBtn);

    showModal({
        title: t('manuscript_modalTitle'),
        body,
        footer,
    });
}
