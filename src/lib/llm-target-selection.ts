/**
 * AI 一括判定（LLMバッチ）の「対象を人間が限定する」機能の純粋ロジック
 *
 * 設計の要点:
 *
 * 1. 対象の決め方は2モードのみ。`'all'`（従来どおり state.references 全体、既定値）と
 *    `'selection'`（担当セット単位＋個別チェックボックスで選んだ ref_id のみ）。
 *    UI（モーダル等）は別レイヤーで実装するため、ここでは選択結果（ref_id の集合）を
 *    受け取って絞り込む・件数を数えるだけの純関数を提供する。
 *
 * 2. 選択済み ref_id は Config シートの1セルにカンマ区切りで保存する想定。
 *    シート直編集で改行・重複・前後空白が混じりうるため、パース／シリアライズの
 *    どちらでも正規化する（parseTargetRefIds → serializeTargetRefIds のラウンドトリップで
 *    常に正規化済みの形に収束する）。
 *
 * 3. 「判定済みかどうか」は llm-batch-target.ts と同じ Run 単位の考え方に従う。
 *    選択モードであっても、これから実行する Run で既に判定済みの ref_id は除外する
 *    （中断からの再開・別 Run での再実行は llm-batch-target.ts 側の挙動を踏襲）。
 *    このモジュール自身は「判定済みか」を判定せず、呼び出し側から isJudged として受け取る。
 *
 * 4. 実行履歴（LLM_Executions）に「どの担当セットを対象にしたか」を残せるよう、
 *    選択された ref_id 群からセットIDを逆引きするヘルパーも提供する。
 *
 * このモジュールは純関数のみで、DOM・state・chrome API に依存しない。
 */

/** AI一括判定の対象の決め方 */
export type LlmTargetMode = 'all' | 'selection';

/** 既定は従来どおり全件対象 */
export const DEFAULT_LLM_TARGET_MODE: LlmTargetMode = 'all';

/**
 * Config の1セルに保存できる ref_id の上限。
 * ref_id は UUID(36字)+区切り1字 ≒ 37字/件、Google Sheets の1セル上限は 50,000 字なので
 * 約1,350件が物理上限。余裕を見て 1,000 件で頭打ちにする。
 */
export const LLM_TARGET_REF_ID_LIMIT = 1000;

/** Config の値を対象モードへ正規化する（不正値は既定へ倒す） */
export function parseLlmTargetMode(raw: string | null | undefined): LlmTargetMode {
    return raw === 'selection' ? 'selection' : DEFAULT_LLM_TARGET_MODE;
}

/**
 * カンマ・改行区切りの ref_id 文字列をパースする。
 * シート直編集で改行が混じりうるため、カンマだけでなく改行も区切りとして受ける。
 * 前後空白の除去・空要素の除去・重複除去を行い、出現順を維持して返す。
 */
export function parseTargetRefIds(raw: string | null | undefined): string[] {
    if (!raw) return [];

    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of raw.split(/[,\n]/)) {
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

/**
 * ref_id 群を Config の1セルに保存する形へシリアライズする。
 * 前後空白の除去・空要素の除去・重複除去のうえカンマ区切り（区切りにスペースは入れない）。
 */
export function serializeTargetRefIds(refIds: Iterable<string>): string {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of refIds) {
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result.join(',');
}

/** 対象選択の判定に必要な文献の最小形 */
export interface TargetSelectionRef {
    ref_id: string;
}

/**
 * refs の並び順を維持したまま、selected に含まれる ref_id の要素だけを返す。
 * selected に含まれるが手元の refs に実在しない ref_id は単に落とす（エラーにしない）。
 */
export function resolveSelectedRefs<T extends TargetSelectionRef>(
    refs: readonly T[],
    selected: ReadonlySet<string>
): T[] {
    return refs.filter(ref => selected.has(ref.ref_id));
}

/** 対象選択の件数内訳（UI表示・実行時のログ用） */
export interface TargetSelectionBreakdown {
    /** 選択されている ref_id の総数 */
    selected: number;
    /** うち手元の refs に実在する件数 */
    available: number;
    /** available のうち、これから実行する Run で判定済みの件数 */
    alreadyJudged: number;
    /** 実際に投げる件数（available - alreadyJudged） */
    planned: number;
}

/**
 * 選択モードでの対象件数の内訳を数える。
 * @param isJudged これから実行する Run で判定済みかどうかを返す関数
 */
export function countTargetSelection<T extends TargetSelectionRef>(
    refs: readonly T[],
    selected: ReadonlySet<string>,
    isJudged: (ref: T) => boolean
): TargetSelectionBreakdown {
    const availableRefs = resolveSelectedRefs(refs, selected);
    const alreadyJudged = availableRefs.filter(isJudged).length;
    return {
        selected: selected.size,
        available: availableRefs.length,
        alreadyJudged,
        planned: availableRefs.length - alreadyJudged,
    };
}

/**
 * setIds に含まれる担当セットに属する ref の ref_id を、refs の並び順で返す。
 * モーダルで「セット単位で選択」した際に、選択済み ref_id 集合へ展開するために使う。
 */
export function collectRefIdsBySet<T extends TargetSelectionRef>(
    refs: readonly T[],
    setIds: ReadonlySet<string>,
    getSetId: (ref: T) => string
): string[] {
    return refs.filter(ref => setIds.has(getSetId(ref))).map(ref => ref.ref_id);
}

/**
 * refs に現れる担当セットIDを重複なく集め、数値混じりの自然順（group-2 < group-10）で
 * 昇順ソートして返す。空文字のセットIDは除外する。
 * 実行履歴（LLM_Executions.target_sets）に「どのセットを対象にしたか」を書くために使う。
 */
export function collectSetIdsForRefs<T extends TargetSelectionRef>(
    refs: readonly T[],
    getSetId: (ref: T) => string
): string[] {
    const setIds = new Set<string>();
    for (const ref of refs) {
        const setId = getSetId(ref);
        if (setId) setIds.add(setId);
    }
    return [...setIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** 選択件数が Config セルの保存上限を超えているか */
export function exceedsTargetRefIdLimit(count: number): boolean {
    return count > LLM_TARGET_REF_ID_LIMIT;
}
