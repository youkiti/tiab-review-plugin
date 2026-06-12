// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// TODO: 実装フェーズ
//   Phase 2: PDF取得 (DOI→Unpaywall / ブラウザタブアタッチ)
//   Phase 3: PDF.js ビュワー + ハイライト保存 (Annotations タブ)
//   Phase 4: 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存)
//   Phase 5: データ抽出モード (label 付きアノテーション)

document.addEventListener('DOMContentLoaded', () => {
    // ページ初期化（スタブ）
    initFulltextPage();
});

function initFulltextPage(): void {
    // ref_id を URL パラメータから取得
    const params = new URLSearchParams(window.location.search);
    const refId = params.get('ref_id') ?? '';

    if (!refId) {
        showPlaceholderMessage('ref_id が指定されていません。サイドパネルから開いてください。');
        return;
    }

    // TODO: chrome.storage.local からプロジェクト設定を読み込み、
    //       Sheets API で Reference と Annotation を取得する

    console.log('[fulltext] init, ref_id =', refId);
    showPlaceholderMessage(`ref_id: ${refId} (実装中)`);
}

function showPlaceholderMessage(msg: string): void {
    const placeholder = document.getElementById('ft-pdf-placeholder');
    if (placeholder) placeholder.textContent = msg;
}
