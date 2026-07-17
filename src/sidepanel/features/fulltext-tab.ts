/**
 * フルテキストタブ
 * 候補プール（共通ルール準拠）に対して以下を提供する:
 *  - 候補ルールのインライン編集（fulltext-rule-editor 共通コンポーネント）
 *  - 全文の入手状況サマリと一括OA検索（PDFはDriveに保存）
 *  - 文献ごとの単発取得・PDF手動アップロード・DOI/PubMedへの導線
 *  - 各文献のフルテキストページ（新規タブ）への導線
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { getFulltextCandidateList } from './screening/filters';
import { handleKeyToggle } from './screening/actions';
import { setupFulltextResultsListeners, renderFulltextResults, setFulltextResultsDeps } from './fulltext-results';
import { setupFulltextAiListeners } from './fulltext-ai';
import {
    renderFulltextAssignmentRow,
    setupFulltextAssignmentListeners,
    setFulltextAssignmentDeps,
} from './fulltext-assignment-ui';
import { renderTeamProgress } from './team-progress';
import { switchToTab } from './llm';
import { mountRuleEditor } from '../../lib/fulltext-rule-editor';
import { retrieveAndCacheFulltext } from '../../lib/fulltext-retriever';
import type { FulltextFetchOutcome } from '../../lib/fulltext-retriever';
import {
    ensureFulltextFolder,
    uploadPdfToDrive,
    buildPdfFileName,
    getDriveFileMetadata,
    copyPdfToFulltextFolder,
} from '../../lib/drive-api';
import { buildPdfPickerUrl } from '../../lib/picker-url';
import {
    saveFulltextPoolRule,
    updateReferenceFulltextUrl,
    updateReferenceFulltextUrls,
} from '../../lib/sheets-api';
import { setFulltextPoolRule as syncSetFulltextPoolRule } from '../store/compat';
import { showToast } from '../ui/feedback';
import type { ReferenceWithStatus, Decision, FulltextStatus } from '../../lib/types';

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

/**
 * フルテキストタブを開く
 */
