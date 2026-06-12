// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// Phase 2 (実装済み): DOI/PMID → OA PDF URL 取得
// Phase 4 (本変更): 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存)
//   + フルテキスト候補リストによる前後ナビゲーション
// Phase 3 (TODO): PDF.js ビュワー + ハイライト保存 (Annotations タブ)
// Phase 5 (TODO): データ抽出モード (label 付きアノテーション)

import {
    getAuthToken,
    getUserEmail,
    getFulltextPageData,
    saveFulltextPoolRule,
    saveDecision,
    updateReferenceFulltextUrl,
} from '../lib/sheets-api';
import { retrieveFulltextUrl } from '../lib/fulltext-retriever';
import { getClientVersion } from '../lib/client-version';
import {
    isInFulltextPool,
    describeRule,
    isTiabDecision,
} from '../lib/fulltext-pool';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import { mountRuleEditor } from '../lib/fulltext-rule-editor';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference, Decision } from '../lib/types';

const OA_SOURCE_LABELS: Record<OaSource | 'cached', string> = {
    pmc_oa: 'PMC OA',
    europe_pmc: 'Europe PMC',
    unpaywall: 'Unpaywall',
    openalex: 'OpenAlex',
    cached: 'キャッシュ済み',
};

// ページ状態
let currentRef: Reference | null = null;
let userEmail = '';
let spreadsheetId = '';

// 全文献・全判定（候補計算とルールUIで使用）
let allRefs: Reference[] = [];
let allDecisions: Decision[] = [];

// フルテキスト候補ルール（Configシート共有設定、未設定はnull）
let poolRule: FulltextPoolRule | null = null;
let keyOpened = false;

// フルテキスト候補リスト
let fulltextCandidates: Reference[] = [];
let currentCandidateIndex = -1;

// 現在の決断パネル状態
let pendingDecision: 'include' | 'exclude' | 'maybe' | null = null;
let existingDecision: { decision: Decision; rowIndex: number } | null = null;

document.addEventListener('DOMContentLoaded', () => {
    initFulltextPage().catch(err => {
        showPlaceholder(`初期化エラー: ${(err as Error).message}`);
    });
});

async function initFulltextPage(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const refId = params.get('ref_id') ?? '';

    if (!refId) {
        showPlaceholder('ref_id が指定されていません。サイドパネルから開いてください。');
        return;
    }

    showPlaceholder('読み込み中...');

    // 認証・ユーザー情報
    await getAuthToken();
    userEmail = await getUserEmail();

    // プロジェクト設定
    const stored = await chrome.storage.local.get(['spreadsheetId']);
    spreadsheetId = (stored.spreadsheetId as string | undefined) ?? '';
    if (!spreadsheetId) {
        showPlaceholder('プロジェクトが未設定です。サイドパネルで先にプロジェクトを開いてください。');
        return;
    }

    // 文献一覧・判定一覧・Config共有設定を1リクエストで取得（429対策）
    const { references: refs, decisions: decisionsData, config } = await getFulltextPageData(spreadsheetId);

    allRefs = refs;
    allDecisions = decisionsData.map(({ decision }) => decision);
    poolRule = config.fulltextPoolRule;
    keyOpened = config.keyOpened;

    const ref = refs.find(r => r.ref_id === refId) ?? null;
    if (!ref) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }
    currentRef = ref;

    // フルテキスト候補リストを計算
    recomputeCandidates();

    // 既存のフルテキスト決断を取得
    existingDecision = decisionsData.find(
        ({ decision: d }) =>
            d.ref_id === refId &&
            d.reviewer_id === userEmail &&
            (d.screening_phase ?? 'tiab') === 'fulltext'
    ) ?? null;
    if (existingDecision) {
        pendingDecision = existingDecision.decision.decision as 'include' | 'exclude' | 'maybe';
    }

    // UI 初期化
    renderRefMeta(ref);
    renderProgress();
    renderDecisionPanel();
    wireNavButtons();
    wireDecisionButtons();
    wireAttachTabButton();
    wireRulePanel();
    updateRuleButton();

    // ルール未設定なら設定パネルを最初に表示（キー未開封時はブロックメッセージ）
    if (!poolRule) {
        openRulePanel();
    }

    // PDF URL 表示（cached = Drive保存済み / retrieved = 外部リンクのみ）
    if ((ref.fulltext_status === 'cached' || ref.fulltext_status === 'retrieved') && ref.fulltext_url) {
        showResolvedUrl(ref.fulltext_url, 'cached');
    } else {
        showPlaceholder('「DOI → URL解決」ボタンをクリックしてOAフルテキストを検索してください。');
    }

    document.getElementById('ft-doi-resolve-btn')
        ?.addEventListener('click', () => { void handleResolve(); });
}

// ---------------------------------------------------------------------------
// フルテキスト候補ルール
// ---------------------------------------------------------------------------

/**
 * 候補リストを再計算する
 * - ルール設定済み: 採用voterのInclude票が必要票数以上の文献
 * - 未設定: 自分が TiAb で Include した文献（レガシー動作）
 */
