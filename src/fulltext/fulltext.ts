// fulltext.ts - フルテキストスクリーニングページのエントリポイント
//
// 実装済み:
//   - DOI/PMID → OA PDF URL 取得、Drive保存(cached)
//   - 決断パネル (screening_phase: 'fulltext' で Decisions タブへ保存) + 候補リストの前後ナビ
//   - PDF.js ビュワー (pdf-renderer.ts): cached PDF をテキストレイヤー付きで描画
//   - AIフルテキスト判定の evidence ハイライト表示（テキストマッチ→bbox→ページ送りの段階縮退）
//     と、判定パネル上部の AI判定サマリ提示（AI票はサイドパネルの「AI判定」タブで一括生成）
// TODO:
//   - 人手アノテーションの作成・Annotations タブへの保存
//   - データ抽出モード (label 付きアノテーション)

// 初期化と依存の接続を担い、各責務の処理は下位モジュールへ委譲する。

import { setPlatform } from '../platform';
import { chromePlatform } from '../platform/chrome';
setPlatform(chromePlatform);

import { getAuthToken, getUserEmail, getFulltextPageData, isUserAdmin } from '../lib/sheets-api';
import { platform } from '../platform';
import { resolveExcludeReasonItems } from '../lib/exclude-reason-config';
import { isDecisionVisibleDuringBlind } from '../lib/blind-visibility';
import { initialSelectedFulltextSets, normalizeStoredFulltextSets } from '../lib/fulltext-assignment';
import {
    showPlaceholder,
    wireSavePdfButton,
    wireSnapshotPrintButton,
    updateToolbarMode,
    setDocumentViewDependencies,
} from './document-view';
import { session } from './session';
import {
    renderReasonOptions,
    wireDecisionButtons,
    setupAiRevealToggle,
    syncAiRevealButton,
    renderDecisionPanel,
    setDecisionControllerDependencies,
} from './decision-controller';
import {
    recomputeCandidates,
    wireNavButtons,
    handleKeydown,
    loadRef,
    renderProgress,
    renderOverallProgress,
    advanceToNext,
} from './navigation';
import { wireReplaceButtons } from './pdf-upload';
import { wireHighlightToggle, refreshEvidenceDisplay } from './evidence-controller';
import { wireCriteriaModal, maybeShowCriteriaNotice, renderContextPanel } from './page-panels';
import { openLinkedInline, setDocumentLoaderDependencies } from './document-loader';
import { showRegistrySnapshot } from './registry-snapshot';
import { clearPdfPrefetch } from './pdf-prefetch';

document.addEventListener('DOMContentLoaded', () => {
    initFulltextPage().catch(err => {
        showPlaceholder(`初期化エラー: ${(err as Error).message}`);
    });
});

// ページを離れる（タブを閉じる／別ページへ移動する）際の後片付け。
// 先読み中のPDFダウンロードが残っていれば中止し、以後の追い出し処理を走らせず即座に空にする。
// hideCanvasContainer()（表示中のPDF.js描画の破棄）はここには使えない: 文献切替のたびに
// 何度も呼ばれる関数で、しかも showCachedPdf() 自身がプレースホルダ表示 → 先読みキャッシュ参照
// の順で呼ぶため、そこで先読み全体を空にすると、参照する直前に自分で先読み結果を消してしまい
// 先読みの効果が常に無効化される。ページ全体の後片付けはここ（pagehide）で行う。
window.addEventListener('pagehide', () => {
    clearPdfPrefetch();
});

