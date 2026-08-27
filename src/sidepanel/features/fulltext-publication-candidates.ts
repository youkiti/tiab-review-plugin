/**
 * 論文候補パネル（Issue #118「レジストリ連携フェーズ1」チャンク3b）
 *
 * registration行のカードに「論文候補 n件」バッジを出し、クリックでカード直下に候補パネルを
 * 展開する。候補1件ごとにタイトル・ジャーナル/年・発見戦略・PubMed/DOIリンク・
 * 「取り込む」「対象外」ボタンを出す。
 *
 * 候補データの読み込み・モジュールローカルキャッシュの保持は fulltext-tab.ts の責務
 * （このタブ限定の関心事のため state には足さない）。このモジュールは
 * 「既に選別・整形済みの候補配列」を受け取ってDOMを組み立てるだけで、キャッシュ自体は持たない。
 *
 * fulltext-tab.ts との依存はどちらの向きにも直接import しない。fulltext-results.ts /
 * fulltext-assignment-ui.ts / fulltext-drive-import.ts と同じ「setXxxDeps」注入パターンで
 * 循環importを避ける。
 *
 * 【原則（Issue #118 の決定事項）】References に行が追加される経路は「取り込む」ボタンの
 * 明示操作だけ。ここ以外（一括検索・再探索・自動処理）からは1行も追加しない。
 */

import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { showToast } from '../ui/feedback';
import { isSafeHttpUrl } from '../../lib/registry-record';
import {
    isPublicationCandidateAlreadyImported,
    publicationCandidateStrategyLabelKey,
} from '../../lib/publication-candidate-panel';
import { buildDoiUrl, buildPubmedUrl } from '../../lib/external-record-url';
import { buildImportedPublicationReference, resolveImportedFulltextSet } from '../../lib/publication-import';
import {
    addReferences,
    updateReferenceFulltextSets,
    updatePublicationCandidateStatus,
} from '../../lib/sheets-api';
import { reloadReferences } from './fulltext-ai';
import type { PublicationCandidate, ReferenceWithStatus } from '../../lib/types';

// ---------------------------------------------------------------------------
// fulltext-tab.ts への依存注入（循環import回避。setFulltextResultsDeps 等と同じ流儀）
// ---------------------------------------------------------------------------

export interface PublicationCandidatesDeps {
    /**
     * 候補キャッシュ（fulltext-tab.ts の publicationCandidates）を再取得し、
     * 完了後に renderFulltextTab() を呼び直す。取り込み・対象外化の後に呼ぶ。
     */
    reloadPublicationCandidates: () => Promise<void>;
    /**
     * 単発OA検索の中核処理（fulltext-tab.ts の fetchSingleFulltextForRef）。
     * ボタン要素を必要としない形に切り出したもの（既存の handleSingleFetch の見た目更新は
     * 呼び出し元が担う）。取り込み直後の自動起動に使う（Issue #118 実装内容7）。
     */
    fetchSingleFulltext: (ref: ReferenceWithStatus, options?: { reloadCandidates?: boolean }) => Promise<void>;
}

let deps: PublicationCandidatesDeps | null = null;

export function setPublicationCandidatesDeps(d: PublicationCandidatesDeps): void {
    deps = d;
}

// ---------------------------------------------------------------------------
// モジュールローカル状態
// ---------------------------------------------------------------------------

/** バッジクリックで開閉するパネルの展開状態（ref_id単位）。renderFulltextTab() はカードを
 *  毎回作り直すため、開閉状態はDOMではなくここで保持する（team-progress.ts の expanded と同じ方針）。 */
const expandedRefIds = new Set<string>();

/** 二重クリック防止（同一候補への同時実行ガード） */
const importInFlight = new Set<string>();
const dismissInFlight = new Set<string>();

/**
 * candidate_id -> このセッション内で addReferences() が成功した新規 ref_id。
 *
 * 「Referencesへの追加(3)は成功したが後続(fulltext_set更新・候補ステータス更新・OA検索)が
 * 失敗した」場合、候補は status='suggested' のまま残る。ここに記録しておくことで、
 * 同じ候補へ再度「取り込む」を押されたときに addReferences() をもう一度呼ばず
 * （＝行を二重に作らず）、記録済みのref_idで残りのステップだけをやり直す。
 * 候補ステータスの更新(5)に成功した時点でこのエントリは役目を終える（削除する）。
 */
