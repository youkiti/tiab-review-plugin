// デモ「不一致の解消」ツアー用データ（?demoGuide=conflicts）
//
// 既定のデモデータ（実データ10件）に、次の2点を足す。
// - Config に key_opened=true（キー開封済み = Blind オフ）
// - 同じ文献にデモの自分と同僚の食い違う判定（demo-ref-004〜006 の3件）。
//   既定のデモでは 004・005 は同僚だけが判定済み、006 は誰も判定していない。
// クエリ無しのときは何もしない（既定のデモデータは1バイトも変わらない）。
// seedDemoStore() のあとに呼ぶこと。URL クエリから同期的に判定する（profile.ts と同じ理由で非同期にしない）。

import { appendRowsTo } from './sheet-store';
import { DEMO_COLLEAGUE_EMAIL, DEMO_HUMAN_CLIENT_VERSION, DEMO_USER_EMAIL } from './constants';

/** ?demoGuide=conflicts のときだけ true */
export function isGuideConflictsDemo(): boolean {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('demoGuide') === 'conflicts';
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
        '', d.note ?? '', d.decidedAt, DEMO_HUMAN_CLIENT_VERSION, '', '',
        '',
    ];
}

/** ?demoGuide=conflicts のときだけ、シード済みのストアにキー開封と食い違う判定を足す。 */
export function applyGuideConflictsDemo(): void {
    if (!isGuideConflictsDemo()) return;
    appendRowsTo('Config', [['key_opened', 'true']]);
    appendRowsTo('Decisions', [
        // 004: 同僚は include（既存の判定）。自分は exclude、同僚は理由つきのメモを後から追記
        toRow({ id: 'demo-dec-g-001', refId: 'demo-ref-004', reviewer: DEMO_USER_EMAIL, decision: 'exclude', reason: '対象集団が組み入れ基準に合わない', decidedAt: '2026-01-06T03:00:00.000Z' }),
        toRow({ id: 'demo-dec-g-002', refId: 'demo-ref-004', reviewer: DEMO_COLLEAGUE_EMAIL, decision: 'include', note: '成人も含む集団なので残したい', decidedAt: '2026-01-06T03:10:00.000Z' }),
        // 005: 同僚は exclude（既存の判定）。自分は include
        toRow({ id: 'demo-dec-g-003', refId: 'demo-ref-005', reviewer: DEMO_USER_EMAIL, decision: 'include', decidedAt: '2026-01-06T03:20:00.000Z' }),
        // 006: 自分は include、同僚は maybe
        toRow({ id: 'demo-dec-g-004', refId: 'demo-ref-006', reviewer: DEMO_USER_EMAIL, decision: 'include', decidedAt: '2026-01-06T03:30:00.000Z' }),
        toRow({ id: 'demo-dec-g-005', refId: 'demo-ref-006', reviewer: DEMO_COLLEAGUE_EMAIL, decision: 'maybe', note: '抄録だけでは判断できない', decidedAt: '2026-01-06T03:40:00.000Z' }),
    ]);
}
