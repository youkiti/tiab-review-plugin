import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/** このツアー固有のイベント名・条件名（無し） */
export type FirstProjectEvent = never;
export type FirstProjectCondition = never;

// ツアー1は拡張版専用。Web 版ビルドが `guideExt_` 接頭辞のキーを落とすので、その接頭辞に揃える。
const BASE = tourKeyBase('guideExt_tour_', 'first-project');

export const FIRST_PROJECT_TOUR: TourFor<FirstProjectEvent, FirstProjectCondition> = {
    id: 'first-project',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    steps: [
        {
            id: 'project-create',
            target: 'create-project',
            textKey: stepKey(BASE, 'project-create'),
            advance: { type: 'events', events: ['project-created'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'import',
            target: 'import',
            textKey: stepKey(BASE, 'import'),
            advance: { type: 'events', events: ['references-imported'] },
            skipIf: 'has-references',
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
            id: 'go-back',
            target: 'prev',
            textKey: stepKey(BASE, 'go-back'),
            advance: { type: 'events', events: ['navigated-prev'] },
        },
        {
            id: 'redecide',
            target: 'decision-buttons',
            textKey: stepKey(BASE, 'redecide'),
            advance: { type: 'events', events: ['decision-saved'] },
            scroll: 'if-hidden',
        },
        {
            id: 'blind',
            target: 'blind',
            textKey: stepKey(BASE, 'blind'),
            advance: { type: 'next' },
            blockTarget: true,
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
