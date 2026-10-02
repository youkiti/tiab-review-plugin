/** ヘルプへの対応表。UI・通信に依存しない正本。 */
export type GuideTourId =
    | 'first-project'
    | 'join-project'
    | 'assignment-setup'
    | 'share-invite'
    | 'resolve-conflicts'
    | 'duplicate-review'
    | 'fulltext-setup'
    | 'ai-first-run'
    | 'ml-start'
    | 'fulltext-page'
    | 'fulltext-results';

export interface GuideTopic {
    /** docs/help.html 内の id（# は付けない） */
    helpAnchor: string;
    /** 解説動画。未整備のトピックでは省略する */
    video?: { youtubeId: string; startSec: number };
    /** 後続の作業で、この画面から開始できるツアー */
    tourId?: GuideTourId;
    /**
     * 拡張版でしか表示されないトピック（Web 版では該当セクションごと隠れる）。
     * 見出しのキーが `guideExt_topic_*` になり、Web 版ビルドの messages.json から落とされる。
     */
    extensionOnly?: true;
    /** 吹き出しに「操作ツアーの一覧」を開くボタンを足す（ツアーが1本も使えないプラットフォームでは出ない） */
    tourList?: true;
}

/** 解説動画（長編）の YouTube ID。上げ直したら docs/index.html・docs/help.html の埋め込みと一緒に直す */
export const GUIDE_VIDEO_ID = 'SJxUTnLyZI4';

/** 解説動画（長編）の章の開始秒。撮り直したら video/build/chapters.txt に合わせて直す */
export const GUIDE_VIDEO_CHAPTERS = {
    intro: 0,
    login: 33,
    manual: 94,
    shortcuts: 179,
    ml: 214,
    ai: 270,
    fulltext: 340,
    sharing: 458,
    web: 525,
    settings: 564,
    outro: 604,
} as const;

function chapterVideo(chapter: keyof typeof GUIDE_VIDEO_CHAPTERS) {
    return { youtubeId: GUIDE_VIDEO_ID, startSec: GUIDE_VIDEO_CHAPTERS[chapter] };
}

export const GUIDE_TOPICS = {
    'login': { helpAnchor: 'login', video: chapterVideo('login') },
    'project-create': { helpAnchor: 'login-create-project', tourId: 'first-project', extensionOnly: true, video: chapterVideo('login') },
    'project-connect': { helpAnchor: 'login-connect-project', tourId: 'join-project', video: chapterVideo('login') },
    'overview': { helpAnchor: 'getting-started', tourList: true, video: chapterVideo('intro') },
    'screening-toolbar': { helpAnchor: 'screening-toolbar', tourList: true, video: chapterVideo('manual') },
    'share': { helpAnchor: 'sharing-dialog', tourId: 'share-invite', video: chapterVideo('sharing') },
    'blind': { helpAnchor: 'sharing-blind', tourId: 'resolve-conflicts', video: chapterVideo('sharing') },
    'screening-filters': { helpAnchor: 'screening-filters', video: chapterVideo('manual') },
    'screening-duplicates': { helpAnchor: 'screening-duplicates', tourId: 'duplicate-review' },
    'screening-decisions': { helpAnchor: 'screening-decisions', video: chapterVideo('manual') },
    'highlight': { helpAnchor: 'screening-highlight', video: chapterVideo('manual') },
    'notes': { helpAnchor: 'screening-notes', video: chapterVideo('manual') },
    'team-progress': { helpAnchor: 'sharing-team-progress', tourId: 'share-invite', video: chapterVideo('sharing') },
    'assignment': { helpAnchor: 'screening-filters', tourId: 'assignment-setup' },
    'consensus': { helpAnchor: 'sharing-consensus', tourId: 'resolve-conflicts', video: chapterVideo('sharing') },
    'settings': { helpAnchor: 'settings', video: chapterVideo('settings') },
    'ml': { helpAnchor: 'ml-screening-interface', tourId: 'ml-start', extensionOnly: true, tourList: true, video: chapterVideo('ml') },
    'ai-model': { helpAnchor: 'ai-screening-models', tourId: 'ai-first-run', extensionOnly: true, tourList: true, video: chapterVideo('ai') },
    'ai-keys': { helpAnchor: 'ai-screening-api-keys', tourId: 'ai-first-run', extensionOnly: true, video: chapterVideo('ai') },
    'ai-criteria': { helpAnchor: 'ai-screening-criteria', tourId: 'ai-first-run', extensionOnly: true, video: chapterVideo('ai') },
    'ai-batch': { helpAnchor: 'ai-screening-batch', tourId: 'ai-first-run', extensionOnly: true, video: chapterVideo('ai') },
    'ai-threshold': { helpAnchor: 'ai-screening-batch', tourId: 'ai-first-run', extensionOnly: true, video: chapterVideo('ai') },
    'fulltext-views': { helpAnchor: 'fulltext-views', tourId: 'fulltext-setup', extensionOnly: true, tourList: true, video: chapterVideo('fulltext') },
    'fulltext-candidates': { helpAnchor: 'fulltext-candidates', tourId: 'fulltext-setup', extensionOnly: true, video: chapterVideo('fulltext') },
    'fulltext-setup': { helpAnchor: 'fulltext-setup', tourId: 'fulltext-setup', extensionOnly: true, video: chapterVideo('fulltext') },
    'fulltext-assignment': { helpAnchor: 'fulltext-assignment', tourId: 'fulltext-setup', extensionOnly: true },
    'fulltext-pdf': { helpAnchor: 'fulltext-pdf', tourId: 'fulltext-setup', extensionOnly: true, video: chapterVideo('fulltext') },
    'fulltext-drive-import': { helpAnchor: 'fulltext-drive-import', tourId: 'fulltext-setup', extensionOnly: true },
    'fulltext-registry': { helpAnchor: 'fulltext-registry', extensionOnly: true },
    'fulltext-ai': { helpAnchor: 'fulltext-ai', extensionOnly: true },
    'fulltext-results': { helpAnchor: 'fulltext-results', tourId: 'fulltext-results', extensionOnly: true, video: chapterVideo('fulltext') },
    'web-app': { helpAnchor: 'web-version', video: chapterVideo('web') },
} as const satisfies Record<string, GuideTopic>;

export type GuideTopicId = keyof typeof GUIDE_TOPICS;
export const HELP_PAGE_URL = 'https://youkiti.github.io/tiab-review-plugin/help.html';

export function buildHelpUrl(topicId: GuideTopicId, lang: 'ja' | 'en'): string {
    return `${HELP_PAGE_URL}?lang=${lang}#${GUIDE_TOPICS[topicId].helpAnchor}`;
}

export function buildVideoUrl(video: { youtubeId: string; startSec: number }): string {
    return `https://youtu.be/${video.youtubeId}?t=${video.startSec}`;
}

/** トピック見出しの i18n キー。拡張専用トピックは `guideExt_topic_*`、それ以外は `guide_topic_*`。 */
export function guideTopicTitleKey(topicId: GuideTopicId): string {
    const topic: GuideTopic = GUIDE_TOPICS[topicId];
    const prefix = topic.extensionOnly ? 'guideExt_topic_' : 'guide_topic_';
    return prefix + topicId.replace(/-/g, '_');
}

export function isGuideTopicId(value: string): value is GuideTopicId {
    return Object.prototype.hasOwnProperty.call(GUIDE_TOPICS, value);
}
