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
import { getFulltextResultsSummary } from './fulltext-results';
import type { FulltextResultsSummary } from './fulltext-results';
import { isTiabDecision } from '../../lib/fulltext-pool';
import { isMlDecision, isLlmDecision, getClientVersion } from '../../lib/client-version';
import { isCmhStoppingRule } from '../../lib/ml/types';
import { getSpreadsheetInfo } from '../../lib/sheets-api';
import type { Decision, ReferenceWithStatus } from '../../lib/types';
import { EXCLUDE_REASON_LABELS_EN } from '../../lib/exclude-reasons';
import type { ExcludeReason } from '../../lib/exclude-reasons';

export type ManuscriptPhase = 'tiab' | 'fulltext';

function reasonLabelEn(reason: string): string {
    if (!reason) return 'Reason not recorded';
    return EXCLUDE_REASON_LABELS_EN[reason as ExcludeReason] ?? reason;
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

interface IdentificationData {
    files: Array<{ file: string; identified: number; hasStats: boolean }>;
    identifiedTotal: number;
    duplicatesTotal: number | null;  // null = 統計未記録のファイルがあり合計不明
    screened: number;                // 重複除去後（シート上のユニーク文献数）
    statsComplete: boolean;
}

/** Identification 相の数値（import_stats + シート上の件数） */
function collectIdentification(): IdentificationData {
    const refs = state.allReferences;
    const perFile = new Map<string, number>();
    for (const r of refs) {
        const file = r.source_file || '(unknown source)';
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }

    const stats = state.importStats;
    let identifiedTotal = 0;
    let duplicatesTotal = 0;
    let statsComplete = true;

    const files = [...perFile.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([file, inSheet]) => {
            const s = stats[file];
            if (s) {
                identifiedTotal += s.identified;
                duplicatesTotal += s.duplicates;
                return { file, identified: s.identified, hasStats: true };
            }
            // 統計なし: 重複除去後の件数で代用（* 付きで明示）
            statsComplete = false;
            identifiedTotal += inSheet;
            return { file, identified: inSheet, hasStats: false };
        });

    return {
        files,
        identifiedTotal,
        duplicatesTotal: statsComplete ? duplicatesTotal : null,
        screened: refs.length,
        statsComplete,
    };
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

/** TiAb 未判定（誰の非 pending 判定も無い）の文献数 */
function countUnscreenedTiab(): number {
    let count = 0;
    for (const r of state.allReferences) {
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

function buildFulltextMethods(summary: FulltextResultsSummary): string {
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

    return paragraphs.join('\n\n');
}

function buildFulltextResults(summary: FulltextResultsSummary): string {
    const reasonText = summary.reasons
        .map(r => `${reasonLabelEn(r.reason)} (n = ${r.count})`)
        .join('; ');
    const excludedPhrase =
        `${summary.exclude} ${plural(summary.exclude, 'report')} ${wasWere(summary.exclude)} excluded`;
    const excludedPart = summary.exclude > 0 && reasonText
        ? `${excludedPhrase}: ${reasonText}.`
        : `${excludedPhrase}.`;

    return (
        `Of the ${summary.sought} ${plural(summary.sought, 'report')} sought for retrieval, ${summary.notRetrieved} could not be obtained ` +
        `and ${summary.obtained} ${wasWere(summary.obtained)} assessed for eligibility. ${excludedPart} ` +
        `In total, ${summary.include} ${plural(summary.include, 'study', 'studies')} ${wasWere(summary.include)} included in the review.`
    );
}

function buildPrismaBlock(
    phase: ManuscriptPhase,
    projectTitle: string,
    id: IdentificationData,
    sought: number,
    summary: FulltextResultsSummary | null
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

    const id = collectIdentification();
    const sought = getProjectFulltextCandidateList().length;
    const summary = phase === 'fulltext' ? getFulltextResultsSummary() : null;

    const methods = phase === 'fulltext' && summary
        ? buildFulltextMethods(summary)
        : buildTiabMethods(id);
    const results = phase === 'fulltext' && summary
        ? buildFulltextResults(summary)
        : buildTiabResults(id, sought);
    const prisma = buildPrismaBlock(phase, projectTitle, id, sought, summary);

    // 警告（数値が最終値でない可能性の明示）
    const warnings: string[] = [];
    if (phase === 'tiab') {
        const unscreened = countUnscreenedTiab();
        if (unscreened > 0) warnings.push(t('manuscript_warnUnscreened', String(unscreened)));
    } else if (summary && (summary.pending > 0 || summary.maybe > 0 || summary.conflict > 0)) {
        warnings.push(t('manuscript_warnUnresolved', [
            String(summary.pending), String(summary.maybe), String(summary.conflict),
        ]));
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
