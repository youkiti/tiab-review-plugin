// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// 実装フェーズ:
//   Phase 2 (本ファイル): DOI/PMID → OA PDF URL 取得 (無料ソース: PMC OA → Europe PMC → Unpaywall → OpenAlex)
//   Phase 3 (TODO): PDF.js ビュワー + ハイライト保存 (Annotations タブ)
//   Phase 4 (TODO): 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存)
//   Phase 5 (TODO): データ抽出モード (label 付きアノテーション)

import { getAuthToken, getUserEmail, getReferences } from '../lib/sheets-api';
import { retrieveFulltextUrl } from '../lib/fulltext-retriever';
import type { OaSource } from '../lib/fulltext-retriever';
import type { Reference } from '../lib/types';

const OA_SOURCE_LABELS: Record<OaSource | 'cached', string> = {
    pmc_oa: 'PMC OA',
    europe_pmc: 'Europe PMC',
    unpaywall: 'Unpaywall',
    openalex: 'OpenAlex',
    cached: 'キャッシュ済み',
};

let currentRef: Reference | null = null;
let userEmail = '';

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

    // プロジェクト設定（spreadsheetId）
    const stored = await chrome.storage.local.get(['spreadsheetId']);
    const spreadsheetId = stored.spreadsheetId as string | undefined;
    if (!spreadsheetId) {
        showPlaceholder('プロジェクトが未設定です。サイドパネルで先にプロジェクトを開いてください。');
        return;
    }

    // 文献データを取得
    const refs = await getReferences(spreadsheetId);
    const ref = refs.find(r => r.ref_id === refId) ?? null;
    if (!ref) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }
    currentRef = ref;

    // ヘッダーにメタ情報を表示
    renderRefMeta(ref);

    // すでに取得済みの URL があればそれを表示
    if (ref.fulltext_status === 'retrieved' && ref.fulltext_url) {
        showResolvedUrl(ref.fulltext_url, 'cached');
    } else {
        showPlaceholder('「DOI → URL解決」ボタンをクリックしてOAフルテキストを検索してください。');
    }

    document.getElementById('ft-doi-resolve-btn')
        ?.addEventListener('click', () => { void handleResolve(); });
}

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
        } else {
            showPlaceholder(
                'フルテキストが見つかりませんでした。\n' +
                '（すべての無料OAソースに存在しない可能性があります）'
            );
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

function showPlaceholder(msg: string): void {
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        placeholder.style.display = '';
        // 改行を <br> に変換してセットする
        placeholder.innerHTML = msg.replace(/\n/g, '<br>');
    }
    const label = document.getElementById('ft-pdf-url-label');
    if (label) label.innerHTML = '';
}

function showResolvedUrl(url: string, source: OaSource | 'cached'): void {
    // プレースホルダーを URL 表示に切り替え
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        placeholder.innerHTML =
            `<span class="ft-source-badge">${sourceLabel}</span>` +
            `フルテキストURLが見つかりました。<br>` +
            `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ft-pdf-link">${url}</a>`;
        placeholder.style.display = '';
    }

    // ツールバーにも URL を表示
    const label = document.getElementById('ft-pdf-url-label');
    if (label) {
        const sourceLabel = OA_SOURCE_LABELS[source] ?? source;
        label.innerHTML =
            `<span class="ft-source-badge">${sourceLabel}</span>` +
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    }
}
