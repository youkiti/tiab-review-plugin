// 案内ツアー「重複の確認」(duplicate-review) の通し検証用デモデータ
//
// 既定のデモデータは重複候補が無い（Duplicate_Candidates はヘッダー行のみ）ため、
// ?demoGuide=duplicates を付けたときだけ、重複する文献の組と候補を足す。クエリ無しの挙動は変えない。
// 判定は profile.ts と同じ理由で、URL クエリのみによる同期的な解決にしている
// （chrome.storage.local を読む非同期の判定は、サイドパネルの初期化に間に合わない）。
//
// 足すデータ（ref_id は demo-dup-NNN。ほかのデモデータの demo-ref-NNN とは重ならない）:
// - 組1（DOI 一致・候補登録済み）: 一括適用の対象になる。判定は付いていない
// - 組2（タイトル一致・候補登録済み）: 一括適用の対象外。右側の文献に人の判定が付いている
//   （右側を除外すると、判定が宙に浮く旨の確認が出る）
// - 組3（PMID 一致・候補は未登録）: 「重複を再スキャン」で初めて見つかる

import { appendRowsTo } from './sheet-store';
import { buildMatchKeys } from '../lib/duplicate-detect';
import { DEMO_SEED_TIMESTAMP, DEMO_USER_EMAIL } from './constants';
import type { Reference } from '../lib/types';

/** 現在のページ URL の ?demoGuide= の値（duplicates: 通常の候補、duplicates-broken: 壊れた組だけ）。それ以外は null */
function resolveDemoGuideDuplicatesMode(): 'duplicates' | 'duplicates-broken' | null {
    if (typeof location === 'undefined') return null;
    const value = new URLSearchParams(location.search).get('demoGuide');
    return value === 'duplicates' || value === 'duplicates-broken' ? value : null;
}

/** 現在のページ URL の ?demoGuide=duplicates のときだけ true */
export function resolveDemoGuideDuplicates(): boolean {
    return resolveDemoGuideDuplicatesMode() === 'duplicates';
}

/** seed.ts の判定行の組み立て（SeedDecisionInput）のうち、ここで使う項目 */
interface GuideDecisionInput {
    decisionId: string;
    refId: string;
    reviewerId: string;
    decision: 'include' | 'exclude' | 'maybe';
    decidedAt: string;
}

function dupRef(n: number, fields: Partial<Reference> & { title: string }): Reference {
    return {
        ref_id: `demo-dup-${String(n).padStart(3, '0')}`,
        imported_at: DEMO_SEED_TIMESTAMP,
        imported_by: DEMO_USER_EMAIL,
        source: 'PubMed',
        source_file: 'demo-duplicates.nbib',
        ...fields,
    };
}

const DUPLICATE_REFERENCES: Reference[] = [
    dupRef(1, {
        title: 'Cognitive behavioral therapy for insomnia in older adults: a randomized controlled trial',
        authors: 'Tanaka A; Suzuki B',
        year: 2021,
        journal: 'Sleep Medicine',
        doi: '10.1000/demo.dup.001',
    }),
    dupRef(2, {
        title: 'Cognitive behavioural therapy for insomnia in older adults: a randomised trial',
        authors: 'Tanaka A, Suzuki B',
        year: 2021,
        journal: 'Sleep Med',
        doi: '10.1000/demo.dup.001',
        source: 'Embase',
    }),
    dupRef(3, {
        title: 'Exercise therapy for chronic low back pain: a pragmatic trial',
        authors: 'Sato C; Ito D',
        year: 2019,
        journal: 'Spine',
    }),
    dupRef(4, {
        title: 'Exercise therapy for chronic low back pain: a pragmatic trial',
        authors: 'Sato C; Ito D',
        year: 2020,
        journal: 'European Spine Journal',
    }),
    dupRef(5, {
        title: 'Telephone follow-up after discharge for heart failure',
        authors: 'Kato E',
        year: 2018,
        journal: 'Heart',
        pmid: '39000001',
    }),
    dupRef(6, {
        title: 'Nurse-led telephone follow-up after hospital discharge in heart failure',
        authors: 'Kato E',
        year: 2018,
        journal: 'Heart Journal',
        pmid: '39000001',
        source: 'Embase',
    }),
];

/** 候補に登録済みの組（A が左、B が右に出る）。組3は意図して登録しない。 */
const SEEDED_PAIRS: { a: number; b: number; matchType: 'doi' | 'title' }[] = [
    { a: 1, b: 2, matchType: 'doi' },
    { a: 3, b: 4, matchType: 'title' },
];

/** DUPLICATE_CANDIDATES_HEADERS（seed.ts）と同じ並びの1行 */
function candidateRow(index: number, a: Reference, b: Reference, matchType: 'doi' | 'title'): string[] {
    const keys = buildMatchKeys(a);
    const matchKey = (matchType === 'doi' ? keys.doi : keys.title) ?? '';
    return [
        `demo-dupcand-${String(index).padStart(3, '0')}`, a.ref_id, b.ref_id, matchType, matchKey,
        'suggested', DEMO_SEED_TIMESTAMP, '', '', '',
    ];
}

/**
 * ?demoGuide=duplicates-broken 用: 互いを重複として指し合う（相互削除の）壊れた組。
 * 候補の比較の表は作られず、「左を残す」「右を残す」は選べない。この1組だけを候補に入れる。
 */
const BROKEN_REFERENCES: Reference[] = [
    dupRef(7, { title: '壊れた組のデモ A: music therapy for dementia', year: 2017, duplicate_of: 'demo-dup-008' }),
    dupRef(8, { title: '壊れた組のデモ B: acupuncture for migraine', year: 2016, duplicate_of: 'demo-dup-007' }),
];

/**
 * ?demoGuide=duplicates のときだけ、シード済みのデモシートへ重複する文献・候補・判定を追記する
 * （seedDemoStore の最後から呼ぶ。行の組み立ては seed.ts のものを受け取り、列順の写しを持たない）。
 */
export function seedGuideDuplicatesDemo(
    buildReferenceRow: (ref: Reference) => string[],
    buildDecisionRow: (input: GuideDecisionInput) => string[]
): void {
    const mode = resolveDemoGuideDuplicatesMode();
    if (mode === null) return;
    if (mode === 'duplicates-broken') {
        appendRowsTo('References', BROKEN_REFERENCES.map(buildReferenceRow));
        appendRowsTo('Duplicate_Candidates', [candidateRow(1, BROKEN_REFERENCES[0], BROKEN_REFERENCES[1], 'title')]);
        return;
    }

    appendRowsTo('References', DUPLICATE_REFERENCES.map(buildReferenceRow));

    const byId = new Map(DUPLICATE_REFERENCES.map((ref) => [ref.ref_id, ref]));
    const candidates = SEEDED_PAIRS.map((pair, i) => {
        const a = byId.get(`demo-dup-${String(pair.a).padStart(3, '0')}`)!;
        const b = byId.get(`demo-dup-${String(pair.b).padStart(3, '0')}`)!;
        return candidateRow(i + 1, a, b, pair.matchType);
    });
    appendRowsTo('Duplicate_Candidates', candidates);

    // 組2の右側（demo-dup-004）に、デモユーザーの判定を1件付ける
    appendRowsTo('Decisions', [
        buildDecisionRow({
            decisionId: 'demo-dec-dup-001',
            refId: 'demo-dup-004',
            reviewerId: DEMO_USER_EMAIL,
            decision: 'include',
            decidedAt: '2026-01-06T02:00:00.000Z',
        }),
    ]);
}