export function activateFulltextTab(): void {
    switchToTab('fulltext');
    renderFulltextTab();
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
    const candidates = getFulltextCandidateList();

    renderRuleAndProgress(candidates);
    renderFulltextAssignmentRow();
    renderTeamProgress();
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

function recordPageUrl(ref: ReferenceWithStatus): string | null {
    if (ref.doi) return `https://doi.org/${encodeURIComponent(ref.doi)}`;
    if (ref.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/`;
    return null;
}

function renderList(candidates: ReferenceWithStatus[]): void {
    const listDiv = dom.fulltextListDiv;
    listDiv.innerHTML = '';

    const visible = applyViewFilter(candidates);

    if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'fulltext-empty';
        empty.textContent = t('fulltext_emptyList');
        listDiv.appendChild(empty);
        return;
    }

    for (const ref of visible) {
        listDiv.appendChild(buildCard(ref));
    }
}

function buildCard(ref: ReferenceWithStatus): HTMLElement {
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
        onOpenKey: async () => {
            // handleBlindToggle (fulltext-results.ts) と同じ委譲パターン:
            // handleKeyToggle は dom.keyToggleInput.checked を正とする
            dom.keyToggleInput.checked = true;
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
// OA検索（一括・単発）
// ---------------------------------------------------------------------------

// 任意サイトからのPDFダウンロード用に全HTTPSサイトの実行時権限を求める。
// 拒否されても PMC / Europe PMC など既存 host_permissions 内のPDFは保存できる。
function requestBroadHostPermission(): Promise<boolean> {
    return new Promise(resolve => {
        try {
            chrome.permissions.contains({ origins: ['https://*/*'] }, has => {
                if (has) {
                    resolve(true);
                    return;
                }
                chrome.permissions.request({ origins: ['https://*/*'] }, granted => resolve(!!granted));
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

async function handleBulkFetch(): Promise<void> {
    if (bulkRun) return;

    const retry = dom.fulltextRetryCheckbox.checked;
    const targets = getFulltextCandidateList().filter(r => {
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

    // Driveフォルダは最初のPDF取得成功時に一度だけ作成
    let folderPromise: Promise<string> | null = null;
    const ensureFolder = () => (folderPromise ??= ensureFulltextFolder(state.spreadsheetId));

    const pendingWrites: Array<{ refId: string; fulltextUrl: string; status: FulltextStatus }> = [];
    const flush = async () => {
        if (pendingWrites.length === 0) return;
        const batch = pendingWrites.splice(0);
        try {
            await updateReferenceFulltextUrls(state.spreadsheetId, batch);
        } catch (err) {
            console.warn('[fulltext-tab] シートへの保存に失敗:', err);
            showToast(t('fulltext_sheetSaveError', (err as Error).message), 5000);
        }
    };

    let done = 0;
    let cachedCount = 0;
    let linkedCount = 0;
    let noneCount = 0;

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
            pendingWrites.push({ refId: ref.ref_id, ...write });
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
        const cancelled = bulkRun?.cancelled ?? false;
        bulkRun = null;
        renderFulltextTab();
        const summary = t('fulltext_fetchDone', [String(cachedCount), String(linkedCount), String(noneCount)]);
        setFetchStatus(cancelled ? `${t('fulltext_fetchCancelled')} ${summary}` : summary);
    }
}

async function handleSingleFetch(ref: ReferenceWithStatus, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = t('fulltext_actionFetching');

    await requestBroadHostPermission();

    try {
        const outcome = await retrieveAndCacheFulltext(
            ref, state.userEmail,
            () => ensureFulltextFolder(state.spreadsheetId)
        );
        const write = applyOutcome(ref, outcome);
        await updateReferenceFulltextUrl(state.spreadsheetId, ref.ref_id, write.fulltextUrl, write.status);
        renderFulltextTab();
    } catch (err) {
        showToast(t('fulltext_sheetSaveError', (err as Error).message), 5000);
        renderFulltextTab();
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
        await updateReferenceFulltextUrl(state.spreadsheetId, ref.ref_id, info.webViewLink, 'cached');
        renderFulltextTab();
        showToast(t('fulltext_uploadDone'), 3000);
    } catch (err) {
        showToast(t('fulltext_uploadError', (err as Error).message), 5000);
    }
}

// ---------------------------------------------------------------------------
// Driveへ直接置かれたPDFの取り込み（検証版・フェーズA検証スパイク）
//
// アプリを経由せずDriveフォルダへ直接保存されたPDFを、Pickerで明示選択させたうえで
// fulltextフォルダへ files.copy で取り込む機能のうち、以下2点の実機検証のみを行う導線:
//   検証1: Pickerの選択結果（ファイルID）を launchWebAuthFlow のリダイレクト捕捉で
//           拡張機能へ直接返せるか（各ファイルの metadata 取得結果で確認）
//   検証2: 選択PDFの files.copy によるfulltextフォルダへのコピーが拡張機能トークンで
//           成功するか（先頭1ファイルのみ、確認ダイアログ付きで実行）
// 対応付けUI・シート更新・クリーンアップUIは今回のスパイクでは実装しない。
// ---------------------------------------------------------------------------

interface PickedDriveFile {
    id: string;
    name: string;
    mimeType: string;
}

/**
 * Picker ページからの launchWebAuthFlow リダイレクトURLを解析する。
 * フラグメントに files=<JSON> または cancelled=1 が入っている想定
 * （src/webapp/picker.ts の returnFilesToExtension / returnCancelledToExtension が付与する）。
 */
function parsePdfPickerRedirect(redirectUrl: string): { files: PickedDriveFile[] } | 'cancelled' | null {
    let hash: string;
    try {
        hash = new URL(redirectUrl).hash.replace(/^#/, '');
    } catch {
        return null;
    }
    const params = new URLSearchParams(hash);
    if (params.get('cancelled') === '1') return 'cancelled';
    const filesParam = params.get('files');
    if (!filesParam) return null;
    try {
        const parsed: unknown = JSON.parse(filesParam);
        if (!Array.isArray(parsed)) return null;
        return { files: parsed as PickedDriveFile[] };
    } catch {
        return null;
    }
}

function setDriveImportStatus(msg: string | null): void {
    dom.fulltextImportDriveStatus.classList.toggle('hidden', !msg);
    dom.fulltextImportDriveStatus.textContent = msg ?? '';
}

async function handleImportFromDriveClick(): Promise<void> {
    setDriveImportStatus(t('fulltext_driveImportRunning'));
    try {
        // 検証1: Picker選択結果を launchWebAuthFlow のリダイレクト捕捉で受け取る。
        // sidepanel はタブとして開かれる拡張ページであり chrome.identity を直接呼べるため、
        // auth-flow.ts（service-worker専用のトークンキャッシュ管理）を経由させず直接呼ぶ。
        const redirectUri = chrome.identity.getRedirectURL('picker');
        const url = buildPdfPickerUrl({ email: state.userEmail, redirectUri });
        const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
        if (!redirectUrl) {
            setDriveImportStatus(null);
            return;
        }

        const parsed = parsePdfPickerRedirect(redirectUrl);
        if (parsed === null) {
            showToast(t('fulltext_driveImportParseError'), 5000);
            setDriveImportStatus(null);
            return;
        }
        if (parsed === 'cancelled' || parsed.files.length === 0) {
            setDriveImportStatus(null);
            return;
        }

        // 各ファイルのmetadata取得を試み、結果をコンソールと画面の両方に出す（検証1の合否確認）
        const resultLines: string[] = [];
        for (const file of parsed.files) {
            try {
                const meta = await getDriveFileMetadata(file.id);
                console.log('[fulltext-tab][drive-import-spike] metadata取得成功', meta);
                resultLines.push(t('fulltext_driveImportMetaOk', [
                    meta.name, meta.mimeType, meta.size ?? '?', String(meta.capabilities?.canCopy ?? '?'),
                ]));
            } catch (err) {
                console.warn('[fulltext-tab][drive-import-spike] metadata取得失敗', file, err);
                resultLines.push(t('fulltext_driveImportMetaFail', [file.name, (err as Error).message]));
            }
        }
        setDriveImportStatus(resultLines.join('\n'));

        // 検証2: 先頭の1ファイルのみ、確認のうえfulltextフォルダへコピーする
        const first = parsed.files[0];
        if (!window.confirm(t('fulltext_driveImportCopyConfirm', first.name))) return;

        setDriveImportStatus(`${resultLines.join('\n')}\n${t('fulltext_driveImportCopying')}`);
        const folderId = await ensureFulltextFolder(state.spreadsheetId);
        const copy = await copyPdfToFulltextFolder(first.id, folderId, first.name, {
            sourceFileId: first.id,
            refId: 'spike-test',
            spreadsheetId: state.spreadsheetId,
            importOperationId: crypto.randomUUID(),
        });
        console.log('[fulltext-tab][drive-import-spike] コピー成功', copy);
        setDriveImportStatus(`${resultLines.join('\n')}\n${t('fulltext_driveImportCopyDone', copy.webViewLink)}`);
        showToast(t('fulltext_driveImportCopyDone', copy.webViewLink), 6000);
    } catch (err) {
        console.warn('[fulltext-tab][drive-import-spike] エラー', err);
        showToast(t('fulltext_driveImportError', (err as Error).message), 6000);
        setDriveImportStatus(null);
    }
}

// ---------------------------------------------------------------------------
// イベントリスナー
// ---------------------------------------------------------------------------

/**
 * イベントリスナーを設定（sidepanel.ts から呼ぶ）
 */
export function setupFulltextTabListeners(): void {
    dom.tabFulltextBtn?.addEventListener('click', () => activateFulltextTab());
    dom.fulltextBackBtn?.addEventListener('click', () => switchToTab('screening'));
    setFulltextResultsDeps({ rerenderTab: renderFulltextTab });
    setupFulltextResultsListeners();
    setupFulltextAiListeners();
    setFulltextAssignmentDeps({ rerenderTab: renderFulltextTab });
    setupFulltextAssignmentListeners();
    dom.fulltextRuleEditBtn?.addEventListener('click', () => toggleRuleEditor());
    dom.fulltextFetchBtn?.addEventListener('click', () => { void handleBulkFetch(); });
    dom.fulltextFetchCancelBtn?.addEventListener('click', () => {
        if (bulkRun) bulkRun.cancelled = true;
    });
    dom.fulltextRetryCheckbox?.addEventListener('change', () => renderFulltextTab());
    dom.fulltextViewFilter?.addEventListener('change', () => {
        viewFilter = dom.fulltextViewFilter.value as ViewFilter;
        renderFulltextTab();
    });
    dom.fulltextUploadInput?.addEventListener('change', () => { void handleUploadChange(); });
    dom.fulltextImportDriveBtn?.addEventListener('click', () => { void handleImportFromDriveClick(); });
}
