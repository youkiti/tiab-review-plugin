// session.ts - ページの可変状態と世代を保持する。
// 他の画面モジュールから共有し、処理の呼び出しは持たない。
// PDF関連の参照は既存レンダラの型だけを使用する。

import type { ExcludeReasonItem } from '../lib/exclude-reasons';
import { resolveExcludeReasonItems } from '../lib/exclude-reason-config';
import type { ReviewCriteria } from '../lib/review-criteria';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import { createDefaultFulltextAssignment } from '../lib/fulltext-assignment';
import type { FulltextAssignmentConfig } from '../lib/fulltext-assignment';
import type { Reference, Decision } from '../lib/types';
import type { FulltextEvidenceDisplay } from '../lib/sheets-api';
import type { PdfRenderer } from './pdf-renderer';
import type { LoadedPdf, HighlightCategory } from './pdf-renderer';

export const session = {
    // ページ状態
    currentRef: null as Reference | null,
    userEmail: '',
    spreadsheetId: '',
    // 全文献・全判定（候補計算とルールUIで使用）
    allRefs: [] as Reference[],
    allDecisions: [] as Decision[],
    // フルテキスト候補ルール（Configシート共有設定、未設定はnull）
    poolRule: null as FulltextPoolRule | null,
    // フルテキスト担当割り振り（Configシート共有設定、未設定は status 'none' = 全員が全候補）
    ftAssignment: createDefaultFulltextAssignment() as FulltextAssignmentConfig,
    // サイドパネルの担当セットフィルタで選択されたセット（起動時に一度だけ読む。以後の追従は不要）
    selectedFulltextSets: new Set() as Set<string>,
    keyOpened: false,
    // 採用中のフルテキストAI判定ラウンド（reviewer_id）。サマリ/ハイライトはこのラウンドを優先する。
    aiActiveRound: null as string | null,
    // フルテキスト除外理由リスト（Config タブ fulltext_exclude_reasons）。
    // 未設定なら既定のPICO7区分。サイドパネルのフルテキストタブで管理者が編集する。
    excludeReasonItems: resolveExcludeReasonItems(null) as readonly ExcludeReasonItem[],
    // レビュー基準（組入・除外基準、Config タブ review_criteria）。
    // このページは閲覧専用（編集はサイドパネルに一本化）。読み込み時に一度だけ取得し、
    // 追加のAPIリクエストは発生させない（getFulltextPageData の1リクエストに乗せる）。
    reviewCriteria: null as ReviewCriteria | null,
    // 現在ユーザーが管理者（編集権限）か。AI判定の開示トグルを出すかの判定に使う。
    isAdmin: false,
    // AI判定（サマリ・evidenceハイライト・根拠カード）を開示するか。
    // ブラインド情報のため、ブラインド解除(keyOpened) かつ 管理者 のときのみ既定で開示。
    // 管理者は画面内トグルで切り替えられる。非管理者には一切表示しない。
    aiReveal: false,
    // ブラインド中のAI evidence 表示レベル（Config共有設定 fulltext_evidence_display）。
    // none: evidence非表示 / neutral: 単色・polarityなし / full: 色分け・polarityあり
    evidenceDisplay: 'neutral' as FulltextEvidenceDisplay,
    // フルテキスト候補リスト
    fulltextCandidates: [] as Reference[],
    // 担当セットのチェックボックス絞り込み適用前の候補数（renderProgress の空理由判定用）
    candidateCountBeforeSetFilter: 0,
    currentCandidateIndex: -1,
    // 先読みしたPDF（ref_id → 先読みエントリ）。隣接候補を事前取得し遷移を高速化する。
    // エントリの中身・ライフサイクル管理（ファイルID照合・中止・バイト上限・同時実行数上限）は
    // pdf-prefetch.ts に集約する（このモジュールは状態の保持のみを持つ）。
    pdfPrefetch: new Map<string, PdfPrefetchEntry>(),
    // ページ内遷移トークン。非同期PDF取得中に別の文献へ移った場合の遅延描画（取り違え）を防ぐ。
    loadToken: 0,
    // キー状態変更（blind:key-changed）に伴う再取得の取り違え防止用トークン。
    // loadToken（文献遷移用）とは別枠。連続でキーを切り替えたとき、古いキー開放の
    // 再取得が後から返ってきて新しい状態を上書きしないようにする。
    keyChangeToken: 0,
    // 現在の決断パネル状態
    pendingDecision: null as 'include' | 'exclude' | 'maybe' | null,
    existingDecision: null as { decision: Decision; rowIndex: number } | null,
    // 除外理由 select をポインタ（マウス/タッチ）で操作中かどうか。
    // リストボックス（size付きselect）はクリックでも change が発火するため、
    // 「クリック選択 → 保存して次へ」と「↑↓キーでのブラウズ → 保存のみ」を
    // 区別するのに使う。
    reasonPointerDown: false,
    // 今回のポインタ操作中に理由の値が変わったかどうか。
    // select の外で離した（クリック不成立）場合に、表示と保存を一致させる
    // 保存だけを行うための判定に使う。
    reasonChangedByPointer: false,
    // ハイライト表示状態（このアプリはスクリーニング用ハイライトのみ。デフォルトON）
    highlightEnabled: true,
    // PDF.js レンダラ（cached PDF をテキストレイヤー付きで描画する）。
    // 初回利用時に生成し、文献遷移ごとに loadPdf で描き直す。
    pdfRenderer: null as PdfRenderer | null,
    // 現在表示中PDFのメタ（scanned判定など）。ハイライト戦略の出し分けに使う。
    currentPdfInfo: null as LoadedPdf | null,
    // registration行のスナップショット表示中でも「別のPDFをアップロード」「PDFを削除」の
    // ラベルを差し替えられるよう、HTMLの既定ラベルを初回呼び出し時に記憶しておく
    // （updateToolbarMode() 参照）。
    defaultReplaceBtnLabel: null as string | null,
    defaultDeleteBtnLabel: null as string | null,
    feedbackTimer: undefined as number | undefined,
    autoCloseTimer: undefined as number | undefined,
    // アップロード中の二重実行ガード（ボタン連打・ドロップ重複対策）
    uploadInProgress: false,
    // 表示中のPDF blob URL（解放用）
    currentPdfObjectUrl: null as string | null,
    // 表示中の根拠カード一覧と n/p ジャンプ用のカーソル位置。
    // renderAnnotationsList のたびに一覧を差し替え、カーソルは先頭前（-1）へ戻す。
    evidenceItems: [] as HighlightListItem[],
    evidenceCursor: -1,
};