function recomputeCandidates(): void {
    if (poolRule) {
        const rule = poolRule;
        const byRef = new Map<string, Decision[]>();
        for (const d of allDecisions) {
            const list = byRef.get(d.ref_id);
            if (list) {
                list.push(d);
            } else {
                byRef.set(d.ref_id, [d]);
            }
        }
        fulltextCandidates = allRefs.filter(r => isInFulltextPool(byRef.get(r.ref_id) ?? [], rule));
    } else {
        const myTiabIncludes = new Set(
            allDecisions
                .filter(d =>
                    d.reviewer_id === userEmail &&
                    d.decision === 'include' &&
                    isTiabDecision(d)
                )
                .map(d => d.ref_id)
        );
        fulltextCandidates = allRefs.filter(r => myTiabIncludes.has(r.ref_id));
    }
    currentCandidateIndex = currentRef
        ? fulltextCandidates.findIndex(r => r.ref_id === currentRef!.ref_id)
        : -1;
}

function updateRuleButton(): void {
    const btn = document.getElementById('ft-rule-btn');
    if (!btn) return;
    btn.textContent = poolRule
        ? `候補ルール: ${describeRule(poolRule)} ▾`
        : '候補ルール: 未設定 ▾';
}

function wireRulePanel(): void {
    document.getElementById('ft-rule-btn')?.addEventListener('click', () => {
        const section = document.getElementById('ft-rule-section');
        if (section && !section.classList.contains('hidden')) {
            section.classList.add('hidden');
        } else {
            openRulePanel();
        }
    });
}

function openRulePanel(): void {
    const section = document.getElementById('ft-rule-section');
    const container = document.getElementById('ft-rule-editor-container');
    if (!section || !container) return;

    section.classList.remove('hidden');

    mountRuleEditor({
        container,
        references: allRefs,
        decisions: allDecisions,
        currentRule: poolRule,
        keyOpened,
        onSave: async (rule) => {
            await saveFulltextPoolRule(spreadsheetId, rule);
            poolRule = rule;
            recomputeCandidates();
            renderProgress();
            updateRuleButton();
            section.classList.add('hidden');
        },
        onClose: () => section.classList.add('hidden'),
    });
}

// ---------------------------------------------------------------------------
// 決断パネル
// ---------------------------------------------------------------------------

function renderDecisionPanel(): void {
    // 現在の決断状態をボタンに反映
    updateDecisionButtons();
    // 除外理由エリアの表示制御
    updateReasonArea();
    // 保存ボタンの表示
    updateSaveButton();
}

function wireDecisionButtons(): void {
    document.getElementById('ft-btn-include')?.addEventListener('click', () => {
        pendingDecision = 'include';
        renderDecisionPanel();
    });
    document.getElementById('ft-btn-exclude')?.addEventListener('click', () => {
        pendingDecision = 'exclude';
        renderDecisionPanel();
    });
    document.getElementById('ft-btn-maybe')?.addEventListener('click', () => {
        pendingDecision = 'maybe';
        renderDecisionPanel();
    });
    document.getElementById('ft-save-btn')?.addEventListener('click', () => {
        void handleSave();
    });
}

function updateDecisionButtons(): void {
    const states: Array<['include' | 'exclude' | 'maybe', string]> = [
        ['include', 'ft-btn-include'],
        ['exclude', 'ft-btn-exclude'],
        ['maybe', 'ft-btn-maybe'],
    ];
    for (const [val, id] of states) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        if (pendingDecision === val) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }
}

function updateReasonArea(): void {
    const area = document.getElementById('ft-reason-area');
    if (!area) return;
    if (pendingDecision === 'exclude') {
        area.classList.remove('hidden');
        // 既存の理由を復元
        if (existingDecision?.decision.decision === 'exclude') {
            const select = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
            const note = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;
            if (select && existingDecision.decision.reason) {
                select.value = existingDecision.decision.reason;
            }
            if (note && existingDecision.decision.note) {
                note.value = existingDecision.decision.note;
            }
        }
    } else {
        area.classList.add('hidden');
    }
}

function updateSaveButton(): void {
    const btn = document.getElementById('ft-save-btn');
    if (!btn) return;
    if (pendingDecision) {
        btn.classList.remove('hidden');
    } else {
        btn.classList.add('hidden');
    }
}

async function handleSave(): Promise<void> {
    if (!currentRef || !pendingDecision) return;

    const saveBtn = document.getElementById('ft-save-btn') as HTMLButtonElement | null;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const reasonSelect = document.getElementById('ft-reason-select') as HTMLSelectElement | null;
        const reasonNote = document.getElementById('ft-reason-note') as HTMLTextAreaElement | null;

        const decisionObj: Decision = {
            decision_id: existingDecision?.decision.decision_id ?? crypto.randomUUID(),
            ref_id: currentRef.ref_id,
            reviewer_id: userEmail,
            decision: pendingDecision,
            reason: pendingDecision === 'exclude' ? (reasonSelect?.value || undefined) : undefined,
            note: reasonNote?.value || undefined,
            decided_at: new Date().toISOString(),
            client_version: getClientVersion('-human'),
            source_url: window.location.href,
            screening_phase: 'fulltext',
        };

        await saveDecision(spreadsheetId, decisionObj);

        // 保存成功: existingDecision を更新
        if (existingDecision) {
            existingDecision.decision = decisionObj;
        } else {
            existingDecision = { decision: decisionObj, rowIndex: -1 };
        }

        showFeedback('保存しました');
    } catch (err) {
        showFeedback(`保存失敗: ${(err as Error).message}`, true);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    }
}

