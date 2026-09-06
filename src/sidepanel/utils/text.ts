/**
 * テキスト処理ユーティリティ
 */

/**
 * HTML エスケープ
 */
export function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 正規表現のエスケープ
 */
export function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * スマートな正規表現のパターン文字列を組み立てる（英単語のみなら単語境界 \b、それ以外は部分一致）。
 * createSmartRegex() と createSmartMatcher() の両方がここを通ることで、
 * パターン生成ロジックを片方だけ直してしまう事故を防ぐ。
 */
function buildSmartPattern(keyword: string): string {
    const escaped = escapeRegex(keyword);

    // 英単語のみの場合、単語境界を使用
    if (/^[a-zA-Z0-9]+$/.test(keyword)) {
        return `\\b${escaped}\\b`;
    }

    // それ以外は部分一致
    return escaped;
}

/**
 * スマートな正規表現作成（英単語は完全一致、それ以外は部分一致）
 *
 * 用途はハイライト表示専用（features/screening/render.ts の highlightText など、マッチ箇所を
 * 全置換する処理）。全置換には String.replace の g フラグが必須なため gi のまま変えないこと。
 *
 * 【絞り込み・件数判定にこの関数を使い回さないこと】g 付き正規表現は
 * RegExp.prototype.test() を呼ぶたびに lastIndex がマッチ位置の直後まで進む。
 * 1本の正規表現インスタンスを複数の文献に対して使い回すと、直前の文献でマッチした
 * 位置より前を探索できなくなり、本来マッチするはずの文献が偽陰性で落ちる
 * （Issue #152（#150 工程1）で判明したタームフィルターAND経路のバグ）。
 * 絞り込み・件数判定には g を含まない createSmartMatcher() を使うこと。
 */
export function createSmartRegex(keyword: string): RegExp {
    return new RegExp(buildSmartPattern(keyword), 'gi');
}

/**
 * 絞り込み・件数判定専用のマッチャー作成（マッチするかどうかだけを見る用途）。
 *
 * createSmartRegex() と同じパターン文字列（buildSmartPattern()）を使うが、
 * フラグは i のみで g を含まない。g を付けないことで RegExp.prototype.test() の
 * lastIndex 副作用を避け、同じマッチャーインスタンスを複数の文献に使い回しても
 * 偽陰性が出ない（Issue #152（#150 工程1））。
 *
 * ハイライトの全置換用途（g が必要）には createSmartRegex() を使うこと。
 */
export function createSmartMatcher(keyword: string): RegExp {
    return new RegExp(buildSmartPattern(keyword), 'i');
}
