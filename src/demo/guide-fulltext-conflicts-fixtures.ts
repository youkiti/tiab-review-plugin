// デモ「判定後レビュー」ツアー用データ（?demoGuide=fulltext-conflicts）
//
// 既定のデモデータ（実データ10件）に、次の2点を足す。
// - Config に key_opened=true（キー開封済み = Blind オフ）
// - 全文フェーズ（screening_phase='fulltext'）で、デモの自分と同僚の食い違う判定（demo-ref-001・002 の2件）。
//   既定のデモでは 001・002 とも、自分・同僚の両方が TiAb で include 済みなので、全文の候補になっている。
// クエリ無しのときは何もしない（既定のデモデータは1バイトも変わらない）。
// seedDemoStore() のあとに呼ぶこと。URL クエリから同期的に判定する（profile.ts と同じ理由で非同期にしない）。

import { appendRowsTo } from './sheet-store';
import { DEMO_COLLEAGUE_EMAIL, DEMO_HUMAN_CLIENT_VERSION, DEMO_USER_EMAIL } from './constants';

/** ?demoGuide=fulltext-conflicts のときだけ true */
export function isGuideFulltextConflictsDemo(): boolean {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('demoGuide') === 'fulltext-conflicts';
}

// src/demo/seed.ts の DECISIONS_HEADERS と同じ並び（同ファイルは export していないためここでミラーする）。
type DecisionCells = {
    id: string;
    refId: string;
    reviewer: string;
    decision: 'include' | 'exclude' | 'maybe';
    reason?: string;
    note?: string;
    decidedAt: string;
};

function toRow(d: DecisionCells): string[] {
    return [
        d.id, d.refId, d.reviewer, d.decision, d.reason ?? '',
        '', d.note ?? '', d.decidedAt, DEMO_HUMAN_CLIENT_VERSION, '',
        'fulltext', // screening_phase: 全文フェーズの判定
        '',
    ];
}

/** ?demoGuide=fulltext-conflicts のときだけ、シード済みのストアにキー開封と全文フェーズの食い違う判定を足す。 */
export function applyGuideFulltextConflictsDemo(): void {
    if (!isGuideFulltextConflictsDemo()) return;
    appendRowsTo('Config', [['key_opened', 'true']]);
    appendRowsTo('Decisions', [
        // 001: 判定不一致（自分は include、同僚は exclude で理由つき）
        toRow({ id: 'demo-dec-ft-001', refId: 'demo-ref-001', reviewer: DEMO_USER_EMAIL, decision: 'include', decidedAt: '2026-01-07T01:00:00.000Z' }),
        toRow({ id: 'demo-dec-ft-002', refId: 'demo-ref-001', reviewer: DEMO_COLLEAGUE_EMAIL, decision: 'exclude', reason: 'population', note: '対象が研修医で学生ではない', decidedAt: '2026-01-07T01:10:00.000Z' }),
        // 002: 理由不一致（どちらも exclude だが、除外理由が違う）
        toRow({ id: 'demo-dec-ft-003', refId: 'demo-ref-002', reviewer: DEMO_USER_EMAIL, decision: 'exclude', reason: 'study_design', decidedAt: '2026-01-07T01:20:00.000Z' }),
        toRow({ id: 'demo-dec-ft-004', refId: 'demo-ref-002', reviewer: DEMO_COLLEAGUE_EMAIL, decision: 'exclude', reason: 'population', decidedAt: '2026-01-07T01:30:00.000Z' }),
    ]);
}
