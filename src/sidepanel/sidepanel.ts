// Sidepanel スクリプト

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus } from '../lib/types';

// 状態管理
let references: ReferenceWithStatus[] = [];
let currentIndex = 0;
let currentFilter: DecisionStatus | 'all' = 'pending';

// DOM要素
const configSection = document.getElementById('config-section') as HTMLElement;
const screeningSection = document.getElementById('screening-section') as HTMLElement;
const spreadsheetIdInput = document.getElementById('spreadsheet-id') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;

const statusFilter = document.getElementById('status-filter') as HTMLSelectElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;

const refTitle = document.getElementById('ref-title') as HTMLElement;
const refAuthors = document.getElementById('ref-authors') as HTMLElement;
const refYear = document.getElementById('ref-year') as HTMLElement;
const refJournal = document.getElementById('ref-journal') as HTMLElement;
const refAbstract = document.getElementById('ref-abstract') as HTMLElement;
const refDoi = document.getElementById('ref-doi') as HTMLAnchorElement;
const refPmid = document.getElementById('ref-pmid') as HTMLAnchorElement;

const btnInclude = document.getElementById('btn-include') as HTMLButtonElement;
const btnMaybe = document.getElementById('btn-maybe') as HTMLButtonElement;
const btnExclude = document.getElementById('btn-exclude') as HTMLButtonElement;
const excludeReasonGroup = document.getElementById('exclude-reason-group') as HTMLElement;
const excludeReason = document.getElementById('exclude-reason') as HTMLSelectElement;
const noteInput = document.getElementById('note') as HTMLTextAreaElement;

const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const navPosition = document.getElementById('nav-position') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadConfig();
});

function setupEventListeners() {
    // 接続
    connectBtn.addEventListener('click', handleConnect);

    // フィルター
    statusFilter.addEventListener('change', () => {
        currentFilter = statusFilter.value as DecisionStatus | 'all';
        currentIndex = 0;
        renderCurrentReference();
    });

    searchInput.addEventListener('input', () => {
        currentIndex = 0;
        renderCurrentReference();
    });

    // 判定ボタン
    btnInclude.addEventListener('click', () => handleDecision('include'));
    btnMaybe.addEventListener('click', () => handleDecision('maybe'));
    btnExclude.addEventListener('click', () => {
        excludeReasonGroup.classList.remove('hidden');
    });

    excludeReason.addEventListener('change', () => {
        if (excludeReason.value) {
            handleDecision('exclude');
        }
    });

    // ナビゲーション
    btnPrev.addEventListener('click', () => navigate(-1));
    btnNext.addEventListener('click', () => navigate(1));

    // キーボードショートカット
    document.addEventListener('keydown', handleKeydown);
}

function handleKeydown(e: KeyboardEvent) {
    // 入力中は無視
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'i':
            handleDecision('include');
            break;
        case 'm':
            handleDecision('maybe');
            break;
        case 'e':
            excludeReasonGroup.classList.remove('hidden');
            excludeReason.focus();
            break;
        case 'n':
        case 'arrowright':
            navigate(1);
            break;
        case 'p':
        case 'arrowleft':
            navigate(-1);
            break;
    }
}

async function handleConnect() {
    const spreadsheetId = spreadsheetIdInput.value.trim();
    if (!spreadsheetId) {
        alert('スプレッドシートIDを入力してください');
        return;
    }

    try {
        // TODO: Google Sheets APIから文献を取得
        console.log('Connecting to spreadsheet:', spreadsheetId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId });

        // 画面を切り替え
        configSection.classList.add('hidden');
        screeningSection.classList.remove('hidden');

        // サンプルデータで表示（実際はAPIから取得）
        loadSampleData();
        renderCurrentReference();
    } catch (error) {
        console.error('Connection error:', error);
        alert('接続に失敗しました');
    }
}

async function loadConfig() {
    const result = await chrome.storage.local.get(['spreadsheetId']);
    if (result.spreadsheetId) {
        spreadsheetIdInput.value = result.spreadsheetId;
    }
}

function loadSampleData() {
    // サンプルデータ（実際はAPIから取得）
    references = [
        {
            ref_id: '1',
            title: 'Sample Reference Title for Systematic Review',
            abstract: 'This is a sample abstract for testing the screening interface. The abstract would typically contain information about the study methods, results, and conclusions.',
            year: 2024,
            authors: 'Smith J, Doe A, Johnson B',
            journal: 'Journal of Example Studies',
            doi: '10.1234/example.2024',
            status: 'pending',
        },
    ];
}

function getFilteredReferences(): ReferenceWithStatus[] {
    let filtered = references;

    // ステータスフィルター
    if (currentFilter !== 'all') {
        filtered = filtered.filter((r) => r.status === currentFilter);
    }

    // 検索フィルター
    const searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
        filtered = filtered.filter(
            (r) =>
                r.title.toLowerCase().includes(searchTerm) ||
                r.abstract?.toLowerCase().includes(searchTerm)
        );
    }

    return filtered;
}

function renderCurrentReference() {
    const filtered = getFilteredReferences();
    const ref = filtered[currentIndex];

    if (!ref) {
        refTitle.textContent = '文献がありません';
        refAuthors.textContent = '';
        refYear.textContent = '';
        refJournal.textContent = '';
        refAbstract.textContent = '';
        refDoi.classList.add('hidden');
        refPmid.classList.add('hidden');
        navPosition.textContent = '0 / 0';
        return;
    }

    refTitle.textContent = ref.title;
    refAuthors.textContent = ref.authors || '';
    refYear.textContent = ref.year?.toString() || '';
    refJournal.textContent = ref.journal || '';
    refAbstract.textContent = ref.abstract || '(抄録なし)';

    if (ref.doi) {
        refDoi.href = `https://doi.org/${ref.doi}`;
        refDoi.classList.remove('hidden');
    } else {
        refDoi.classList.add('hidden');
    }

    if (ref.pmid) {
        refPmid.href = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}`;
        refPmid.classList.remove('hidden');
    } else {
        refPmid.classList.add('hidden');
    }

    // ナビゲーション更新
    navPosition.textContent = `${currentIndex + 1} / ${filtered.length}`;
    progressText.textContent = `${references.filter((r) => r.status !== 'pending').length} / ${references.length}`;

    // 除外理由をリセット
    excludeReasonGroup.classList.add('hidden');
    excludeReason.value = '';
    noteInput.value = ref.myDecision?.note || '';
}

function navigate(direction: number) {
    const filtered = getFilteredReferences();
    const newIndex = currentIndex + direction;

    if (newIndex >= 0 && newIndex < filtered.length) {
        currentIndex = newIndex;
        renderCurrentReference();
    }
}

async function handleDecision(decision: 'include' | 'exclude' | 'maybe') {
    const filtered = getFilteredReferences();
    const ref = filtered[currentIndex];

    if (!ref) return;

    // exclude時は理由が必要
    if (decision === 'exclude' && !excludeReason.value) {
        excludeReasonGroup.classList.remove('hidden');
        excludeReason.focus();
        return;
    }

    // 判定を更新
    ref.status = decision;
    ref.myDecision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: '', // TODO: 実際のユーザーemailを取得
        decision,
        reason: decision === 'exclude' ? excludeReason.value : undefined,
        note: noteInput.value || undefined,
        decided_at: new Date().toISOString(),
    };

    // TODO: Google Sheets APIに保存
    console.log('Decision saved:', ref.myDecision);

    // 次の文献へ
    navigate(1);
}

export { };