const importedRefIdByCandidateId = new Map<string, string>();

// ---------------------------------------------------------------------------
// カードへの装飾（バッジ＋パネル）
// ---------------------------------------------------------------------------

/**
 * 既に組み立て済みの `.fulltext-card` へ論文候補バッジを追加し、カード＋パネルをまとめた
 * ラッパー要素を返す。呼び出し側（fulltext-tab.ts の buildCard()）は
 * `candidates.length > 0`（かつ isRegistrationRecord(ref)）のときだけ呼ぶ前提
 * （このモジュール自身はどちらの再判定もしない）。
 *
 * @param card 組み立て済みの `.fulltext-card` 要素（フッターに `.fulltext-card-footer` を持つこと）
 * @param registrationRef バッジ元の registration 行
 * @param candidates この行に紐づく status==='suggested' の候補（呼び出し側で
 *   selectSuggestedPublicationCandidates() 済み・戦略の強い順にソート済みの前提）
 */
export function decoratePublicationCandidateCard(
    card: HTMLElement,
    registrationRef: ReferenceWithStatus,
    candidates: PublicationCandidate[]
): HTMLElement {
    const footer = card.querySelector('.fulltext-card-footer');
    if (!footer) return card; // 安全側: フッターが無い呼び出し方は想定していない

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'fulltext-badge badge-pubcandidate';
    badge.textContent = t('pubCandidate_badge', String(candidates.length));
    badge.title = t('pubCandidate_badgeTitle');
    footer.appendChild(badge);

    const wrapper = document.createElement('div');
    wrapper.className = 'fulltext-card-row';
    wrapper.appendChild(card);

    const panel = document.createElement('div');
    panel.className = 'pub-candidate-panel hidden';
    renderCandidatePanelBody(panel, registrationRef, candidates);
    panel.classList.toggle('hidden', !expandedRefIds.has(registrationRef.ref_id));
    wrapper.appendChild(panel);

    badge.addEventListener('click', (e) => {
        e.stopPropagation(); // カードクリック（フルテキストページを開く）を抑止
        if (expandedRefIds.has(registrationRef.ref_id)) {
            expandedRefIds.delete(registrationRef.ref_id);
        } else {
            expandedRefIds.add(registrationRef.ref_id);
        }
        panel.classList.toggle('hidden', !expandedRefIds.has(registrationRef.ref_id));
    });

    return wrapper;
}

function renderCandidatePanelBody(
    panel: HTMLElement,
    registrationRef: ReferenceWithStatus,
    candidates: PublicationCandidate[]
): void {
    panel.innerHTML = '';
    for (const candidate of candidates) {
        panel.appendChild(buildCandidateRow(registrationRef, candidate));
    }
}

/**
 * 候補1件ぶんの行を組み立てる。
 *
 * セキュリティ: title/journal は外部API（PubMed esummary・Europe PMC）由来の信頼できない
 * 文字列のため、innerHTML に載せる箇所は必ず escapeHtml() を通す（buildCard() と同じ方針）。
 */
