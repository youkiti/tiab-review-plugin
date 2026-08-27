// registry-record.ts
// Issue #118「レジストリ連携フェーズ1」チャンク1: レコード種別（記事 / 試験登録）判定の単一情報源。
// UI 非依存の純関数モジュール（チャンク2以降でスナップショット生成などもここに足していく予定）。

import type { Reference } from './types';

/**
 * ある References 行が「試験登録（CTG/ICTRP）由来」かどうかを判定する。
 *
 * 判定の単一情報源（single source of truth）。表示（サイドパネルのバッジ表示等）・集計・
 * 取得経路（フルテキスト取得対象に含めるか等）の分岐は、今後すべてこの関数を経由すること。
 * 独自にヒューリスティックを書き直さないこと（表示結果が食い違う原因になる）。
 *
 * 優先順位:
 * 1. record_type が確定値を持つ場合はそれを最優先する（'registration' → true / 'article' → false）。
 *    CTG/ICTRP パーサはこの値を確定で書き込む。
 * 2. record_type 未設定（既存行・他パーサ由来の行との後方互換のためのフォールバック）の場合のみ、
 *    journal/source から推測する。この判定は
 *    src/sidepanel/features/screening/render.ts の renderTrialRegistryNote() が元々持っていた
 *    ヒューリスティックと完全に同一（journal を trim・小文字化した上で 'ictrp' または
 *    'clinicaltrials.gov' と完全一致、または source に 'clinicaltrials.gov' を含む）。
 *    表示結果を変えないため、この判定条件自体は変更しないこと。
 */
export function isRegistrationRecord(
    ref: Pick<Reference, 'record_type' | 'journal' | 'source'>
): boolean {
    if (ref.record_type === 'registration') return true;
    if (ref.record_type === 'article') return false;

    // 未設定の既存行向けフォールバック（renderTrialRegistryNote() と同一ロジック）
    const source = (ref.source || '').trim();
    const journal = (ref.journal || '').trim().toLowerCase();
    return (
        journal === 'ictrp' ||
        journal === 'clinicaltrials.gov' ||
        /clinicaltrials\.gov/i.test(source)
    );
}
