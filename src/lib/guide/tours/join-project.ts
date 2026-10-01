import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/** このツアー固有のイベント名・条件名（無し） */
export type JoinProjectEvent = never;
export type JoinProjectCondition = never;

// 参加ツアーは Web 版でも出るので、`guide_` 接頭辞（Web 版ビルドでも落とされない）を使う。
const BASE = tourKeyBase('guide_tour_', 'join-project');

export const JOIN_PROJECT_TOUR: TourFor<JoinProjectEvent, JoinProjectCondition> = {
    id: 'join-project',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension', 'web'],
    audience: 'participant',
    page: 'sidepanel',
    steps: [
        {
            id: 'paste-url',
            target: 'sheet-url',
            textKey: stepKey(BASE, 'paste-url'),
            advance: { type: 'events', events: ['sheet-url-entered'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'connect',
            target: 'connect',
            textKey: stepKey(BASE, 'connect'),
            advance: { type: 'events', events: ['project-connected', 'picker-guidance-shown'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'allow',
            target: 'picker-open',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'allow'),
            advance: { type: 'events', events: ['project-connected'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'assignment',
            target: 'assignment-sets',
            textKey: stepKey(BASE, 'assignment'),
            advance: { type: 'next' },
            skipIf: 'no-assignment-sets',
        },
        {
            id: 'read',
            target: 'reference-card',
            textKey: stepKey(BASE, 'read'),
            advance: { type: 'next' },
            scroll: 'start',
        },
        {
            id: 'decide',
            target: 'decision-buttons',
            textKey: stepKey(BASE, 'decide'),
            advance: { type: 'events', events: ['decision-saved'] },
            scroll: 'if-hidden',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
