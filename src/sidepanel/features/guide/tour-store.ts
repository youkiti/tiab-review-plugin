/**
 * ツアーの進行状態の読み書き。保存は platform().storageGet/storageSet のキー `guide_progress`。
 * 状態遷移そのものは lib/guide/tour-progress.ts の純関数が持ち、ここは保持と保存だけを行う。
 * 遅延チャンク `guide-feature` に入る。
 */
import { platform } from '../../../platform';
import {
    GUIDE_PROGRESS_STORAGE_KEY,
    createEmptyGuideProgress,
    parseGuideProgress,
    serializeGuideProgress,
    type GuideProgress,
} from '../../../lib/guide/tour-progress';

let progress: GuideProgress = createEmptyGuideProgress();
let loading: Promise<void> | null = null;
/** 「あとで」を押したか。セッション内だけで、保存しない。 */
let postponed = false;

/** 保存値を読み込む（初回だけ読む）。返すのは常に最新の保持値で、読み込み後の更新も反映している。 */
export async function loadGuideProgress(): Promise<GuideProgress> {
    if (!loading) {
        loading = platform().storageGet([GUIDE_PROGRESS_STORAGE_KEY])
            .then(stored => {
                progress = parseGuideProgress(stored[GUIDE_PROGRESS_STORAGE_KEY]);
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

/** 状態を更新して保存する。保存の失敗は画面を止めない。 */
export function updateGuideProgress(update: (current: GuideProgress) => GuideProgress): void {
    progress = update(progress);
    platform().storageSet({ [GUIDE_PROGRESS_STORAGE_KEY]: serializeGuideProgress(progress) })
        .catch(error => console.warn('[guide] 進行状態の保存に失敗:', error));
}

export function isGuidePostponed(): boolean {
    return postponed;
}

export function postponeGuideSuggestions(): void {
    postponed = true;
}
