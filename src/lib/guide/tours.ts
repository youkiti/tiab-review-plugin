import type { GuideTourId } from './topics';

/** 画面側が投げる、ツアーを進めるためのイベント名。 */
export type GuideEventName =
    | 'project-screen-shown' // プロジェクト選択画面が表示された
    | 'project-created' // 新規作成に成功した
    | 'sheet-url-entered' // URL/ID 欄に、解釈できるスプレッドシートIDが入った
    | 'picker-guidance-shown' // 共有シートの初回許可（Googleで許可する）の案内が出た
    | 'project-connected' // プロジェクトに接続し、スクリーニング画面を表示した（新規作成後も含む）
    | 'references-imported' // 文献の取り込みが完了した（1件以上）
    | 'decision-saved' // 手動タブで判定を保存した
    | 'navigated-prev'; // 手動タブで前の文献へ移動した

/** 手順の飛ばし判定に使う、画面の状態。 */
export type GuideCondition =
    | 'on-screening-screen'
    | 'has-references'
    | 'has-assignment-sets'
    | 'no-assignment-sets'
    | 'is-admin';

export interface TourStep {
    id: string;
    /** 強調する要素の data-tour 値 */
    target: string;
    /** JS で後から作られる要素なら true（HTML に静的に無い） */
    dynamicTarget?: boolean;
    /** 本文の i18n キー */
    textKey: string;
    /** 進め方: 'next' は「次へ」ボタン、'events' は列挙したイベントのどれかが起きたら進む */
    advance: { type: 'next' } | { type: 'events'; events: GuideEventName[] };
    /** この条件が真ならこの手順を飛ばす */
    skipIf?: GuideCondition;
    /** 真なら対象の要素を押せないようにする（危険な操作の説明用） */
    blockTarget?: boolean;
    /**
     * 手順に入ったときのスクロールの仕方。省略時は、対象が高ければ上端、そうでなければ画面の中央へ寄せる。
     * 'start': 対象の上端を画面の上端へ寄せる（読ませたい文献カードの先頭を見せる）。
     * 'if-hidden': 対象が画面内に全部見えているならスクロールしない（直前まで読んでいた内容を画面に残す）。
     */
    scroll?: 'start' | 'if-hidden';
}

export interface TourDefinition {
    id: GuideTourId;
    titleKey: string;
    descriptionKey: string;
    platforms: ReadonlyArray<'extension' | 'web'>;
    audience: 'admin' | 'participant';
    steps: ReadonlyArray<TourStep>;
}

/** ツアー ID と手順 ID から i18n キーの共通部分を作る（ハイフンはアンダースコア）。 */
function tourKeyBase(prefix: string, tourId: string): string {
    return `${prefix}${tourId.replace(/-/g, '_')}`;
}

function stepKey(base: string, stepId: string): string {
    return `${base}_${stepId.replace(/-/g, '_')}`;
}

// ツアー1は拡張版専用。Web 版ビルドが `guideExt_` 接頭辞のキーを落とすので、その接頭辞に揃える。
const FIRST_PROJECT_BASE = tourKeyBase('guideExt_tour_', 'first-project');
const JOIN_PROJECT_BASE = tourKeyBase('guide_tour_', 'join-project');

export const GUIDE_TOURS: Record<GuideTourId, TourDefinition> = {
    'first-project': {
        id: 'first-project',
        titleKey: `${FIRST_PROJECT_BASE}_title`,
        descriptionKey: `${FIRST_PROJECT_BASE}_desc`,
        platforms: ['extension'],
        audience: 'admin',
        steps: [
            {
                id: 'project-create',
                target: 'create-project',
                textKey: stepKey(FIRST_PROJECT_BASE, 'project-create'),
                advance: { type: 'events', events: ['project-created'] },
                skipIf: 'on-screening-screen',
            },
            {
                id: 'import',
                target: 'import',
                textKey: stepKey(FIRST_PROJECT_BASE, 'import'),
                advance: { type: 'events', events: ['references-imported'] },
                skipIf: 'has-references',
            },
            {
                id: 'read',
                target: 'reference-card',
                textKey: stepKey(FIRST_PROJECT_BASE, 'read'),
                advance: { type: 'next' },
                scroll: 'start',
            },
            {
                id: 'decide',
                target: 'decision-buttons',
                textKey: stepKey(FIRST_PROJECT_BASE, 'decide'),
                advance: { type: 'events', events: ['decision-saved'] },
                scroll: 'if-hidden',
            },
            {
                id: 'go-back',
                target: 'prev',
                textKey: stepKey(FIRST_PROJECT_BASE, 'go-back'),
                advance: { type: 'events', events: ['navigated-prev'] },
            },
            {
                id: 'redecide',
                target: 'decision-buttons',
                textKey: stepKey(FIRST_PROJECT_BASE, 'redecide'),
                advance: { type: 'events', events: ['decision-saved'] },
                scroll: 'if-hidden',
            },
            {
                id: 'blind',
                target: 'blind',
                textKey: stepKey(FIRST_PROJECT_BASE, 'blind'),
                advance: { type: 'next' },
                blockTarget: true,
            },
            {
                id: 'finish',
                target: 'tour-list',
                textKey: stepKey(FIRST_PROJECT_BASE, 'finish'),
                advance: { type: 'next' },
            },
        ],
    },
    'join-project': {
        id: 'join-project',
        titleKey: `${JOIN_PROJECT_BASE}_title`,
        descriptionKey: `${JOIN_PROJECT_BASE}_desc`,
        platforms: ['extension', 'web'],
        audience: 'participant',
        steps: [
            {
                id: 'paste-url',
                target: 'sheet-url',
                textKey: stepKey(JOIN_PROJECT_BASE, 'paste-url'),
                advance: { type: 'events', events: ['sheet-url-entered'] },
                skipIf: 'on-screening-screen',
            },
            {
                id: 'connect',
                target: 'connect',
                textKey: stepKey(JOIN_PROJECT_BASE, 'connect'),
                advance: { type: 'events', events: ['project-connected', 'picker-guidance-shown'] },
                skipIf: 'on-screening-screen',
            },
            {
                id: 'allow',
                target: 'picker-open',
                dynamicTarget: true,
                textKey: stepKey(JOIN_PROJECT_BASE, 'allow'),
                advance: { type: 'events', events: ['project-connected'] },
                skipIf: 'on-screening-screen',
            },
            {
                id: 'assignment',
                target: 'assignment-sets',
                textKey: stepKey(JOIN_PROJECT_BASE, 'assignment'),
                advance: { type: 'next' },
                skipIf: 'no-assignment-sets',
            },
            {
                id: 'read',
                target: 'reference-card',
                textKey: stepKey(JOIN_PROJECT_BASE, 'read'),
                advance: { type: 'next' },
                scroll: 'start',
            },
            {
                id: 'decide',
                target: 'decision-buttons',
                textKey: stepKey(JOIN_PROJECT_BASE, 'decide'),
                advance: { type: 'events', events: ['decision-saved'] },
                scroll: 'if-hidden',
            },
            {
                id: 'finish',
                target: 'tour-list',
                textKey: stepKey(JOIN_PROJECT_BASE, 'finish'),
                advance: { type: 'next' },
            },
        ],
    },
};

export const GUIDE_TOUR_IDS = Object.keys(GUIDE_TOURS) as GuideTourId[];

export function isGuideTourId(value: unknown): value is GuideTourId {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GUIDE_TOURS, value);
}
