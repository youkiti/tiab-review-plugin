// fulltext-checklist-state.ts - フルテキストタブ先頭の「セットアップチェックリスト」の状態判定（純粋関数）
//
// 背景: フルテキストスクリーニング開始時に各レビュアーがつまずく点が3つある
// （実際に研究チームで発生）:
//   1. 自分の担当グループへの絞り込み方が分からない
//   2. 他メンバーがアップロードしたPDFが drive.file スコープの制約で読めない
//      （「読み取り権限を確認」ボタンの存在に気づかない。詳細は AGENTS.md の
//      「drive.file の403/404は『無い』ではなく『このユーザーに未付与』」参照）
//   3. どこまで進んだか分からない
// メール手順書なしで各自が自走できるように、既存の状態から自動判定する。
// DOM/i18n には依存しない（描画は src/sidepanel/features/fulltext-checklist.ts が担う）。

import type { FulltextAssignmentConfig } from './fulltext-assignment';
import { getAvailableFulltextSets, getFulltextSetsForUser } from './fulltext-assignment';

// ---------------------------------------------------------------------------
// 項目1: バージョン（常に情報表示。チェック判定なし）
// ---------------------------------------------------------------------------

export interface FulltextChecklistVersionState {
    visible: boolean;
    version: string;
}

// ---------------------------------------------------------------------------
// 項目2: 担当グループ（割り振り未設定なら非表示。それ以外は常に表示するが判定結果で色を変える）
// ---------------------------------------------------------------------------

/**
 * - 'ok': 選択中の ft-group が自分の担当と完全一致（緑✅）
 * - 'extra': 担当は全て選択されているが担当外も選択されている（赤❌）
 * - 'missing': 担当の一部/全部が選択から外れている（担当外の有無を問わず優先。赤❌）
 * - 'all': 担当グループを持たないユーザー（オーナー等、mySets が空）は情報表示のまま（緑✅）
 */
export type FulltextChecklistGroupKind = 'ok' | 'extra' | 'missing' | 'all';

export interface FulltextChecklistGroupState {
    visible: boolean;
    kind: FulltextChecklistGroupKind;
    /** 自分の担当グループID群（昇順） */
    myGroupIds: string[];
    /** 選択中だが担当外のグループID群（昇順。kind='extra' のとき使う） */
    extraGroupIds: string[];
    /** 担当だが選択から外れているグループID群（昇順。kind='missing' のとき使う） */
    missingGroupIds: string[];
    /** 選択中の ft-group ID群のうち存在しうるグループ（ft-group-1..groupCount）に含まれるものだけ（昇順） */
    selectedGroupIds: string[];
    /** 選択が ft-group-1..groupCount の空でない真部分集合になっているか。kind='all' のときの文言分岐に使う */
    narrowed: boolean;
    /** 現在表示されている候補件数（絞り込み適用後） */
    visibleCount: number;
}

// ---------------------------------------------------------------------------
// 項目3: PDF読み取り権限（regrant機能が無い環境では非表示）
// ---------------------------------------------------------------------------

/**
 * 直近のPDF読み取り権限チェック結果。
 * - 'session': 今回のセッション中に実際に確認した値（信頼できる最新値）
 * - 'persisted': 前回以前のセッションで確認し永続化されていた値（要再確認。
 *   古い結果のまま✅固定にしないため、UI側は freshness を見て文言を変える）
 */
export interface FulltextRegrantKnownResult {
    unreadableCount: number;
    /** チェック時点でDriveに保存済み（cached）だったPDFの総数 */
    totalCachedCount: number;
    checkedAt: string; // ISO 8601
    freshness: 'session' | 'persisted';
}

export type FulltextRegrantChecklistKind = 'unchecked' | 'ok' | 'unreadable' | 'previous';

export interface FulltextChecklistRegrantState {
    visible: boolean;
    kind: FulltextRegrantChecklistKind;
    unreadableCount: number;
    totalCachedCount: number;
    checkedAt: string | null;
}

// ---------------------------------------------------------------------------
// 項目4: 判定進捗
// ---------------------------------------------------------------------------

