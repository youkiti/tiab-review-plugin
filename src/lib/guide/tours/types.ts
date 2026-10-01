import type { GuideTourId } from '../topics';

/**
 * 全ツアーで共通のイベント名。画面側が投げる、ツアーを進める（または提案する）ためのイベント。
 * 特定のツアーだけが使うイベントは、そのツアーのファイル（tours/<ID>.ts）で型を足す。
 */
export type CommonGuideEventName =
    | 'project-screen-shown' // プロジェクト選択画面が表示された
    | 'project-created' // 新規作成に成功した
    | 'sheet-url-entered' // URL/ID 欄に、解釈できるスプレッドシートIDが入った
    | 'picker-guidance-shown' // 共有シートの初回許可（Googleで許可する）の案内が出た
    | 'project-connected' // プロジェクトに接続し、スクリーニング画面を表示した（新規作成後も含む）
    | 'references-imported' // 文献の取り込みが完了した（1件以上）
    | 'decision-saved' // 手動タブで判定を保存した
    | 'navigated-prev' // 手動タブで前の文献へ移動した
    | 'tab-opened-screening' // 手動タブを開いた（スクリーニング画面に入った）
    | 'tab-opened-ml' // ML タブを開いた
    | 'tab-opened-llm' // AI タブを開いた
    | 'tab-opened-fulltext'; // 全文タブを開いた

/** 全ツアーで共通の、手順の飛ばし判定に使う画面の状態。ツアー固有の条件はそのツアーのファイルで足す。 */
export type CommonGuideCondition =
    | 'on-screening-screen'
    | 'has-references'
    | 'has-assignment-sets'
    | 'no-assignment-sets'
    | 'is-admin';

/** 手順の進め方。events の optional が真なら、イベントが起きなくてもカードの「押さずに次へ」で進める。 */
export type TourAdvance<E extends string> =
    | { type: 'next' }
    | { type: 'events'; events: E[]; optional?: true };

export interface TourStepOf<E extends string, C extends string> {
    id: string;
    /** 強調する要素の data-tour 値 */
    target: string;
    /** JS で後から作られる要素なら true（HTML に静的に無い） */
    dynamicTarget?: boolean;
    /** 本文の i18n キー */
    textKey: string;
    /**
     * 進め方: 'next' は「次へ」ボタン、'events' は列挙したイベントのどれかが起きたら進む。
     * 'events' に optional: true を付けると、イベントが起きれば進むのに加えて、カードに「押さずに次へ」も出す
     * （AI の一括実行、共有の追加など、慎重に扱いたい操作を、押さずに先へ進んでもよい手順にするとき）。
     */
    advance: TourAdvance<E>;
    /** この条件が真ならこの手順を飛ばす */
    skipIf?: C;
    /** 真なら対象の要素を押せないようにする（危険な操作の説明用） */
    blockTarget?: boolean;
    /**
     * 手順に入ったときのスクロールの仕方。省略時は、対象が高ければ上端、そうでなければ画面の中央へ寄せる。
     * 'start': 対象の上端を画面の上端へ寄せる（読ませたい文献カードの先頭を見せる）。
     * 'if-hidden': 対象が画面内に全部見えているならスクロールしない（直前まで読んでいた内容を画面に残す）。
     */
    scroll?: 'start' | 'if-hidden';
}

export interface TourDefinitionOf<E extends string, C extends string> {
    id: GuideTourId;
    titleKey: string;
    descriptionKey: string;
    platforms: ReadonlyArray<'extension' | 'web'>;
    audience: 'admin' | 'participant';
    /** どの画面で動くツアーか。'sidepanel' はサイドパネル、'fulltext' は全文の判定ページ（src/fulltext/） */
    page: 'sidepanel' | 'fulltext';
    /**
     * 真なら、まだ中身の無い枠。GUIDE_TOURS には入るが、一覧・提案・開始・テストの照合の対象から外す
     * （tour-progress.ts の availableTours が除外する）。手順を書き終えたら外す。
     */
    draft?: true;
    /**
     * この条件が真のとき、今の状態ではこのツアーを使えない（一覧・「?」の吹き出し・提案の帯・開始から外す）。
     * 例: 文献が少なくてタブ自体が使えないプロジェクト。実行中のツアーの再開は止めない。
     * 純関数 availableTours などは、条件の値を渡されたときだけ見る。
     */
    unavailableIf?: C;
    /** このイベントが起きたときに、このツアーをまだやっていなければ、その画面の上部に提案の帯を出す。 */
    suggestOn?: E;
    steps: ReadonlyArray<TourStepOf<E, C>>;
}

/**
 * 共通のイベント・条件に、そのツアー固有の分を足した型でツアーを定義する（各ツアーのファイルで使う）。
 * 固有のイベント・条件が無ければ、型引数は省略できる（never）。
 */
export type TourFor<OwnEvent extends string = never, OwnCondition extends string = never> =
    TourDefinitionOf<CommonGuideEventName | OwnEvent, CommonGuideCondition | OwnCondition>;