function buildCandidateRow(registrationRef: ReferenceWithStatus, candidate: PublicationCandidate): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pub-candidate-row';

    const metaParts: string[] = [];
    if (candidate.year) metaParts.push(String(candidate.year));
    if (candidate.journal) metaParts.push(candidate.journal);

    row.innerHTML = `
        <span class="pub-candidate-title">${escapeHtml(candidate.title || t('pubCandidate_untitled'))}</span>
        <span class="pub-candidate-meta">${escapeHtml(metaParts.join(' · '))}</span>
        <span class="pub-candidate-strategy">${escapeHtml(t(publicationCandidateStrategyLabelKey(candidate.strategy)))}</span>
        <span class="pub-candidate-actions"></span>
    `;

    const actions = row.querySelector('.pub-candidate-actions')!;

    // PubMed/DOIへのリンク。組み立てたURLは chrome.tabs.create() へ渡す前に必ず
    // isSafeHttpUrl() を通す（PR #122 レビュー指摘3と同じ教訓。buildPubmedUrl/buildDoiUrlは
    // 常にhttps固定URLを返すため通らないことは無いはずだが、外部リンクを開く箇所は
    // 一律この防御を経由させる）。
    if (candidate.pmid) {
        const url = buildPubmedUrl(candidate.pmid);
        if (isSafeHttpUrl(url)) {
            actions.appendChild(buildLinkBtn(t('pubCandidate_pubmedLink'), url));
        }
    }
    if (candidate.doi) {
        const url = buildDoiUrl(candidate.doi);
        if (isSafeHttpUrl(url)) {
            actions.appendChild(buildLinkBtn(t('pubCandidate_doiLink'), url));
        }
    }

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'fulltext-action-btn fulltext-action-btn--primary';
    importBtn.textContent = t('pubCandidate_importBtn');
    importBtn.title = t('pubCandidate_importBtnTitle');
    importBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleImportCandidate(candidate, registrationRef, importBtn);
    });
    actions.appendChild(importBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'fulltext-action-btn';
    dismissBtn.textContent = t('pubCandidate_dismissBtn');
    dismissBtn.title = t('pubCandidate_dismissBtnTitle');
    dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleDismissCandidate(candidate, dismissBtn);
    });
    actions.appendChild(dismissBtn);

    return row;
}

function buildLinkBtn(label: string, url: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fulltext-action-btn';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url });
    });
    return btn;
}

// ---------------------------------------------------------------------------
// 「取り込む」
// ---------------------------------------------------------------------------

/**
 * 候補をReferencesへ取り込む（Issue #118 実装内容7）。
 *
 * 手順（ブリーフ通りの順序）:
 * 1. 重複チェック（state.references を押した瞬間にもう一度見る）
 * 2-3. buildImportedPublicationReference() で新規行を組み立て、addReferences() で追加
 * 4. resolveImportedFulltextSet() が非空のときだけ fulltext_set を書く
 * 5. updatePublicationCandidateStatus() で候補を imported にする
 * 6. reloadReferences() で state を更新
 * 7. 新規行に対して単発OA検索を自動起動する
 * 8. （reloadPublicationCandidates 経由で）renderFulltextTab() を呼び直す
 *
 * 【行追加は成功したが後続が失敗した場合への備え】
 * 3(addReferences)が成功した直後に importedRefIdByCandidateId へ ref_id を記録する。
 * その後 4/5/6/7 のいずれかが失敗して候補が status='suggested' のまま残っても、
 * 同じ候補へ再度「取り込む」を押されたときはこの記録を最優先で見て、addReferences() を
 * 呼び直さず（＝Referencesへの二重追加を避け）記録済みのref_idで残りのステップだけを
 * やり直す。5(ステータス更新)に成功すればこの記録は不要になるため削除する。
 *
 * この記録が無い（例: ブラウザ再起動でモジュール状態が失われた）場合でも、1の重複チェックが
 * state.references 上の同一PMID/DOIを検出するため、Referencesへの二重追加そのものは
 * 常に防がれる。ただしこの経路では候補は 'dismissed' として決着する（「誰がいつ取り込んだ行か」
 * を後から特定できないため、imported_ref_id を安全に紐付けられない。行自体は既に存在するので
 * データが失われるわけではないが、候補の decided_by/imported_ref_id からは追跡できなくなる）。
 *
 * 【「再試行できます」案内が成り立つのはステップ5が失敗したときだけ】
 * 5(候補ステータスの更新)が成功すると、候補は status='imported' になり
 * selectSuggestedPublicationCandidates()（status==='suggested' のみ表示）のフィルタから外れて
 * パネルから消える。つまり4や7だけが失敗した場合、候補はもうパネルに無いため
 * 「もう一度『取り込む』を押す」という再試行導線が構造的に存在しない。この2ケースを
 * statusUpdateSucceeded フラグで区別し、5が失敗したときだけ「再試行できます」文言
 * （pubCandidate_importPartialRetryable）を、5は成功したが他が失敗したときは
 * 再試行を促さない文言（pubCandidate_importPartialNoRetry）を出す。
 *
 * 【5は成功したが4(fulltext_set)だけ失敗したケースには復旧導線が無い】
 * 上記の理由でこのケースはパネルからもバッジからも消え、UIから「担当グループが
 * 設定されていない」ことに気付いて再操作する手段が無い（実害は fulltext_set が空のままに
 * なることに限られ、related_ref_id が非空のためフルテキスト候補一覧・共有分母には
 * 3aの分岐で引き続き載る＝候補自体を見失うわけではない）。管理者が手動で
 * updateReferenceFulltextSets() 相当の操作（担当割り振りの再生成、またはシート直接編集）を
 * 行うしかない。将来この復旧導線を作るなら、pubCandidate_importPartialNoRetry のトースト内容
 * だけでなく、対象 ref_id を特定できる形（例: References側に何らかのマーカーを残す）が必要になる。
 */
