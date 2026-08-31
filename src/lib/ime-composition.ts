/**
 * IME（日本語入力）変換中のキーイベントを判定するヘルパー。
 *
 * 日本語入力では「変換の確定」に Enter を使う。この確定用の Enter も
 * keydown / keypress としてページに飛んでくるため、Enter を
 * 「保存して次へ」「キーワード追加」などのアクションに割り当てている
 * 入力欄では、変換を確定しただけでアクションが走ってしまう
 * （例: フルテキストの補足メモを書いている途中で次の文献に進む）。
 *
 * 入力欄で Enter を扱うハンドラは、必ず先頭でこの関数を呼び、
 * 変換中のキーは読み飛ばすこと。
 */

/** keydown / keypress イベントのうち、IME 判定に必要な部分だけを見る型 */
export interface ImeKeyEventLike {
    /** 変換中に true（DOM Level 3。Chrome では確定用 Enter の keydown で true） */
    isComposing?: boolean;
    /** 変換中のキーは keyCode 229 になる（isComposing を持たない環境向けの保険） */
    keyCode?: number;
}

/**
 * このキーイベントが IME 変換中のもの（＝アクションを起こしてはいけない）かどうか。
 *
 * @param e         判定するキーイベント
 * @param composing compositionstart / compositionend で自前に追跡している変換状態。
 *                  isComposing を立てない IME への保険として渡す（省略可）
 */
export function isImeComposing(e: ImeKeyEventLike, composing = false): boolean {
    if (composing) return true;
    if (e.isComposing === true) return true;
    return e.keyCode === 229;
}