async function initFulltextPage(): Promise<void> {
    setDocumentViewDependencies({ openLinkedInline });
    setDocumentLoaderDependencies({ showRegistrySnapshot });
    setDecisionControllerDependencies({ advanceToNext, renderOverallProgress });

    const params = new URLSearchParams(window.location.search);
    const refId = params.get('ref_id') ?? '';

    if (!refId) {
        showPlaceholder('ref_id が指定されていません。サイドパネルから開いてください。');
        return;
    }

    showPlaceholder('読み込み中...');

    // 認証・ユーザー情報
    await getAuthToken();
    session.userEmail = await getUserEmail();

    // プロジェクト設定
    const stored = await chrome.storage.local.get(['spreadsheetId']);
    session.spreadsheetId = (stored.spreadsheetId as string | undefined) ?? '';
    if (!session.spreadsheetId) {
        showPlaceholder('プロジェクトが未設定です。サイドパネルで先にプロジェクトを開いてください。');
        return;
    }

    // 文献一覧・判定一覧・Config共有設定を1リクエストで取得（429対策）
    const { references: refs, decisions: decisionsData, config } = await getFulltextPageData(session.spreadsheetId, session.userEmail);

    session.allRefs = refs;
    session.allDecisions = decisionsData.map(({ decision }) => decision);
    session.poolRule = config.fulltextPoolRule;
    session.ftAssignment = config.fulltextAssignment;
    session.keyOpened = config.keyOpened;
    session.aiActiveRound = config.fulltextAiActiveRound;
    session.reviewCriteria = config.reviewCriteria;
    session.excludeReasonItems = resolveExcludeReasonItems(config.excludeReasonConfig);
    renderReasonOptions();

    // 管理者判定（権限API）。失敗時は安全側で非管理者扱い。
    session.isAdmin = await isUserAdmin(session.spreadsheetId, session.userEmail).catch(() => false);
    // AI「判断」サマリの既定開示: ブラインド解除済み(keyOpened)なら表示。
    // ブラインド中は隠し、管理者だけが画面内トグルで開示できる。
    // ※ evidence ハイライト・根拠カードはブラインド中、共有設定 evidenceDisplay に従って
    //   縮退表示する（既定 neutral: 単色・polarityなし）。開示時のみ色分け・polarityを出す。
    session.aiReveal = session.keyOpened;
    session.evidenceDisplay = config.fulltextEvidenceDisplay;

    // サイドパネルの担当セットフィルタ選択を読み込む（起動時に一度だけ。以後の追従は不要）。
    // このページは拡張専用なので chrome.storage.local を直接読む
    // （サイドパネル側は platform().storageGet/Set 経由で同じキーへ書き込む）。
    try {
        const storedSelection = await chrome.storage.local.get(['selectedFulltextSets']);
        const map = storedSelection.selectedFulltextSets as Record<string, string[]> | undefined;
        const storedForProject = map?.[session.spreadsheetId];
        session.selectedFulltextSets = storedForProject
            ? normalizeStoredFulltextSets(storedForProject, session.ftAssignment, session.userEmail)
            : initialSelectedFulltextSets(session.ftAssignment, session.userEmail);
    } catch (err) {
        console.warn('[fulltext] 担当セットフィルタ選択の読み込みに失敗:', err);
        session.selectedFulltextSets = initialSelectedFulltextSets(session.ftAssignment, session.userEmail);
    }

    session.currentRef = refs.find(r => r.ref_id === refId) ?? null;
    if (!session.currentRef) {
        showPlaceholder(`ref_id "${refId}" が見つかりませんでした。`);
        return;
    }

    // フルテキスト候補リストを計算
    recomputeCandidates();

    // イベントリスナーとルールボタンは一度だけ初期化する
    // （ページ内遷移では再リロードしないため、ここで張った購読がそのまま使われる）。
    wireNavButtons();
    wireDecisionButtons();
    wireSavePdfButton();
    wireReplaceButtons();
    wireSnapshotPrintButton();
    wireHighlightToggle();
    setupAiRevealToggle();
    wireCriteriaModal();
    document.addEventListener('keydown', handleKeydown);

    // サイドパネルでキー状態（Blind開放/復帰）が変わったことを別ウィンドウ間で受け取る。
    // 別ウィンドウでPDF判定画面を開いたままキーがBlindへ戻された場合、購読していないと
    // 古いキー状態のまま他レビュアーの判定を表示し続けてしまう（仕様違反）ため必須。
    platform().onMessage((message) => {
        const msg = message as { type?: string; spreadsheetId?: string; keyOpened?: boolean };
        if (msg?.type === 'blind:key-changed' && msg.spreadsheetId === session.spreadsheetId && typeof msg.keyOpened === 'boolean') {
            applyKeyOpenedChange(msg.keyOpened);
        }
    });

    // 最初の文献を表示
    await loadRef(refId);

    // 案D: 基準が未読または更新後なら自動表示する（表示は完了しているので await せず、失敗しても画面を壊さない）
    maybeShowCriteriaNotice().catch(err =>
        console.error('[fulltext] maybeShowCriteriaNotice error:', err)
    );
}