async function handleImportCandidate(
    candidate: PublicationCandidate,
    registrationRef: ReferenceWithStatus,
    btn: HTMLButtonElement
): Promise<void> {
    if (!deps) return;
    if (importInFlight.has(candidate.candidate_id)) return;
    importInFlight.add(candidate.candidate_id);

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('pubCandidate_importing');

    try {
        const recoveredRefId = importedRefIdByCandidateId.get(candidate.candidate_id);
        let refId: string;

        if (recoveredRefId) {
            refId = recoveredRefId;
        } else {
            // ステップ1: 重複チェック
            const existingRefs = state.references.map(r => ({ pmid: r.pmid, doi: r.doi }));
            if (isPublicationCandidateAlreadyImported(candidate, existingRefs)) {
                // 更新の成否でトースト文言を出し分ける（失敗時に「対象外にしました」と
                // 事実と異なる報告をしないため）。失敗すると候補は 'suggested' のまま残る。
                let dismissUpdateSucceeded = true;
                try {
                    await updatePublicationCandidateStatus(state.spreadsheetId, [{
                        candidateId: candidate.candidate_id,
                        status: 'dismissed',
                        decidedBy: state.userEmail,
                    }]);
                } catch (err) {
                    console.warn('[fulltext-publication-candidates] 重複候補のdismissed更新に失敗:', candidate.candidate_id, err);
                    dismissUpdateSucceeded = false;
                }
                showToast(
                    dismissUpdateSucceeded
                        ? t('pubCandidate_alreadyInList')
                        : t('pubCandidate_alreadyInListUpdateFailed'),
                    4000
                );
                await deps.reloadPublicationCandidates();
                return;
            }

            // ステップ2-3: 新規Referenceを組み立てて追加
            const newRefId = crypto.randomUUID();
            const importedAt = new Date().toISOString();
            const newRef = buildImportedPublicationReference({
                candidate,
                registrationRef,
                refId: newRefId,
                importedBy: state.userEmail,
                importedAt,
            });

            try {
                await addReferences(state.spreadsheetId, [newRef]);
            } catch (err) {
                console.warn('[fulltext-publication-candidates] References への追加に失敗:', err);
                showToast(t('pubCandidate_importAddError', (err as Error).message), 6000);
                return;
            }
            // 追加成功を記録（この後どこで失敗しても二重追加しないための唯一の情報源）
            importedRefIdByCandidateId.set(candidate.candidate_id, newRefId);
            refId = newRefId;
        }

        // ステップ4-7: 個別に失敗しても処理を止めない。失敗はまとめて最後にトーストする
        const failures: string[] = [];

        const fulltextSet = resolveImportedFulltextSet(registrationRef, state.fulltextAssignment);
        if (fulltextSet) {
            try {
                await updateReferenceFulltextSets(state.spreadsheetId, [{ refId, fulltextSet }]);
            } catch (err) {
                console.warn('[fulltext-publication-candidates] fulltext_set の更新に失敗:', err);
                failures.push(t('pubCandidate_importFulltextSetError'));
            }
        }

        // ステップ5が実際に成功したかどうかで、後続トーストの「再試行できます」案内の
        // 出し分けが決まる（下記 showToast 参照）。failures配列だけでは
        // 「ステップ5が失敗したか」を区別できない（4/7 も同じ配列に積むため）ので、
        // 専用のフラグで追跡する。
        let statusUpdateSucceeded = true;
        try {
            await updatePublicationCandidateStatus(state.spreadsheetId, [{
                candidateId: candidate.candidate_id,
                status: 'imported',
                decidedBy: state.userEmail,
                importedRefId: refId,
            }]);
            // 成功したのでリカバリ用の記録は不要（Mapが無限に育たないよう掃除する）
            importedRefIdByCandidateId.delete(candidate.candidate_id);
        } catch (err) {
            console.warn('[fulltext-publication-candidates] 候補ステータスの更新に失敗:', err);
            failures.push(t('pubCandidate_importStatusError'));
            statusUpdateSucceeded = false;
        }

        await reloadReferences(state.spreadsheetId);

        const importedRef = state.references.find(r => r.ref_id === refId)
            ?? state.allReferences.find(r => r.ref_id === refId);
        if (importedRef) {
            try {
                // reloadPublicationCandidates は呼び出し元(ここ)が最後に必ず呼ぶため、
                // fetchSingleFulltext 自身の候補再読込は二重になるので抑止する。
                await deps.fetchSingleFulltext(importedRef, { reloadCandidates: false });
            } catch (err) {
                console.warn('[fulltext-publication-candidates] 単発OA検索に失敗:', err);
                failures.push(t('pubCandidate_importFetchError'));
            }
        } else {
            // reloadReferences() は失敗時に例外を投げず内部でconsole.errorするだけなので、
            // ここに来るのは reload自体が失敗して新規行がまだ state に反映されていない場合。
            // 行自体は追加済みなので、次回の一括/単発検索や再読み込みで拾える（致命的ではない）。
            failures.push(t('pubCandidate_importFetchError'));
        }

        if (failures.length === 0) {
            showToast(t('pubCandidate_importDone'), 3000);
        } else if (!statusUpdateSucceeded) {
            // ステップ5自体が失敗 → 候補はまだ 'suggested' のまま残っており、
            // selectSuggestedPublicationCandidates() のフィルタを通るのでパネルに残り続ける。
            // 「もう一度押せば再試行できる」という案内が実際に成り立つのはこのケースだけ。
            showToast(t('pubCandidate_importPartialRetryable', failures.join(' / ')), 8000);
        } else {
            // ステップ5は成功（候補は 'imported' になった） → status==='suggested' の
            // フィルタから外れてパネルから消えるため、「取り込む」を再度押す再試行導線が
            // 構造的に存在しない。ここで案内を「再試行できます」のままにすると、
            // 押しても既にパネルに無い候補への案内になり成り立たない誤案内になる。
            showToast(t('pubCandidate_importPartialNoRetry', failures.join(' / ')), 8000);
        }

        await deps.reloadPublicationCandidates();
    } finally {
        importInFlight.delete(candidate.candidate_id);
        btn.disabled = false;
        btn.textContent = originalLabel ?? t('pubCandidate_importBtn');
    }
}

// ---------------------------------------------------------------------------
// 「対象外」
// ---------------------------------------------------------------------------

/**
 * 候補を対象外にする（Issue #118 実装内容6の一部）。References には一切触れない。
 */
async function handleDismissCandidate(candidate: PublicationCandidate, btn: HTMLButtonElement): Promise<void> {
    if (!deps) return;
    if (dismissInFlight.has(candidate.candidate_id)) return;
    dismissInFlight.add(candidate.candidate_id);
    btn.disabled = true;

    try {
        await updatePublicationCandidateStatus(state.spreadsheetId, [{
            candidateId: candidate.candidate_id,
            status: 'dismissed',
            decidedBy: state.userEmail,
        }]);
        await deps.reloadPublicationCandidates();
    } catch (err) {
        console.warn('[fulltext-publication-candidates] 候補の対象外化に失敗:', err);
        showToast(t('pubCandidate_dismissError', (err as Error).message), 5000);
    } finally {
        dismissInFlight.delete(candidate.candidate_id);
        btn.disabled = false;
    }
}
