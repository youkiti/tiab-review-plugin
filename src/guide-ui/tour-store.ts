/**
 * ツアーの進行状態の読み書き。保存は platform().storageGet/storageSet のキー `guide_progress`。
 * 状態遷移そのものは lib/guide/tour-progress.ts の純関数が持ち、ここは保持と保存だけを行う。
 * サイドパネルと全文の判定ページは別のバンドルで、それぞれがこのモジュールのコピーと保持値を持つ。
 * 同じ保存値を共有するので、片方が更新したらメッセージで知らせ、もう片方は読み直す（subscribeGuideProgressChange）。
 */
import { platform } from '../platform';
import {
    GUIDE_PROGRESS_STORAGE_KEY,
    createEmptyGuideProgress,
    parseGuideProgress,
    serializeGuideProgress,
    type GuideProgress,
} from '../lib/guide/tour-progress';

/** 別の画面へ「進行状態を保存した」ことを知らせるメッセージの種別 */
const PROGRESS_CHANGED_MESSAGE = 'guide:progress-changed';

let progress: GuideProgress = createEmptyGuideProgress();
let loading: Promise<void> | null = null;
/** 「あとで」を押したか。セッション内だけで、保存しない。 */
let postponed = false;
/** このバンドルの識別子。自分が送ったメッセージを自分で受け取っても読み直さないために付ける */
const instanceId = Math.random().toString(36).slice(2);
let syncWired = false;
const changeListeners = new Set<() => void>();

async function readStored(): Promise<GuideProgress> {
    const stored = await platform().storageGet([GUIDE_PROGRESS_STORAGE_KEY]);
    return parseGuideProgress(stored[GUIDE_PROGRESS_STORAGE_KEY]);
}

/** 別の画面が保存したことを受けて、保存値を読み直し、購読者へ知らせる。 */
function wireExternalSync(): void {
    if (syncWired) return;
    syncWired = true;
    platform().onMessage(message => {
        const received = message as { type?: unknown; source?: unknown } | null;
        if (received?.type !== PROGRESS_CHANGED_MESSAGE || received.source === instanceId) return;
        readStored()
            .then(latest => {
                progress = latest;
                changeListeners.forEach(listener => listener());
            })
            .catch(error => console.warn('[guide] 進行状態の再読み込みに失敗:', error));
    });
}

/** 保存値を読み込む（初回だけ読む）。返すのは常に最新の保持値で、読み込み後の更新も反映している。 */
export async function loadGuideProgress(): Promise<GuideProgress> {
    if (!loading) {
        wireExternalSync();
        loading = readStored()
            .then(stored => {
                progress = stored;
            })
            .catch(error => {
                console.warn('[guide] 進行状態の読み込みに失敗:', error);
            });
    }
    await loading;
    return progress;
}

/** 読み込み済みの値（loadGuideProgress の完了後に使う）。 */
export function getGuideProgress(): GuideProgress {
    return progress;
}

/** 状態を更新して保存する。保存の失敗は画面を止めない。保存できたら、別の画面へ知らせる。 */
export function updateGuideProgress(update: (current: GuideProgress) => GuideProgress): void {
    progress = update(progress);
    platform().storageSet({ [GUIDE_PROGRESS_STORAGE_KEY]: serializeGuideProgress(progress) })
        .then(() => platform().emitMessage({ type: PROGRESS_CHANGED_MESSAGE, source: instanceId }))
        .catch(error => console.warn('[guide] 進行状態の保存に失敗:', error));
}

/** 別の画面が進行状態を更新して、保持値を読み直したときに呼ばれる関数を登録する。解除する関数を返す。 */
export function subscribeGuideProgressChange(listener: () => void): () => void {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
}

export function isGuidePostponed(): boolean {
    return postponed;
}

export function postponeGuideSuggestions(): void {
    postponed = true;
}