/**
 * サイドパネルからの blind:key-changed 通知を受けて、キー状態の変更をこのウィンドウへ即座に反映する。
 * ブラインドの線引きはデータ層（getFulltextPageData の filterDecisionsForBlind）・UI層
 * （selectOtherFulltextDecisions）に続く3層目の防御で、これが無いと「キー開放中にPDF画面を
 * 開いたまま、サイドパネルでBlindへ戻す」操作をしたとき、この画面だけ他レビュアーの判定を
 * 出し続けてしまう（文献を移動してもメモリ上のキャッシュから再表示されるため直らない）。
 */
function applyKeyOpenedChange(nextKeyOpened: boolean): void {
    // 連続でキーを切り替えたときに、古いキー開放の再取得応答が後から結果を上書きしないためのトークン
    const token = ++session.keyChangeToken;
    session.keyOpened = nextKeyOpened;

    // 初期化時の「aiReveal = keyOpened」と同じ状態にそろえる。
    // AI判断（evidenceのpolarity＝組入/除外の色・ラベル）はブラインド情報のため、
    // Blindへ戻ったら必ず伏せ直す必要がある（既存のAI開示トグルと同じ3点セット
    // ＝ aiReveal切替 → syncAiRevealButton → 再描画、を通す。管理者は画面内トグルで再度開示できる）。
    session.aiReveal = nextKeyOpened;
    syncAiRevealButton();

    if (!nextKeyOpened) {
        // Blindへ戻る: ネットワーク再取得を待たず、メモリ上の allDecisions から
        // 他レビュアーの人間票・裁定票を同期的に破棄する。再取得を待つ設計にすると、
        // 失敗時に他人の判定が表示されたままになり仕様違反が残ってしまうため。
        session.allDecisions = session.allDecisions.filter(d => isDecisionVisibleDuringBlind(d, session.userEmail));
        redrawAfterKeyChange();
        return;
    }

    // キー開放: この時点ではまだ他レビュアーの票を持っていないため、一旦そのまま再描画してから
    // ベストエフォートで再取得する。失敗しても例外は投げず console.warn に留める。
    redrawAfterKeyChange();
    getFulltextPageData(session.spreadsheetId, session.userEmail)
        .then(({ decisions }) => {
            if (token !== session.keyChangeToken) return; // 取り違え防止: このあと別のキー変更が来ていたら破棄
            session.allDecisions = decisions.map(({ decision }) => decision);
            redrawAfterKeyChange();
        })
        .catch(err => {
            console.warn('[fulltext] blind:key-changed（キー開放）後の再取得に失敗:', err);
        });
}

/**
 * applyKeyOpenedChange 共通の再描画。
 * PDF自体の再読込はしない（loadRef() を呼ぶと Drive からPDFを取り直してしまうため使わない）。
 * 候補ルールは他レビュアーの票を使うため、キー状態が変われば候補集合も変わる
 * （recomputeCandidates() が内部で currentCandidateIndex も currentRef から引き直す）。
 * refreshEvidenceDisplay() も合わせて呼ぶ: aiReveal の切り替えは、既に描画済みの
 * ハイライト矩形・根拠カード一覧（polarityの色分け・ラベル）にも反映しないと、
 * Blindへ戻したのに full レベルの表示が画面に残ってAI判断が読み取れてしまう。
 * currentPdfInfo / currentRef が無ければ内部で早期リターンするため、
 * どの表示経路でも安全に呼べる。
 */
function redrawAfterKeyChange(): void {
    recomputeCandidates();
    renderProgress();
    renderOverallProgress();
    renderDecisionPanel();
    refreshEvidenceDisplay();
    updateToolbarMode();
    if (session.currentRef) renderContextPanel(session.currentRef);
}