function showFeedback(msg: string, isError = false): void {
    const saveBtn = document.getElementById('ft-save-btn');
    if (!saveBtn) return;
    const feedback = document.createElement('span');
    feedback.textContent = ` ${msg}`;
    feedback.style.cssText = `font-size:12px;margin-left:8px;color:${isError ? '#e74c3c' : '#27ae60'}`;
    saveBtn.insertAdjacentElement('afterend', feedback);
    setTimeout(() => feedback.remove(), 3000);
}

// ---------------------------------------------------------------------------
// ナビゲーション
// ---------------------------------------------------------------------------

function wireNavButtons(): void {
    document.getElementById('ft-prev-btn')?.addEventListener('click', () => navigate(-1));
    document.getElementById('ft-next-btn')?.addEventListener('click', () => navigate(1));
}

function navigate(delta: number): void {
    if (fulltextCandidates.length === 0) return;
    const newIndex = (currentCandidateIndex + delta + fulltextCandidates.length) % fulltextCandidates.length;
    const nextRef = fulltextCandidates[newIndex];
    if (!nextRef) return;

    const url = new URL(window.location.href);
    url.searchParams.set('ref_id', nextRef.ref_id);
    window.location.href = url.toString();
}

// ---------------------------------------------------------------------------
// OA URL 解決
// ---------------------------------------------------------------------------

async function handleResolve(): Promise<void> {
    if (!currentRef) return;

    const btn = document.getElementById('ft-doi-resolve-btn') as HTMLButtonElement | null;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '検索中...';
    }

    showPlaceholder('OAソースを順番に検索中...\nPMC OA → Europe PMC → Unpaywall → OpenAlex');

    try {
        const candidate = await retrieveFulltextUrl(
            { doi: currentRef.doi, pmid: currentRef.pmid },
            userEmail
        );

        if (candidate) {
            showResolvedUrl(candidate.url, candidate.source);
            // References タブに URL を保存（非同期・失敗しても続行）
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, candidate.url, 'retrieved')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        } else {
            showPlaceholder(
                'フルテキストが見つかりませんでした。\n' +
                '（すべての無料OAソースに存在しない可能性があります）'
            );
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, '', 'unavailable')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        }
    } catch (err) {
        showPlaceholder(`取得エラー: ${(err as Error).message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'DOI → URL解決';
        }
    }
}

// ---------------------------------------------------------------------------
// タブアタッチ（URL手入力）
// ---------------------------------------------------------------------------

function wireAttachTabButton(): void {
    document.getElementById('ft-attach-tab-btn')?.addEventListener('click', () => {
        const url = window.prompt('PDFのURLを入力してください（現在のタブのURLをコピーして貼り付けてください）:');
        if (!url) return;
        showResolvedUrl(url, 'cached');
        if (currentRef) {
            updateReferenceFulltextUrl(spreadsheetId, currentRef.ref_id, url, 'retrieved')
                .catch(err => console.warn('[fulltext] URL 保存失敗:', err));
        }
    });
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

function renderRefMeta(ref: Reference): void {
    const el = document.getElementById('ft-ref-meta');
    if (!el) return;
    const parts: string[] = [];
    if (ref.title) {
        parts.push(ref.title.length > 80 ? ref.title.substring(0, 80) + '…' : ref.title);
    }
    if (ref.year) parts.push(String(ref.year));
    if (ref.journal) parts.push(ref.journal);
    el.textContent = parts.join(' · ');
}

function renderProgress(): void {
    const el = document.getElementById('ft-progress');
    if (!el) return;
    if (fulltextCandidates.length === 0) {
        el.textContent = '';
        return;
    }
    if (currentCandidateIndex === -1) {
        // この文献は現在の候補条件に含まれていない（判定・保存は可能）
        el.textContent = `候補外（候補 ${fulltextCandidates.length}件）`;
        return;
    }
    el.textContent = `${currentCandidateIndex + 1} / ${fulltextCandidates.length}`;
}

function showPlaceholder(msg: string): void {
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        placeholder.innerHTML = msg.replace(/\n/g, '<br>');
    }
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.innerHTML = '';
}

function showResolvedUrl(url: string, source: OaSource | 'cached'): void {
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        placeholder.innerHTML =
            `<span class="ft-source-badge">${sourceLabel}</span>` +
            `フルテキストURLが見つかりました。<br>` +
            `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ft-pdf-link">${url}</a>`;
        placeholder.style.display = '';
    }

    const label = document.getElementById('ft-pdf-url-label');
    if (label) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        label.innerHTML =
            `<span class="ft-source-badge">${sourceLabel}</span>` +
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    }
}