export interface FulltextChecklistProgressState {
    done: number;
    total: number;
    complete: boolean;
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

export interface FulltextChecklistState {
    version: FulltextChecklistVersionState;
    group: FulltextChecklistGroupState;
    regrant: FulltextChecklistRegrantState;
    progress: FulltextChecklistProgressState;
    /** 表示中の全項目が完了（✅ or 情報のみ）なら true。折りたたみ判定に使う */
    allComplete: boolean;
}

export interface FulltextChecklistInput {
    /** chrome.runtime.getManifest().version 等。取得できなければ null（項目1を非表示にする） */
    version: string | null;
    assignment: FulltextAssignmentConfig;
    selectedFulltextSets: Set<string>;
    userEmail: string;
    /** getVisibleFulltextCandidateList().length（表示中の担当分） */
    visibleCandidateCount: number;
    /** 上記のうち自分のフルテキスト判定が pending 以外の件数 */
    decidedCount: number;
    /** regrant機能（読み取り権限の確認）がこの環境で使えるか（Web版等では false） */
    regrantAvailable: boolean;
    /** 直近のチェック結果（未確認なら null） */
    regrantResult: FulltextRegrantKnownResult | null;
}

/**
 * PDF読み取り権限チェック結果の永続化・セッション記憶キー（アカウント間で共有されないように）。
 *
 * drive.file の可読性はユーザーごとに異なる（AGENTS.md の「drive.file の403/404は…」参照）ため、
 * spreadsheetId だけをキーにすると、同一サイドパネルでアカウントを切り替えたときに
 * 前のアカウントの確認結果（freshness: 'session' の「権限OK」）が新しいアカウントにも
 * 引き継がれてしまう。userEmail を正規化して複合キーに含めることでアカウントごとに分離する。
 */
export function regrantResultKey(spreadsheetId: string, userEmail: string): string {
    return `${spreadsheetId}::${(userEmail || '').trim().toLowerCase()}`;
}

export function computeFulltextChecklistState(input: FulltextChecklistInput): FulltextChecklistState {
    const version = computeVersion(input.version);
    const group = computeGroup(input.assignment, input.selectedFulltextSets, input.userEmail, input.visibleCandidateCount);
    const regrant = computeRegrant(input.regrantAvailable, input.regrantResult);
    const progress: FulltextChecklistProgressState = {
        done: input.decidedCount,
        total: input.visibleCandidateCount,
        complete: input.decidedCount >= input.visibleCandidateCount,
    };

    // 項目1は常に情報表示のみなので折りたたみを妨げない。項目2は赤（extra/missing）なら妨げる。
    // 項目3・4は表示中なら完了必須。
    const allComplete =
        (!group.visible || group.kind === 'ok' || group.kind === 'all') &&
        (!regrant.visible || regrant.kind === 'ok') &&
        progress.complete;

    return { version, group, regrant, progress, allComplete };
}

function computeVersion(version: string | null): FulltextChecklistVersionState {
    return { visible: !!version, version: version ?? '' };
}

function computeGroup(
    assignment: FulltextAssignmentConfig,
    selected: Set<string>,
    userEmail: string,
    visibleCount: number
): FulltextChecklistGroupState {
    if (assignment.status !== 'configured') {
        return {
            visible: false,
            kind: 'all',
            myGroupIds: [],
            extraGroupIds: [],
            missingGroupIds: [],
            selectedGroupIds: [],
            narrowed: false,
            visibleCount,
        };
    }

    // 比較対象は ft-group-* のみ。'unassigned' は非管理者が外せない仕様のため比較から除外する
    // （含めると全員が常に赤になる。src/lib/fulltext-assignment.ts の initialSelectedFulltextSets 参照）
    const availableGroups = getAvailableFulltextSets(assignment, false);
    const selectedGroups = new Set(Array.from(selected).filter((id) => availableGroups.has(id)));
    const selectedGroupIds = Array.from(selectedGroups).sort();
    const narrowed = selectedGroupIds.length > 0 && selectedGroupIds.length < availableGroups.size;

    // Config シート（Googleスプレッドシート）はユーザーが直接編集できるため、reviewerMap に
    // groupCount を超える古いキー（例: groupCount縮小後も残った ft-group-3）が残存しうる。
    // availableGroups との積に絞らないと、存在しないグループが myGroupIds に残り続けて
    // missingGroupIds が永久に解消せず（修復ボタンを押しても赤のまま）になるため絞り込む。
    const mySetsRaw = getFulltextSetsForUser(assignment, userEmail);
    const mySets = new Set(Array.from(mySetsRaw).filter((id) => availableGroups.has(id)));
    const myGroupIds = Array.from(mySets).sort();

    if (mySets.size === 0) {
        // 担当グループを持たないユーザー（オーナー等、または陳腐化した担当キーしか無いユーザー）は情報表示のまま
        return {
            visible: true,
            kind: 'all',
            myGroupIds: [],
            extraGroupIds: [],
            missingGroupIds: [],
            selectedGroupIds,
            narrowed,
            visibleCount,
        };
    }

    const missingGroupIds = myGroupIds.filter((id) => !selectedGroups.has(id)).sort();
    const extraGroupIds = Array.from(selectedGroups).filter((id) => !mySets.has(id)).sort();

    const kind: FulltextChecklistGroupKind =
        missingGroupIds.length > 0 ? 'missing' : extraGroupIds.length > 0 ? 'extra' : 'ok';

    return { visible: true, kind, myGroupIds, extraGroupIds, missingGroupIds, selectedGroupIds, narrowed, visibleCount };
}

function computeRegrant(
    available: boolean,
    result: FulltextRegrantKnownResult | null
): FulltextChecklistRegrantState {
    if (!available) {
        return { visible: false, kind: 'unchecked', unreadableCount: 0, totalCachedCount: 0, checkedAt: null };
    }
    if (!result) {
        return { visible: true, kind: 'unchecked', unreadableCount: 0, totalCachedCount: 0, checkedAt: null };
    }
    if (result.freshness === 'persisted') {
        // 前回確認済みの値だが今回のセッションでは未確認 → ✅固定にせず「前回確認時」扱いにする
        return {
            visible: true,
            kind: 'previous',
            unreadableCount: result.unreadableCount,
            totalCachedCount: result.totalCachedCount,
            checkedAt: result.checkedAt,
        };
    }
    return {
        visible: true,
        kind: result.unreadableCount === 0 ? 'ok' : 'unreadable',
        unreadableCount: result.unreadableCount,
        totalCachedCount: result.totalCachedCount,
        checkedAt: result.checkedAt,
    };
}
