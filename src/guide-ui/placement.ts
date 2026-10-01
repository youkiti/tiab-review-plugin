/**
 * ツアーのカードの配置計算（純関数）。DOM・platform には依存せず、tests/guide-placement.test.ts が固定する。
 * 実際の要素の寸法を測って渡し、返った位置を style に入れるのは tour-runner.ts が行う。
 */

export interface Size {
    width: number;
    height: number;
}

/** 画面（ビューポート）内の座標で表した箱 */
export interface Box {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export interface CardPlacementInput {
    viewport: Size;
    card: Size;
    /** 強調する対象。見えない（無い）ときは null */
    target: Box | null;
    /** 画面端の余白 */
    margin: number;
    /** カードと対象の間隔 */
    gap: number;
    /** 強調の枠が対象より外へ広がる量 */
    pad: number;
    /**
     * 真なら、対象の下にも上にも収まらないとき、画面下端へ固定する（対象に重なる）前に、対象の左→右の
     * 横に収まる場所を探す（画面が広く、対象が縦に長いとき）。省略時は偽で、従来どおり画面下端へ固定する。
     */
    allowSide?: boolean;
}

export interface CardPosition {
    left: number;
    top: number;
}

function clamp(value: number, min: number, max: number): number {
    // max < min（カードが画面より大きい）ときは min を優先する
    return Math.max(min, Math.min(value, max));
}

/** 画面内に収まる top。カードが画面より高ければ margin。 */
function clampTop(top: number, viewport: Size, card: Size, margin: number): number {
    return clamp(top, margin, viewport.height - card.height - margin);
}

function clampLeft(left: number, viewport: Size, card: Size, margin: number): number {
    return clamp(left, margin, viewport.width - card.width - margin);
}

function intersectsViewport(box: Box, viewport: Size): boolean {
    return box.bottom > 0 && box.top < viewport.height && box.right > 0 && box.left < viewport.width;
}

/**
 * 対象の下→上→（allowSide なら左→右）→画面下端の順に、収まる場所へカードを置く。対象が無い・画面の外にあるときは
 * 画面下端の中央に固定する。結果は常に画面内（top は [margin, 高さ - カード高 - margin]）に収める。
 */
export function computeTourCardPosition(input: CardPlacementInput): CardPosition {
    const { viewport, card, target, margin, gap, pad, allowSide } = input;
    const bottomFixed = clampTop(viewport.height - card.height - margin, viewport, card, margin);
    if (!target || !intersectsViewport(target, viewport)) {
        return { left: clampLeft((viewport.width - card.width) / 2, viewport, card, margin), top: bottomFixed };
    }
    const left = clampLeft(target.left, viewport, card, margin);
    let top = target.bottom + pad + gap;
    if (top + card.height > viewport.height - margin) {
        const above = target.top - pad - gap - card.height;
        if (above >= margin) {
            top = above;
        } else {
            const side = allowSide ? placeBeside(target, input) : null;
            if (side) return side;
            top = bottomFixed;
        }
    }
    return { left, top: clampTop(top, viewport, card, margin) };
}

/** 対象の左、無ければ右の横に、カードを対象の上端にそろえて置く。どちらにも収まらなければ null。 */
function placeBeside(target: Box, input: CardPlacementInput): CardPosition | null {
    const { viewport, card, margin, gap, pad } = input;
    const top = clampTop(target.top - pad, viewport, card, margin);
    const leftOf = target.left - pad - gap - card.width;
    if (leftOf >= margin) return { left: leftOf, top };
    const rightOf = target.right + pad + gap;
    if (rightOf + card.width <= viewport.width - margin) return { left: rightOf, top };
    return null;
}

export interface ModalWaitInput {
    viewport: Size;
    /** 通常表示のカードの寸法 */
    card: Size;
    /** 小さい表示にしたときのカードの寸法 */
    compactCard: Size;
    dialog: { top: number; bottom: number } | null;
    footer: { top: number; bottom: number } | null;
    margin: number;
    gap: number;
}

export interface ModalWaitPosition extends CardPosition {
    /** true なら小さい表示（クリックを通す・本文1行）にする。top/left はその寸法での位置 */
    compact: boolean;
}

/**
 * ダイアログ待ちのカードの位置。ダイアログの下→上に収まればそこへ（通常表示）。どちらにも収まらないときは
 * 小さい表示にして左寄せで置き、ダイアログのフッター（ボタン）と重ならない位置を選ぶ。
 */
export function computeModalWaitPosition(input: ModalWaitInput): ModalWaitPosition {
    const { viewport, card, compactCard, dialog, footer, margin, gap } = input;
    const centeredLeft = clampLeft((viewport.width - card.width) / 2, viewport, card, margin);
    const bottomTop = clampTop(viewport.height - card.height - margin, viewport, card, margin);
    if (!dialog) return { left: centeredLeft, top: bottomTop, compact: false };
    if (bottomTop >= dialog.bottom + gap) return { left: centeredLeft, top: bottomTop, compact: false };
    if (margin + card.height <= dialog.top - gap) return { left: centeredLeft, top: margin, compact: false };

    const left = margin;
    const candidates = [margin];
    if (footer) {
        candidates.push(footer.bottom + gap, footer.top - gap - compactCard.height);
    }
    const fits = (top: number): boolean => top >= margin && top + compactCard.height <= viewport.height - margin;
    const clear = (top: number): boolean => !footer
        || top + compactCard.height + gap <= footer.top
        || top >= footer.bottom + gap;
    const top = candidates.find(candidate => fits(candidate) && clear(candidate)) ?? margin;
    return { left, top, compact: true };
}

export interface InDialogPlacementInput extends CardPlacementInput {
    /** 小さい表示にしたときのカードの寸法 */
    compactCard: Size;
    /** 対象があるダイアログのフッター（ボタン列）。無ければ null */
    footer: { top: number; bottom: number } | null;
}

/**
 * 対象がアプリのダイアログの中にあるときのカードの位置。通常は computeTourCardPosition と同じ（対象の下→上→画面下端）。
 * それがダイアログのフッターのボタンに重なるときは、小さい表示（クリックを下へ通す）に切り替えて、フッターに重ならない位置へ置く。
 */
export function computeInDialogCardPosition(input: InDialogPlacementInput): ModalWaitPosition {
    const { viewport, card, compactCard, footer, margin, gap } = input;
    const normal = computeTourCardPosition(input);
    const overlapsFooter = (top: number, height: number): boolean =>
        footer !== null && top < footer.bottom && top + height > footer.top;
    if (!overlapsFooter(normal.top, card.height)) return { ...normal, compact: false };

    const small = computeTourCardPosition({ ...input, card: compactCard });
    const candidates = [small.top, margin];
    if (footer) candidates.push(footer.bottom + gap, footer.top - gap - compactCard.height);
    const fits = (top: number): boolean => top >= margin && top + compactCard.height <= viewport.height - margin;
    const top = candidates.find(candidate => fits(candidate) && !overlapsFooter(candidate, compactCard.height)) ?? small.top;
    return { left: top === small.top ? small.left : margin, top, compact: true };
}
