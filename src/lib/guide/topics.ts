/** ヘルプへの対応表。UI・通信に依存しない正本。 */
export type GuideTourId = 'first-project' | 'join-project';

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

export const GUIDE_TOPICS = {
    'login': { helpAnchor: 'login' },
    'project-create': { helpAnchor: 'login-create-project', tourId: 'first-project', extensionOnly: true },
    'project-connect': { helpAnchor: 'login-connect-project', tourId: 'join-project' },
    'overview': { helpAnchor: 'getting-started', tourList: true },
    'screening-toolbar': { helpAnchor: 'screening-toolbar', tourList: true },
    'share': { helpAnchor: 'sharing-dialog' },
    'blind': { helpAnchor: 'sharing-blind' },
    'screening-filters': { helpAnchor: 'screening-filters' },
    'screening-duplicates': { helpAnchor: 'screening-duplicates' },
    'screening-decisions': { helpAnchor: 'screening-decisions' },
    'highlight': { helpAnchor: 'screening-highlight' },
    'notes': { helpAnchor: 'screening-notes' },
    'team-progress': { helpAnchor: 'sharing-team-progress' },
    'assignment': { helpAnchor: 'screening-filters' },
    'consensus': { helpAnchor: 'sharing-consensus' },
    'settings': { helpAnchor: 'settings' },
    'ml': { helpAnchor: 'ml-screening-interface', extensionOnly: true },
    'ai-model': { helpAnchor: 'ai-screening-models', extensionOnly: true },
    'ai-keys': { helpAnchor: 'ai-screening-api-keys', extensionOnly: true },
    'ai-criteria': { helpAnchor: 'ai-screening-criteria', extensionOnly: true },
    'ai-batch': { helpAnchor: 'ai-screening-batch', extensionOnly: true },
    'ai-threshold': { helpAnchor: 'ai-screening-batch', extensionOnly: true },
    'fulltext-views': { helpAnchor: 'fulltext-views', extensionOnly: true },
    'fulltext-candidates': { helpAnchor: 'fulltext-candidates', extensionOnly: true },
    'fulltext-setup': { helpAnchor: 'fulltext-setup', extensionOnly: true },
    'fulltext-assignment': { helpAnchor: 'fulltext-assignment', extensionOnly: true },
    'fulltext-pdf': { helpAnchor: 'fulltext-pdf', extensionOnly: true },
    'fulltext-drive-import': { helpAnchor: 'fulltext-drive-import', extensionOnly: true },
    'fulltext-registry': { helpAnchor: 'fulltext-registry', extensionOnly: true },
    'fulltext-ai': { helpAnchor: 'fulltext-ai', extensionOnly: true },
    'fulltext-results': { helpAnchor: 'fulltext-results', extensionOnly: true },
    'web-app': { helpAnchor: 'web-version' },
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
