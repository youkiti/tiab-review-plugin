/**
 * フルテキストタブ
 * 候補プール（共通ルール準拠）に対して以下を提供する:
 *  - 候補ルールのインライン編集（fulltext-rule-editor 共通コンポーネント）
 *  - 全文の入手状況サマリと一括OA検索（PDFはDriveに保存）
 *  - 文献ごとの単発取得・PDF手動アップロード・DOI/PubMedへの導線
 *  - 各文献のフルテキストページ（新規タブ）への導線
 */

import { dom } from './dom';
import { dom as sharedDom } from '../../dom';
import { state } from '../../state';
import { t } from '../../../lib/i18n';
import { escapeHtml } from '../../utils/text';
import { getFulltextCandidateList, getVisibleFulltextCandidateList } from '../screening/filters';
import { handleKeyToggle } from '../screening/actions';
import { explainEmptyFulltextCandidates } from '../../../lib/fulltext-empty-reason';
import { setupFulltextResultsListeners, renderFulltextResults, setFulltextResultsDeps } from './results';
import { setupFulltextAiListeners } from './ai';
import {
    renderFulltextAssignmentRow,
    setupFulltextAssignmentListeners,
    setFulltextAssignmentDeps,
} from './assignment-ui';
import { renderTeamProgress } from '../team-progress';
import { mountRuleEditor } from '../../../lib/fulltext-rule-editor';
import { mountReasonEditor } from './reason-editor';
import { retrieveAndCacheFulltext } from '../../../lib/fulltext-retriever';
import type { FulltextFetchOutcome } from '../../../lib/fulltext-retriever';
import {
    ensureFulltextFolder,
    uploadPdfToDrive,
    buildPdfFileName,
    describeDriveAccessError,
} from '../../../lib/drive-api';
import {
    saveFulltextPoolRule,
    updateReferenceFulltextUrl,
    updateReferenceFulltextUrls,
    savePublicationCandidates,
    getPublicationCandidates,
} from '../../../lib/sheets-api';
import {
    isRegistrationRecord,
    extractTrialId,
    parseRegistryFieldsFromAbstract,
    extractSecondaryTrialIds,
} from '../../../lib/registry-record';
import { discoverPublicationCandidates } from '../../../lib/publication-suggest';
import type { PublicationCandidateDraft } from '../../../lib/publication-suggest';
import { fetchCtgStudy } from '../../../lib/registry-api';
import {
    discoverCandidatesForRerun,
    flushCandidateBuffer,
    nextCandidateFlushThreshold,
} from '../../../lib/publication-candidate-rerun';
import { createPublicationCandidatesLoader } from './candidates-loader';
import {
    selectSuggestedPublicationCandidates,
    countSuggestedPublicationCandidatesByRef,
} from '../../../lib/publication-candidate-panel';
import { buildDoiUrl, buildPubmedUrl } from '../../../lib/external-record-url';
import {
    decoratePublicationCandidateCard,
    setPublicationCandidatesDeps,
} from './publication-candidates';
import {
    setFulltextDriveImportDeps,
    setupFulltextDriveImportListeners,
} from './drive-import';
import { setupFulltextRegrantListeners } from './regrant';
import { renderFulltextChecklist, setupFulltextChecklistListeners } from './checklist';
import { setFulltextPoolRule as syncSetFulltextPoolRule, changeTab } from '../../store/compat';
import { hideToast, showToast } from '../../ui/feedback';
import type { ReferenceWithStatus, Decision, FulltextStatus, PublicationCandidate } from '../../../lib/types';

// features/fulltext/lazy.ts が本体ロード後に委譲する（manuscript.ts の論文用テキスト生成が
// 結果ビューの判定者選択を読むため。詳細は results.ts の getEnabledJudgesSnapshot() 参照）。
export { getEnabledJudgesSnapshot } from './results';

const STATUS_META: Record<string, { icon: string; cls: string }> = {
    include: { icon: '✓', cls: 'include' },
    exclude: { icon: '✕', cls: 'exclude' },
    maybe: { icon: '?', cls: 'maybe' },
    pending: { icon: '・', cls: 'pending' },
};

type ViewFilter = 'all' | 'missing' | 'obtained' | 'undecided';

// タブ内のローカルUI状態
let viewFilter: ViewFilter = 'all';
let bulkRun: { cancelled: boolean } | null = null;
let uploadTargetRefId: string | null = null;

// 論文候補（Publication_Candidates）のモジュールローカルキャッシュ（Issue #118 チャンク3b）。
// このタブ限定の関心事のため state には足さない。renderFulltextTab() は同期関数なので、
// 読み込みは非同期の別ルーチン（loadPublicationCandidates）にし、完了後に renderFulltextTab()
// を呼び直して反映する。
let publicationCandidates: PublicationCandidate[] = [];

/**
 * Sheets からの実読み込み本体（registration行が1件以上ある場合のみ呼ばれる）を
 * candidates-loader.ts の createPublicationCandidatesLoader() へ配線したもの。
 *
 * 【なぜ真偽値フラグの二重起動防止ではだめか、なぜプロジェクト単位で合流を分けるか、
 * stale のとき何が起きるか】は candidates-loader.ts の createPublicationCandidatesLoader()
 * の JSDoc を参照（DOM・state に依存しない形へ切り出し、node のテストから直接検証している）。
 * トースト表示はここでは行わない（呼び出し元の loadPublicationCandidates() が
 * suppressErrorToast の値に応じて出す）。合流した複数の呼び出し元は同じ boolean 結果を
 * 共有するが、それぞれ自分の suppressErrorToast で独立にトースト要否を判断するため、
 * 「合流していてもトースト表示は呼び出し元ごとに変わりうる」（詳細は loadPublicationCandidates
 * 側のコメント参照）。
 */
const loadCandidatesForProject = createPublicationCandidatesLoader({
    fetchCandidates: getPublicationCandidates,
    getCurrentSpreadsheetId: () => state.spreadsheetId,
    applyCandidates: candidates => { publicationCandidates = candidates; },
    render: () => renderFulltextTab(),
});

