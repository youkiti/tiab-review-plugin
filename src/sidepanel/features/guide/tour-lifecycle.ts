/**
 * ツアー機能の起動点。本体チャンクを読み込んだあとに ./lazy.ts が initGuide() を呼び、
 * 以降は画面側のイベント（emitGuideEvent）をここで受けて、実行中のツアーと入口（提案バナーなど）へ配る。
 * 遅延チャンク `guide-feature` に入る。
 */
import type { GuideEventName } from '../../../lib/guide/tours';
import { handleEntryEvent } from './tour-entry';
import { handleTourEvent, resumeGuideTour } from './tour-runner';

let initialized = false;
let resumed: Promise<void> | null = null;

/** 保存済みの実行中ツアーを一度だけ再開する。イベント処理はこの完了を待つ。 */
export function resumeGuide(): Promise<void> {
    if (!resumed) resumed = resumeGuideTour();
    return resumed;
}

/** 画面側のイベントを、実行中のツアーと入口の両方へ渡す。 */
export async function handleGuideEvent(name: GuideEventName): Promise<void> {
    await resumeGuide();
    handleTourEvent(name);
    await handleEntryEvent(name);
}

/** イベントの受け口を付ける（何度呼んでも1回だけ）。 */
export function initGuide(): void {
    if (initialized) return;
    initialized = true;
    document.addEventListener('tiab-guide', event => {
        const name = (event as CustomEvent<GuideEventName>).detail;
        handleGuideEvent(name).catch(error => console.warn('[guide] イベント処理に失敗:', error));
    });
}