/**
 * 現在のAI evidence の実効表示レベル。
 * 開示中（aiReveal）は常に full。ブラインド中はプロジェクト共有設定に従う。
 * polarity（組入/除外の色・ラベル）の並びからAI判断が推測できてしまうため、
 * ブラインド中は既定（neutral）で polarity を伏せる。
 */
export function effectiveEvidenceLevel(): FulltextEvidenceDisplay {
    return session.aiReveal ? 'full' : session.evidenceDisplay;
}

export function isStale(token: number): boolean {
    return token !== session.loadToken;
}

export interface HighlightListItem {
    id: string;
    category: HighlightCategory;
    quote: string;
    page: number;
    resolved: boolean;
    via: 'text' | 'bbox' | 'none';
}

/**
 * PDF先読み（プリフェッチ）1件分の状態。
 * ref_id → このエントリ、で session.pdfPrefetch に積む（Issue #156 PR3）。
 */
export interface PdfPrefetchEntry {
    /** 先読みを開始した時点の Drive ファイルID。取り出し側はこれと現在のURLのファイルIDを
     *  照合し、不一致なら「PDFが差し替わった（再アップロード等）」とみなしてミス扱いにする。 */
    fileId: string;
    /** 進行中のダウンロードを中止するための AbortController。既に解決済みのエントリに対して
     *  abort() を呼んでも何も起きない（無害）ため、呼び出し側は解決済みかどうかを
     *  気にせず呼んでよい。 */
    controller: AbortController;
    /** ダウンロード結果を返す Promise。失敗（型付きエラー・abort含む）は null に丸めて解決し、
     *  reject はしない（呼び出し側の「先読み失敗→その場で再取得」フォールバックを保つため）。 */
    promise: Promise<Blob | null>;
    /** 解決済みのバイト数（Blob.size。失敗時は0）。Promise解決前は undefined で、
     *  バイト上限の集計対象から外れる（解決するまでサイズが分からないため）。 */
    bytes?: number;
}