/**
 * 論文候補（Publication_Candidates）を読み込み、モジュールローカルキャッシュへ保持する。
 *
 * 【早期returnの判定基準は「プロジェクト全体」であって「表示中」ではない】
 * `state.allReferences`（担当フィルタ・セット絞り込みの影響を受けない全件）に registration行が
 * 1件でもあるかで判定する。以前は `getVisibleFulltextCandidateList().some(isRegistrationRecord)`
 * を使っていたが、これは担当フィルタ＋セットのチェックボックス絞り込みが効いた「表示中」の一覧
 * だった（PR #124 レビュー指摘）。セットのチェックボックスハンドラ（fulltext/assignment-ui.ts）は
 * `_rerenderTab()` を呼ぶだけで再読込しないため、registration行を含まないグループに絞った状態で
 * タブを開くと `hasRegistrationRows` が false になって候補が空になり、その後チェックを広げても
 * 再読込がかからないため候補が戻らない不具合を実際に踏んだ。`state.allReferences` を使えば
 * セットの絞り込みに関わらず「このプロジェクトに registration行が1件でもあるか」を正しく判定できる。
 * `renderRetrievalSummary()` が同じ `isRegistrationRecord` 判定を使っているのは表示中候補数の
 * 集計目的であり、こちらとは目的が異なるため合わせていない。
 *
 * この早期returnパスは Sheets API を一切呼ばず await を挟まないため、実行中に他の呼び出しが
 * 割り込む余地が構造的に無い（JSはシングルスレッドで、await の無い同期区間は割り込まれない）。
 * よって loadCandidatesForProject() の合流対象に含める必要はない
 * （合流が必要なのは Sheets への実読み込みが進行中の間に他の呼び出しが来るケースだけ）。
 * この経路は「読み込む必要が無かった」だけで失敗ではないため true を返す。
 *
 * @param options.suppressErrorToast 既定 false。true なら Sheets 読み込み失敗時の
 *   `fulltext_candidateLoadError` トーストを出さない（handleDismissCandidate() が
 *   自前の pubCandidate_dismissReloadFailed トーストへまとめて出すために使う）。
 * @returns 成功（または読み込み不要で早期return）したら true、Sheets読み込みが失敗したら false。
 *   fire-and-forget（`void loadPublicationCandidates()`）の呼び出し元は戻り値を無視してよい
 *   （throw しないため unhandled rejection は起きない）。
 *
 * 呼び出しタイミング: initializeFulltextSection()、および handleBulkFetch / handleBulkSuggest /
 * fetchSingleFulltextForRef（単発OA検索。ボタン起点の handleSingleFetch と、候補取り込み後の
 * 自動起動の両方で共有）の完了後。
 */
async function loadPublicationCandidates(
    options: { suppressErrorToast?: boolean } = {}
): Promise<boolean> {
    const suppressErrorToast = options.suppressErrorToast ?? false;
    const hasRegistrationRows = state.allReferences.some(isRegistrationRecord);
    if (!hasRegistrationRows) {
        publicationCandidates = [];
        renderFulltextTab();
        return true;
    }

    const ok = await loadCandidatesForProject(state.spreadsheetId);
    if (!ok && !suppressErrorToast) {
        showToast(t('fulltext_candidateLoadError'), 5000);
    }
    return ok;
}

/**
 * フルテキストタブ本体の初期化（タブ切替後に呼ぶ）
 *
 * タブへのStore切替（changeTab('fulltext')）と読み込み中表示は features/fulltext/lazy.ts が
 * 本体チャンクの読込前後で行う（llm/index.ts の initializeLlmSection(isCurrent) と同じ形）。
 * ここでは切替後の描画・候補読み込みのみを担う。isCurrent は、本体チャンクの読込中にタブを
 * 離れた／プロジェクトが切り替わった場合に初期化そのものを取りやめる入口ガード（既定は常に
 * trueを返す関数。lazy.ts を介さない直接呼び出し・テスト用）。
 *
 * この入口ガードを通過した後、loadPublicationCandidates() 以降の非同期応答は isCurrent の
 * 対象外だが、代わりに loadCandidatesForProject()（candidates-loader.ts）が
 * team-progress.ts の fetchDecisions() と同じ作法でプロジェクトの切替を検知する。取得完了時に
 * `state.spreadsheetId` が渡した spreadsheetId と一致しなければ旧プロジェクトの結果を
 * 破棄し、モジュールローカルの publicationCandidates を上書きしない・トーストも出さない
 * （Issue #188。詳細は createPublicationCandidatesLoader() の JSDoc参照）。
 */
export function initializeFulltextSection(isCurrent: () => boolean = () => true): void {
    if (!isCurrent()) return;
    renderFulltextTab();
    void loadPublicationCandidates();
}

function myFulltextStatus(ref: ReferenceWithStatus): string {
    const d = ref.myFulltextDecision;
    if (d && d.decision !== 'pending') return d.decision;
    return 'pending';
}

/** 入手状態（未記録は not_retrieved 扱い） */
function retrievalStatus(ref: ReferenceWithStatus): FulltextStatus {
    return ref.fulltext_status ?? 'not_retrieved';
}

function isObtained(ref: ReferenceWithStatus): boolean {
    const s = retrievalStatus(ref);
    return (s === 'cached' || s === 'retrieved') && !!ref.fulltext_url;
}

/**
 * 全文献の判定をフラットに集める（ルールエディタのvoter発見・プレビュー用）
 */
function collectAllDecisions(): Decision[] {
    const out: Decision[] = [];
    const seen = new Set<string>();
    for (const r of state.references) {
        const list = [...(r.allDecisions ?? [])];
        if (r.myDecision) list.push(r.myDecision);
        for (const d of list) {
            if (!seen.has(d.decision_id)) {
                seen.add(d.decision_id);
                out.push(d);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

/**
 * フルテキストタブの内容を描画
 */
export function renderFulltextTab(): void {
    const candidates = getVisibleFulltextCandidateList();

    renderRuleAndProgress(candidates);
    renderReasonRow();
    renderFulltextAssignmentRow();
    renderTeamProgress();
    renderFulltextChecklist(candidates);
    renderRetrievalSummary(candidates);
    renderViewFilter(candidates);
    renderList(candidates);
    // 結果モード表示中はサマリ・テーブルも最新化（モード外なら no-op）
    renderFulltextResults();
}

function renderRuleAndProgress(candidates: ReferenceWithStatus[]): void {
    const decided = candidates.filter(r => myFulltextStatus(r) !== 'pending').length;
    dom.fulltextProgressLine.textContent = t('fulltext_progressLine', [String(decided), String(candidates.length)]);

    const rule = state.fulltextPoolRule;
    dom.fulltextRuleLine.textContent = rule
        ? t('fulltext_ruleLine', [String(rule.threshold), String(rule.voters.length)])
        : t('fulltext_ruleUnset');
    dom.fulltextRuleLine.classList.toggle('rule-unset', !rule);
    dom.fulltextRuleEditBtn.textContent = rule ? t('fulltext_ruleEdit') : t('fulltext_ruleSet');
}

/**
 * 除外理由リストの1行サマリ（件数＋先頭いくつかのラベル）を描画する。
 * 既定（未設定）とカスタムを区別して出し、どの区分でスクリーニングしているかを一目で分かるようにする。
 */
function renderReasonRow(): void {
    const items = state.excludeReasonItems;
    const isCustom = state.excludeReasonConfig !== null;
    // 先頭3件だけ並べる（全部出すと1行に収まらない）
    const preview = items.slice(0, 3).map(i => i.label).join(' / ');
    const suffix = items.length > 3 ? ' …' : '';
    dom.fulltextReasonLine.textContent = isCustom
        ? t('ftReason_lineCustom', [String(items.length), preview + suffix])
        : t('ftReason_lineDefault', [String(items.length), preview + suffix]);
    dom.fulltextReasonEditBtn.textContent = state.isAdmin ? t('ftReason_edit') : t('ftReason_view');
}

function renderRetrievalSummary(candidates: ReferenceWithStatus[]): void {
    const total = candidates.length;
    const cached = candidates.filter(r => retrievalStatus(r) === 'cached').length;
    const linked = candidates.filter(r => retrievalStatus(r) === 'retrieved' && r.fulltext_url).length;
    const unavailable = candidates.filter(r => retrievalStatus(r) === 'unavailable').length;
    const missing = total - cached - linked - unavailable;
    const obtained = cached + linked;

    dom.fulltextObtainedLine.textContent = t('fulltext_obtainedLine', [String(obtained), String(total)]);
    dom.fulltextStatusBarFill.style.width = total > 0 ? `${Math.round((obtained / total) * 100)}%` : '0%';
    dom.fulltextStatusBreakdown.textContent = t('fulltext_statusBreakdown', [
        String(cached), String(linked), String(missing), String(unavailable),
    ]);

    const retry = dom.fulltextRetryCheckbox.checked;
    const targetCount = missing + (retry ? unavailable : 0);
    dom.fulltextFetchBtn.textContent = t('fulltext_fetchBtn', String(targetCount));
    dom.fulltextFetchBtn.disabled = targetCount === 0 || bulkRun !== null;
    dom.fulltextFetchCancelBtn.classList.toggle('hidden', bulkRun === null);

    // 論文候補の再探索ボタン: fulltext_status を一切見ず、registration行全部を対象数とする
    // （PR #122 レビュー指摘2。取得状態から独立して何度でも再実行できる導線）。registration行が無い
    // プロジェクトでは意味が無いため、件数0なら非表示にする。
    const registrationCount = candidates.filter(isRegistrationRecord).length;
    dom.fulltextSuggestBtn.classList.toggle('hidden', registrationCount === 0);
    dom.fulltextSuggestBtn.textContent = t('fulltext_suggestBtn', String(registrationCount));
    dom.fulltextSuggestBtn.disabled = bulkRun !== null;
}

function renderViewFilter(candidates: ReferenceWithStatus[]): void {
    const counts: Record<ViewFilter, number> = {
        all: candidates.length,
        missing: candidates.filter(r => !isObtained(r)).length,
        obtained: candidates.filter(isObtained).length,
        undecided: candidates.filter(r => myFulltextStatus(r) === 'pending').length,
    };
    const labels: Record<ViewFilter, string> = {
        all: t('fulltext_filterAll', String(counts.all)),
        missing: t('fulltext_filterMissing', String(counts.missing)),
        obtained: t('fulltext_filterObtained', String(counts.obtained)),
        undecided: t('fulltext_filterUndecided', String(counts.undecided)),
    };
    for (const option of Array.from(dom.fulltextViewFilter.options)) {
        option.textContent = labels[option.value as ViewFilter] ?? option.value;
    }
    dom.fulltextViewFilter.value = viewFilter;
}

function applyViewFilter(candidates: ReferenceWithStatus[]): ReferenceWithStatus[] {
    switch (viewFilter) {
        case 'missing': return candidates.filter(r => !isObtained(r));
        case 'obtained': return candidates.filter(isObtained);
        case 'undecided': return candidates.filter(r => myFulltextStatus(r) === 'pending');
        default: return candidates;
    }
}

function badgeFor(ref: ReferenceWithStatus): { cls: string; label: string } {
    switch (retrievalStatus(ref)) {
        case 'cached': return { cls: 'badge-cached', label: t('fulltext_badgeCached') };
        case 'retrieved':
            return ref.fulltext_url
                ? { cls: 'badge-linked', label: t('fulltext_badgeLinked') }
                : { cls: 'badge-missing', label: t('fulltext_badgeMissing') };
        case 'unavailable': return { cls: 'badge-unavailable', label: t('fulltext_badgeUnavailable') };
        default: return { cls: 'badge-missing', label: t('fulltext_badgeMissing') };
    }
}

/**
 * URL組み立てそのものは src/lib/external-record-url.ts の buildDoiUrl/buildPubmedUrl へ
 * 一般化した（Issue #118 チャンク3b。候補パネル側でも同じ形式のURLをPubMed/DOI別々に
 * 組み立てたいため、重複実装を避けた）。ここでの doi優先・1本のURLだけを返す挙動は変えていない。
 */
function recordPageUrl(ref: ReferenceWithStatus): string | null {
    if (ref.doi) return buildDoiUrl(ref.doi);
    if (ref.pmid) return buildPubmedUrl(ref.pmid);
    return null;
}

function renderList(candidates: ReferenceWithStatus[]): void {
    const listDiv = dom.fulltextListDiv;
    listDiv.innerHTML = '';

    const visible = applyViewFilter(candidates);

    if (visible.length === 0) {
        listDiv.appendChild(buildEmptyState());
        return;
    }

    // registration行ごとの論文候補バッジ件数を1パスでまとめて集計する
    // （カード1枚ごとに配列を毎回フィルタしない。Issue #118 チャンク3b）。
    const publicationCandidateCounts = countSuggestedPublicationCandidatesByRef(publicationCandidates);
    for (const ref of visible) {
        listDiv.appendChild(buildCard(ref, publicationCandidateCounts));
    }
}

/**
 * 候補0件時の空状態表示を構築する。
 * 表示切替（missing/obtained/undecided）で0件になった場合は候補自体は存在する
 * （explainEmptyFulltextCandidates は担当セットのチェックボックス絞り込みのみを見るため
 * reason が null になる）ので、「候補がまだ無い」ではなく表示条件の変更を促す。
 */
function buildEmptyState(): HTMLElement {
    const empty = document.createElement('div');
    empty.className = 'fulltext-empty';

    const assignedSetCount = state.allReferences.filter(r => (r.fulltext_set || '').trim() !== '').length;
    const visibleCandidateCount = getVisibleFulltextCandidateList().length;
    const reason = explainEmptyFulltextCandidates({
        poolRule: state.fulltextPoolRule,
        keyOpened: state.isKeyOpened,
        userEmail: state.userEmail,
        assignedSetCount,
        candidateCountBeforeSetFilter: getFulltextCandidateList().length,
        visibleCandidateCount,
    });

    switch (reason) {
        case 'rule_unevaluable_blind': {
            if (state.isAdmin) {
                const text = document.createElement('p');
                text.textContent = t('fulltext_emptyBlindUnevaluableAdmin');
                empty.appendChild(text);

                const btn = document.createElement('button');
                btn.className = 'fulltext-action-btn fulltext-action-btn--primary';
                btn.textContent = t('fulltext_emptyUnblockBtn');
                btn.addEventListener('click', () => {
                    sharedDom.keyToggleInput.checked = true;
                    void handleKeyToggle().then(() => {
                        dom.fulltextKeyToggle.checked = state.isKeyOpened;
                        renderFulltextTab();
                    });
                });
                empty.appendChild(btn);
            } else {
                empty.textContent = t('fulltext_emptyBlindUnevaluable');
            }
            break;
        }
        case 'assignment_mismatch':
            empty.textContent = t('fulltext_emptyAssignmentMismatch', String(assignedSetCount));
            break;
        case 'filtered_out':
            empty.textContent = t('fulltext_emptyFilteredOut');
            break;
        default:
            // reason=null かつ候補が存在する＝表示切替（未入手/入手済み/未判定）で0件になっただけ
            empty.textContent = visibleCandidateCount > 0
                ? t('fulltext_emptyViewFiltered')
                : t('fulltext_emptyList');
            break;
    }

    return empty;
}

function buildCard(ref: ReferenceWithStatus, publicationCandidateCounts: Map<string, number>): HTMLElement {
    const status = myFulltextStatus(ref);
    const meta = STATUS_META[status] ?? STATUS_META['pending'];
    const badge = badgeFor(ref);

    const card = document.createElement('div');
    card.className = `fulltext-card status-${meta.cls}`;
    card.title = t('fulltext_openTitle');

    const metaParts: string[] = [];
    if (ref.year) metaParts.push(String(ref.year));
    if (ref.journal) metaParts.push(ref.journal);

    card.innerHTML = `
        <span class="fulltext-card-status ${meta.cls}">${meta.icon}</span>
        <span class="fulltext-card-body">
            <span class="fulltext-card-title">${escapeHtml(ref.title || ref.ref_id)}</span>
            <span class="fulltext-card-meta">${escapeHtml(metaParts.join(' · '))}</span>
            <span class="fulltext-card-footer">
                <span class="fulltext-badge ${badge.cls}">${badge.label}</span>
            </span>
        </span>
        <span class="fulltext-card-open">↗</span>
    `;
    card.addEventListener('click', () => {
        const url = chrome.runtime.getURL('fulltext/fulltext.html') + `?ref_id=${encodeURIComponent(ref.ref_id)}`;
        chrome.tabs.create({ url });
    });

    // 状態に応じたアクションボタンを付ける
    const footer = card.querySelector('.fulltext-card-footer')!;
    const rStatus = retrievalStatus(ref);
    const recordUrl = recordPageUrl(ref);

    // ① 全文への直接導線を最優先で出す（リンクのみでも必ずワンクリックで開ける）
    if (rStatus === 'cached' && ref.fulltext_url) {
        const url = ref.fulltext_url;
        footer.appendChild(buildLinkBtn(
            t('fulltext_actionOpenPdf'), t('fulltext_actionOpenPdfTitle'), url
        ));
    } else if (rStatus === 'retrieved' && ref.fulltext_url) {
        const url = ref.fulltext_url;
        footer.appendChild(buildLinkBtn(
            t('fulltext_actionOpenLink'), t('fulltext_actionOpenLinkTitle'), url
        ));
    } else if (rStatus === 'not_retrieved') {
        footer.appendChild(buildActionBtn(
            t('fulltext_actionFetch'), t('fulltext_actionFetchTitle'),
            (btn) => void handleSingleFetch(ref, btn), true
        ));
    }

    // ② DOI/PubMed は Drive保存済み以外で常に出す（OAリンクが当てにならない時の保険）
    if (rStatus !== 'cached' && recordUrl) {
        footer.appendChild(buildLinkBtn(
            t('fulltext_actionDoi'), t('fulltext_actionDoiTitle'), recordUrl
        ));
    }

    // ③ 手元PDFでの差し替えは Drive保存済み以外で可能
    if (rStatus !== 'cached') {
        footer.appendChild(buildActionBtn(
            t('fulltext_actionUpload'), t('fulltext_actionUploadTitle'),
            () => handleUploadClick(ref)
        ));
    }

    // ④ registration行のみ: 論文候補バッジ＋パネル（Issue #118 チャンク3b）。
    // isRegistrationRecord() が false の行や候補0件の行はバッジを出さず、card をそのまま返す。
    if (isRegistrationRecord(ref)) {
        const count = publicationCandidateCounts.get(ref.ref_id) ?? 0;
        if (count > 0) {
            const candidatesForRef = selectSuggestedPublicationCandidates(publicationCandidates, ref.ref_id);
            return decoratePublicationCandidateCard(card, ref, candidatesForRef);
        }
    }

    return card;
}

/** URLを新規タブで開くだけのリンクボタン（全文・DOI/PubMed導線） */
function buildLinkBtn(label: string, title: string, url: string): HTMLButtonElement {
    return buildActionBtn(label, title, () => { chrome.tabs.create({ url }); }, true);
}

function buildActionBtn(
    label: string,
    title: string,
    onClick: (btn: HTMLButtonElement) => void,
    primary = false
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = primary ? 'fulltext-action-btn fulltext-action-btn--primary' : 'fulltext-action-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // カードクリック（ページを開く）を抑止
        onClick(btn);
    });
    return btn;
}

// ---------------------------------------------------------------------------
// 候補ルールエディタ
// ---------------------------------------------------------------------------

function toggleRuleEditor(): void {
    const div = dom.fulltextRuleEditorDiv;
    if (!div.classList.contains('hidden')) {
        div.classList.add('hidden');
        return;
    }
    div.classList.remove('hidden');
    openRuleEditor();
}

function openRuleEditor(): void {
    const div = dom.fulltextRuleEditorDiv;
    mountRuleEditor({
        container: div,
        references: state.references,
        decisions: collectAllDecisions(),
        currentRule: state.fulltextPoolRule,
        keyOpened: state.isKeyOpened,
        isAdmin: state.isAdmin,
        assignedCandidateCount: state.references.filter(r => (r.fulltext_set || '').trim() !== '').length,
        onOpenKey: async () => {
            // handleBlindToggle (fulltext/results.ts) と同じ委譲パターン:
            // handleKeyToggle は sharedDom.keyToggleInput.checked を正とする
            sharedDom.keyToggleInput.checked = true;
            await handleKeyToggle();
            dom.fulltextKeyToggle.checked = state.isKeyOpened;
            renderFulltextTab();
            // 開封成功なら編集フォーム、キャンセル/失敗なら再びブロック表示
            openRuleEditor();
        },
        onSave: async (rule) => {
            await saveFulltextPoolRule(state.spreadsheetId, rule);
            syncSetFulltextPoolRule(rule);
            div.classList.add('hidden');
            renderFulltextTab();
        },
        onClose: () => div.classList.add('hidden'),
    });
}

// ---------------------------------------------------------------------------
// 除外理由エディタ
// ---------------------------------------------------------------------------

function toggleReasonEditor(): void {
    const div = dom.fulltextReasonEditorDiv;
    if (!div.classList.contains('hidden')) {
        div.classList.add('hidden');
        return;
    }
    div.classList.remove('hidden');
    mountReasonEditor({
        container: div,
        currentItems: state.excludeReasonItems,
        usageCounts: collectReasonUsage(),
        isAdmin: state.isAdmin,
        onSaved: () => {
            div.classList.add('hidden');
            renderFulltextTab();
        },
        onClose: () => div.classList.add('hidden'),
    });
}

/**
 * 理由キーごとの使用件数（フルテキストの除外判定）を数える。
 * 「使用中の理由を消そうとしている」ことをエディタ側で警告するために使う。
 * ブラインド中は他人の票が読み込まれず 0 件に見えることがあるが、
 * 削除しても過去データは消えないため、件数は警告の材料として扱えば十分。
 */
function collectReasonUsage(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const d of collectAllDecisions()) {
        if (d.screening_phase !== 'fulltext' || d.decision !== 'exclude') continue;
        const key = (d.reason || '').trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

// ---------------------------------------------------------------------------
// OA検索（一括・単発）
// ---------------------------------------------------------------------------

/**
 * 任意サイトからのPDFダウンロード用に全HTTPSサイトの実行時権限を求める。
 * 拒否されても PMC / Europe PMC など既存 host_permissions 内のPDFは保存できる。
 *
 * **ユーザージェスチャの無い文脈から呼ばれうる。** 例えば取り込みフロー
 * （`fulltext/publication-candidates.ts` の `handleImportCandidate()` から呼ばれる
 * `fetchSingleFulltextForRef()`）は `addReferences` → `updateReferenceFulltextSets` →
 * `updatePublicationCandidateStatus` → `reloadReferences` の4本のネットワーク往復を
 * await した後にこの関数へ到達するため、押下時点のユーザージェスチャは既に失効している。
 *
 * `chrome.permissions.request()` はジェスチャの無い文脈で呼ぶと
 * "This function must be called during a user gesture" を**同期的に**投げる。この呼び出しは
 * `contains()` のコールバックの中（＝外側の try/catch の外）にあるため、外側だけを
 * try/catch する実装だと一度も resolve/reject されずに Promise が永久に pending のままになる
 * （PR #124 レビュー指摘。取り込みボタンが「取り込み中…」のまま永久に disabled になっていた）。
 * そのため `request()` の呼び出し自体を内側の try/catch で包み、投げたら `resolve(false)` で
 * 必ず決着させる。`chrome.runtime.lastError` が立った場合も同様に `resolve(false)` にする
 * （どちらの経路でも「権限は得られなかった」として扱えば十分で、呼び出し元は権限拒否時と
 * 区別する必要が無いため）。
 */
function requestBroadHostPermission(): Promise<boolean> {
    return new Promise(resolve => {
        try {
            chrome.permissions.contains({ origins: ['https://*/*'] }, has => {
                if (has) {
                    resolve(true);
                    return;
                }
                try {
                    chrome.permissions.request({ origins: ['https://*/*'] }, granted => {
                        if (chrome.runtime.lastError) {
                            resolve(false);
                            return;
                        }
                        resolve(!!granted);
                    });
                } catch {
                    // ユーザージェスチャが無い文脈からの呼び出し。ここで確実に resolve(false) し、
                    // Promise が永久に pending になることを防ぐ。
                    resolve(false);
                }
            });
        } catch {
            resolve(false);
        }
    });
}

function setFetchStatus(msg: string | null): void {
    dom.fulltextFetchStatus.classList.toggle('hidden', !msg);
    dom.fulltextFetchStatus.textContent = msg ?? '';
}

function applyOutcome(
    ref: ReferenceWithStatus,
    outcome: FulltextFetchOutcome
): { fulltextUrl: string; status: FulltextStatus } {
    // OA検索経由の取得はDrive直接取り込みではないため、Drive取り込み元/コピーIDは必ずクリアする
    ref.fulltext_drive_source_id = undefined;
    ref.fulltext_drive_copy_id = undefined;
    if (outcome.kind === 'cached') {
        ref.fulltext_url = outcome.url;
        ref.fulltext_status = 'cached';
        return { fulltextUrl: outcome.url, status: 'cached' };
    }
    if (outcome.kind === 'linked') {
        ref.fulltext_url = outcome.url;
        ref.fulltext_status = 'retrieved';
        return { fulltextUrl: outcome.url, status: 'retrieved' };
    }
    ref.fulltext_url = undefined;
    ref.fulltext_status = 'unavailable';
    return { fulltextUrl: '', status: 'unavailable' };
}

/**
 * discoverPublicationCandidates() の options.fetchCtgPmids に渡す実装。
 * fetchCtgStudy() で取得したCTGレコードから registryPmids 相当のPMID一覧だけを取り出す。
 * discoverRegistryPublicationCandidates() と handleBulkFetch() の再探索ループの2箇所で
 * 同じ実装が必要になるため、ここに括り出して両方から使う（2箇所が将来ずれるのを防ぐ）。
 */
async function fetchCtgPmids(nctId: string): Promise<string[]> {
    return (await fetchCtgStudy(nctId))?.pmids ?? [];
}

/**
 * registration行（isRegistrationRecord(ref) が true）についてのみ、結果論文の候補を探索して返す
 * （保存はしない）。通常論文の行では何もしない（空配列）。候補の表示・取り込み・References への
 * 行追加はチャンク3のスコープで、ここでは一切行わない。
 *
 * 保存は呼び出し側の責務: 一括検索（handleBulkFetch）は候補をバッファへ積んで
 * savePublicationCandidates() を数件おきにまとめて呼び、単発検索（handleSingleFetch）は
 * その場で savePublicationCandidates() を呼ぶ。registration行1件ごとに保存すると
 * Sheets APIの読み取りクォータを容易に超えるため、この関数自体は保存しない設計にしている。
 *
 * ctgPmids は retrieveRegistrationSnapshot() が既に fetchCtgStudy() で取得済みの
 * referencesModule 由来PMID（outcome.registryPmids）をそのまま使う。CTG API を
 * スナップショット取得と論文候補探索で2回叩かないための配線（fulltext-retriever.ts 参照）。
 *
 * 探索自体の失敗（discoverPublicationCandidates 内の各戦略）は下層で握りつぶされる設計だが、
 * 念のためここでも try/catch し、失敗時は空配列を返す（console.warn のみ。一括/単発いずれの
 * 取得ループも、この処理の失敗で止めてはならない）。
 *
 * Issue #134: 主IDで生の候補が0件のときだけ副登録番号でも探索する。副登録番号は
 * abstract 列を parseRegistryFieldsFromAbstract() → extractSecondaryTrialIds() で取り出す
 * （自分自身の試験IDは除外済み）。副登録番号がNCTだった場合の戦略1（ctgov_reference）用に
 * fetchCtgPmids を渡す（ゲートが発火し、かつ対象がNCT形式のときだけ fetchCtgStudy() を呼ぶ
 * 遅延取得。ゲートが発火しなければ1回も呼ばれない）。
 */
async function discoverRegistryPublicationCandidates(
    ref: ReferenceWithStatus,
    outcome: FulltextFetchOutcome
): Promise<PublicationCandidateDraft[]> {
    if (!isRegistrationRecord(ref)) return [];

    const trial = extractTrialId(ref);
    if (!trial) return [];

    try {
        const ctgPmids = (outcome.kind === 'cached' || outcome.kind === 'linked')
            ? (outcome.registryPmids ?? [])
            : [];
        const secondaryTrialIds = extractSecondaryTrialIds(
            parseRegistryFieldsFromAbstract(ref.abstract),
            trial.id
        );
        return await discoverPublicationCandidates({
            refId: ref.ref_id,
            trialId: trial.id,
            kind: trial.kind,
            ctgPmids,
            existingRefs: state.references.map(r => ({ pmid: r.pmid, doi: r.doi })),
            email: state.userEmail,
            secondaryTrialIds,
        }, {
            fetchCtgPmids,
        });
    } catch (err) {
        console.warn('[fulltext-tab] 論文候補探索に失敗:', ref.ref_id, err);
        return [];
    }
}

async function handleBulkFetch(): Promise<void> {
    if (bulkRun) return;

    const retry = dom.fulltextRetryCheckbox.checked;
    const targets = getVisibleFulltextCandidateList().filter(r => {
        const s = retrievalStatus(r);
        return s === 'not_retrieved' || (retry && s === 'unavailable');
    });
    if (targets.length === 0) return;

    const broadGranted = await requestBroadHostPermission();
    if (!broadGranted) {
        showToast(t('fulltext_permissionHint'), 5000);
    }

    bulkRun = { cancelled: false };
    renderFulltextTab();

    // Driveフォルダは最初のPDF取得成功時に一度だけ作成。
    // ensureFulltextFolder が fail-fast エラー（アクセス拒否/認証切れ/一時エラー）を
    // 投げた場合はここで一度だけ toast を出す（memo化により2回目以降は再実行されない）。
    // retrieveAndCacheFulltext 側の catch でこのエラーは既存どおり linked へフォールバックする
    // ため、ここでは再送出するだけで分岐は変えない。
    let folderPromise: Promise<string> | null = null;
    const ensureFolder = () => (folderPromise ??= ensureFulltextFolder(state.spreadsheetId).catch(err => {
        const knownMessage = describeDriveAccessError(err);
        if (knownMessage) showToast(knownMessage, 6000);
        throw err;
    }));

    const pendingWrites: Array<{ refId: string; fulltextUrl: string; status: FulltextStatus; driveSource: null }> = [];
    // registration行の論文候補（Issue #118 チャンク2 パスB）。pendingWrites と同じ流儀で
    // ため込み、flush() でまとめて savePublicationCandidates() を呼ぶ。行ごとに保存すると
    // Sheets APIの読み取りクォータを容易に超えるため（詳細は sheets/publication-candidates.ts の savePublicationCandidates() のコメント参照）。
    const pendingCandidates: PublicationCandidateDraft[] = [];
    const flush = async () => {
        // URL書き込みと候補保存は互いに独立させる: 片方の失敗がもう片方のフラッシュを
        // 巻き込まないよう、try/catch を別々に付ける。
        if (pendingWrites.length > 0) {
            const batch = pendingWrites.splice(0);
            try {
                await updateReferenceFulltextUrls(state.spreadsheetId, batch);
            } catch (err) {
                console.warn('[fulltext-tab] シートへの保存に失敗:', err);
                showToast(t('fulltext_sheetSaveError', (err as Error).message), 5000);
            }
        }

        // pendingCandidates は保存に成功した分だけ flushCandidateBuffer() が取り除く。
        // 失敗時はバッファをそのまま残し、次回の flush() 呼び出し（5件ごと or 最終）で
        // 再送する（PR #122 レビュー指摘2。以前は先に splice(0) してから保存していたため、保存失敗の
        // 瞬間にバッファごと候補が消えていた）。
        if (pendingCandidates.length > 0) {
            const saved = await flushCandidateBuffer(
                pendingCandidates,
                batch => savePublicationCandidates(state.spreadsheetId, batch)
            );
            if (!saved) {
                console.warn('[fulltext-tab] 論文候補の保存に失敗（バッファを保持し次回flushで再送）');
            }
        }
    };

    let done = 0;
    let cachedCount = 0;
    let linkedCount = 0;
    let noneCount = 0;
    // registration行向けの内訳（Issue #118 実装内容6: 完了サマリに「登録n件: スナップショット
    // 保存 / 論文候補m件」を追加するため）。通常論文の行はここにカウントしない。
    let registryProcessed = 0;
    let registrySnapshotSaved = 0;
    let registryCandidatesFound = 0;

    try {
        for (const ref of targets) {
            if (bulkRun.cancelled) break;
            setFetchStatus(t('fulltext_fetchProgress', [String(done + 1), String(targets.length)]));

            let outcome: FulltextFetchOutcome;
            try {
                outcome = await retrieveAndCacheFulltext(ref, state.userEmail, ensureFolder);
            } catch (err) {
                console.warn('[fulltext-tab] 取得エラー:', ref.ref_id, err);
                outcome = { kind: 'none' };
            }

            const write = applyOutcome(ref, outcome);
            // fulltext_url の書き込みは論文候補探索（最大3回のネットワーク往復）を待たずに
            // 先にバッファへ積む（探索が遅くても本質的なURL保存が後回しにならないようにする）。
            pendingWrites.push({ refId: ref.ref_id, driveSource: null, ...write });

            const isRegistryRow = isRegistrationRecord(ref);
            if (isRegistryRow) {
                registryProcessed++;
                if (outcome.kind === 'cached') registrySnapshotSaved++;
            }

            const candidates = await discoverRegistryPublicationCandidates(ref, outcome);
            if (candidates.length > 0) {
                pendingCandidates.push(...candidates);
                if (isRegistryRow) registryCandidatesFound += candidates.length;
            }

            if (outcome.kind === 'cached') cachedCount++;
            else if (outcome.kind === 'linked') linkedCount++;
            else noneCount++;

            done++;
            if (pendingWrites.length >= 5) await flush();
            renderFulltextTab();

            // 外部APIへの礼儀として間隔を空ける
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    } finally {
        await flush();
        // 最終flushでも失敗して候補が残っている場合は、console.warnだけで終わらせず
        // 未保存件数をユーザーに通知する（PR #122 レビュー指摘2。それまでは何も表示されず気付けなかった）。
        if (pendingCandidates.length > 0) {
            showToast(t('fulltext_candidateSaveError', String(pendingCandidates.length)), 6000);
        }
        const cancelled = bulkRun?.cancelled ?? false;
        bulkRun = null;
        renderFulltextTab();
        let summary = t('fulltext_fetchDone', [String(cachedCount), String(linkedCount), String(noneCount)]);
        // registration行を1件でも処理していれば内訳を追加する（Issue #118 実装内容6）。
        if (registryProcessed > 0) {
            summary += ` ${t('fulltext_fetchDoneRegistry', [String(registrySnapshotSaved), String(registryCandidatesFound)])}`;
        }
        setFetchStatus(cancelled ? `${t('fulltext_fetchCancelled')} ${summary}` : summary);
        // 論文候補キャッシュを再読み込みしてバッジへ反映する（この一括取得で新規発見された分も含む）。
        void loadPublicationCandidates();
    }
}

/**
 * registration行の論文候補を、フルテキスト取得状態（fulltext_status）から独立して一括再探索する。
 *
 * handleBulkFetch（取得）の中でしか候補探索が走らない設計だと、registration行は
 * スナップショット保存に成功した時点で `cached` になり、二度と探索対象にならない。
 * PubMed等の一時障害やSheets書き込み失敗で候補が欠落しても、UIから回復する手段が無くなる
 * （Issue #118 チャンク2、PR #122 レビュー指摘2）。
 *
 * 「候補行が既にあるか」で探索済みを推測せず、対象は getVisibleFulltextCandidateList() の
 * うち isRegistrationRecord(ref) が true の行全部（fulltext_status は一切見ない）。
 * savePublicationCandidates() は filterNewCandidates() で同一 ref_id×PMID/DOI の候補を
 * 除外するため、何度再実行しても Publication_Candidates タブに重複行は増えない
 * （＝この冪等性が「取得状態を見ずに毎回全件を再実行してよい」ことの根拠）。
 *
 * handleBulkFetch と同じ bulkRun ガードを共有する。取得と再探索が同時に走らず、
 * 既存の中止ボタン（bulkRun !== null で表示）もそのまま両方に効く。
 */
async function handleBulkSuggest(): Promise<void> {
    if (bulkRun) return;

    const targets = getVisibleFulltextCandidateList().filter(isRegistrationRecord);
    if (targets.length === 0) return;

    bulkRun = { cancelled: false };
    renderFulltextTab();

    // handleBulkFetch の pendingCandidates/flush と同じ流儀（5件ごとにflush。registration行
    // 1件ごとの保存はSheets APIの読み取りクォータを焼き切るため）。
    const pendingCandidates: PublicationCandidateDraft[] = [];
    const flushCandidates = async (): Promise<boolean> => {
        if (pendingCandidates.length === 0) return true;
        const saved = await flushCandidateBuffer(
            pendingCandidates,
            batch => savePublicationCandidates(state.spreadsheetId, batch)
        );
        if (!saved) {
            console.warn('[fulltext-tab] 論文候補の保存に失敗（バッファを保持し次回flushで再送）');
        }
        return saved;
    };

    let done = 0;
    let totalFound = 0;
    // 保存に失敗するとバッファは保持されるため、閾値を固定にすると以降は毎行リトライして
    // しまう（Sheetsが落ちている間、1行につき1回ずつ ensure→読み取り→append を空振りさせる
    // ことになる）。失敗したら次に5件たまるまで再試行を待つ（PR #122 レビュー指摘2、
    // nextCandidateFlushThreshold()）。
    let nextFlushAt = 5;
    try {
        for (const ref of targets) {
            if (bulkRun.cancelled) break;
            setFetchStatus(t('fulltext_suggestProgress', [String(done + 1), String(targets.length)]));

            const trial = extractTrialId(ref);
            if (trial) {
                // Issue #134: 主IDで生の候補が0件のときだけ副登録番号でも探索する（配線は
                // discoverRegistryPublicationCandidates() と同じ。詳細はそちらのJSDoc参照）。
                const secondaryTrialIds = extractSecondaryTrialIds(
                    parseRegistryFieldsFromAbstract(ref.abstract),
                    trial.id
                );
                const candidates = await discoverCandidatesForRerun(
                    trial,
                    ctgPmids => discoverPublicationCandidates({
                        refId: ref.ref_id,
                        trialId: trial.id,
                        kind: trial.kind,
                        ctgPmids,
                        existingRefs: state.references.map(r => ({ pmid: r.pmid, doi: r.doi })),
                        email: state.userEmail,
                        secondaryTrialIds,
                    }, {
                        fetchCtgPmids,
                    }),
                    fetchCtgStudy
                );
                if (candidates.length > 0) {
                    pendingCandidates.push(...candidates);
                    totalFound += candidates.length;
                }
            }

            done++;
            if (pendingCandidates.length >= nextFlushAt) {
                const ok = await flushCandidates();
                nextFlushAt = nextCandidateFlushThreshold(pendingCandidates.length, ok);
            }
            renderFulltextTab();

            // 外部APIへの礼儀として間隔を空ける（handleBulkFetchと同じ）
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    } finally {
        await flushCandidates();
        // 最終flushでも失敗して候補が残っている場合はトーストで通知する（handleBulkFetchと同じ方針）。
        if (pendingCandidates.length > 0) {
            showToast(t('fulltext_candidateSaveError', String(pendingCandidates.length)), 6000);
        }
        const cancelled = bulkRun?.cancelled ?? false;
        bulkRun = null;
        renderFulltextTab();
        const summary = t('fulltext_suggestDone', [String(done), String(totalFound)]);
        setFetchStatus(cancelled ? `${t('fulltext_fetchCancelled')} ${summary}` : summary);
        // 論文候補キャッシュを再読み込みしてバッジへ反映する（この再探索で新規発見された分も含む）。
        void loadPublicationCandidates();
    }
}

async function handleSingleFetch(ref: ReferenceWithStatus, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = t('fulltext_actionFetching');
    await fetchSingleFulltextForRef(ref);
}

/**
 * 単発OA検索の中核処理（ボタンの見た目更新を含まない）。
 *
 * 元は handleSingleFetch(ref, btn) にボタン要素前提でインライン実装されていたが、
 * 論文候補の「取り込む」直後の自動起動（Issue #118 実装内容7。ボタンを介さない）からも
 * 呼べるよう、ボタンの disabled/textContent 更新を handleSingleFetch 側に残したまま
 * 処理本体だけをここへ切り出した。既存の handleSingleFetch(ref, btn) の挙動・エラー処理は
 * 変えていない（このボタン起点の呼び出し元は options を渡さないため常に既定値のまま動く）。
 *
 * @param options.reloadCandidates 完了後に loadPublicationCandidates() を呼ぶか（既定 true）。
 *   取り込みフロー（fulltext/publication-candidates.ts の handleImportCandidate）は
 *   このOA検索の後で自分自身も候補キャッシュを再読込するため、二重読込を避けるために
 *   false を渡す。それ以外（ボタン起点の単発検索）は既定どおり true のままでよい
 *   （このOA検索対象は record_type='article' の行のため、そもそも新規候補が
 *   discoverRegistryPublicationCandidates() で見つかることは無いが、他の登録行の候補が
 *   別経路で増えている可能性まで含めて毎回反映するため既定で読み直す）。
 * @param options.suppressErrorToast 内部の catch で `fulltext_sheetSaveError` トーストを
 *   出さないか（既定 false）。取り込みフロー（handleImportCandidate）はこの関数の失敗を
 *   自前の `pubCandidate_importFetchError` トーストへまとめて出し直すため、二重トーストを
 *   避けるために true を渡す。ボタン起点の単発検索（handleSingleFetch）は options を渡さないため
 *   常に既定値のまま従来どおりトーストが出る。
 * @returns 成功したら true、内部の catch に落ちたら false。ボタン起点の呼び出し元は
 *   戻り値を無視してよい（従来どおりトーストで結果を伝える）。取り込みフローはこの戻り値で
 *   失敗を検出する（内部でトーストを握りつぶして正常returnするため、呼び出し元の
 *   try/catchだけでは失敗を検出できない。既存のtry/catchはこの関数がthrowしうる型のまま
 *   残しているが、判定は戻り値を主に使う）。
 */
export async function fetchSingleFulltextForRef(
    ref: ReferenceWithStatus,
    options: { reloadCandidates?: boolean; suppressErrorToast?: boolean } = {}
): Promise<boolean> {
    const reloadCandidates = options.reloadCandidates ?? true;
    const suppressErrorToast = options.suppressErrorToast ?? false;

    try {
        // requestBroadHostPermission() は内部で必ず resolve するよう直しており、今はここが
        // try の内側にあっても外側にあっても振る舞いは変わらない。それでも内側に置いているのは
        // 多層防御のため: 将来この関数（や chrome.permissions 周りの実装）に手が入って
        // 万一 reject するようになった場合でも、try の外に置いたままだと finally
        // （loadPublicationCandidates の再読込）が走らずボタンが固まる事故を再現しかねない。
        // try の内側に置いて必ず finally 一本で後始末が走るようにしておく。
        await requestBroadHostPermission();
        const outcome = await retrieveAndCacheFulltext(
            ref, state.userEmail,
            // ensureFulltextFolder の fail-fast エラーは通知だけして再送出する。
            // retrieveAndCacheFulltext 側は従来どおり linked へフォールバックする。
            async () => {
                try {
                    return await ensureFulltextFolder(state.spreadsheetId);
                } catch (err) {
                    const knownMessage = describeDriveAccessError(err);
                    if (knownMessage) showToast(knownMessage, 6000);
                    throw err;
                }
            }
        );
        const write = applyOutcome(ref, outcome);
        // fulltext_url の書き込みを論文候補探索より先に済ませる（handleBulkFetch と同じ理由）。
        await updateReferenceFulltextUrl(state.spreadsheetId, ref.ref_id, write.fulltextUrl, write.status, null);

        const candidates = await discoverRegistryPublicationCandidates(ref, outcome);
        if (candidates.length > 0) {
            try {
                await savePublicationCandidates(state.spreadsheetId, candidates);
            } catch (err) {
                console.warn('[fulltext-tab] 論文候補の保存に失敗:', ref.ref_id, err);
            }
        }

        renderFulltextTab();
        return true;
    } catch (err) {
        if (!suppressErrorToast) showToast(t('fulltext_sheetSaveError', (err as Error).message), 5000);
        renderFulltextTab();
        return false;
    } finally {
        if (reloadCandidates) void loadPublicationCandidates();
    }
}

// ---------------------------------------------------------------------------
// PDF手動アップロード
// ---------------------------------------------------------------------------

function handleUploadClick(ref: ReferenceWithStatus): void {
    uploadTargetRefId = ref.ref_id;
    dom.fulltextUploadInput.value = '';
    dom.fulltextUploadInput.click();
}

async function handleUploadChange(): Promise<void> {
    const file = dom.fulltextUploadInput.files?.[0];
    const refId = uploadTargetRefId;
    uploadTargetRefId = null;
    if (!file || !refId) return;

    const ref = state.references.find(r => r.ref_id === refId);
    if (!ref) return;

    // マジックナンバーでPDF検証
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (!String.fromCharCode(...head).startsWith('%PDF')) {
        showToast(t('fulltext_uploadNotPdf'), 4000);
        return;
    }

    showToast(t('fulltext_uploading'), 3000);
    try {
        const folderId = await ensureFulltextFolder(state.spreadsheetId);
        const info = await uploadPdfToDrive(folderId, buildPdfFileName(ref), file);
        ref.fulltext_url = info.webViewLink;
        ref.fulltext_status = 'cached';
        // ローカルPDFの手動アップロードはDrive直接取り込みではないため、取り込み元/コピーIDはクリアする
        ref.fulltext_drive_source_id = undefined;
        ref.fulltext_drive_copy_id = undefined;
        await updateReferenceFulltextUrl(state.spreadsheetId, ref.ref_id, info.webViewLink, 'cached', null);
        renderFulltextTab();
        showToast(t('fulltext_uploadDone'), 3000);
    } catch (err) {
        const knownMessage = describeDriveAccessError(err);
        showToast(knownMessage ?? t('fulltext_uploadError', (err as Error).message), 5000);
    }
}

// ---------------------------------------------------------------------------
// イベントリスナー
// ---------------------------------------------------------------------------

/**
 * イベントリスナーを設定（features/fulltext/lazy.ts の本体読込成功時に一度だけ呼ぶ）
 *
 * タブボタン（共有 dom.ts の tabFulltextBtn）のクリック登録は sidepanel.ts と lazy.ts が担う
 * （llm/index.ts の setupLlmEventListeners と同じ理由。タブ切替は本体ロード前に必要なため）。
 */
export function setupFulltextTabListeners(): void {
    dom.fulltextBackBtn?.addEventListener('click', () => {
        hideToast();
        changeTab('screening');
    });
    setFulltextResultsDeps({ rerenderTab: renderFulltextTab });
    setupFulltextResultsListeners();
    setupFulltextAiListeners();
    setFulltextAssignmentDeps({ rerenderTab: renderFulltextTab });
    setupFulltextAssignmentListeners();
    dom.fulltextRuleEditBtn?.addEventListener('click', () => toggleRuleEditor());
    dom.fulltextReasonEditBtn?.addEventListener('click', () => toggleReasonEditor());
    dom.fulltextFetchBtn?.addEventListener('click', () => { void handleBulkFetch(); });
    dom.fulltextSuggestBtn?.addEventListener('click', () => { void handleBulkSuggest(); });
    dom.fulltextFetchCancelBtn?.addEventListener('click', () => {
        if (bulkRun) bulkRun.cancelled = true;
    });
    dom.fulltextRetryCheckbox?.addEventListener('change', () => renderFulltextTab());
    dom.fulltextViewFilter?.addEventListener('change', () => {
        viewFilter = dom.fulltextViewFilter.value as ViewFilter;
        renderFulltextTab();
    });
    dom.fulltextUploadInput?.addEventListener('change', () => { void handleUploadChange(); });
    setFulltextDriveImportDeps({ rerenderTab: renderFulltextTab });
    setupFulltextDriveImportListeners();
    setupFulltextRegrantListeners();
    setupFulltextChecklistListeners();
    setPublicationCandidatesDeps({
        reloadPublicationCandidates: loadPublicationCandidates,
        fetchSingleFulltext: fetchSingleFulltextForRef,
    });
}
