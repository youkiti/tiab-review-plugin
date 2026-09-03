import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIdentification } from '../src/lib/prisma-identification';
import type { Reference, ImportStatsMap } from '../src/lib/types';

// Issue #145 チャンク2: PRISMA Identification 相の集計を純関数へ切り出したことの回帰テスト。
// src/sidepanel/features/manuscript.ts の collectIdentification() は state 依存でテストできな
// かったため、computeIdentification()（純関数、state 非依存）が対象。

type RefInput = Pick<Reference, 'source_file' | 'related_ref_id' | 'duplicate_of'>;

function ref(overrides: Partial<RefInput> = {}): RefInput {
    return {
        source_file: 'a.nbib',
        related_ref_id: undefined,
        duplicate_of: undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 論理削除ゼロ（回帰）
// ---------------------------------------------------------------------------

test('computeIdentification: 論理削除ゼロのとき現行と同じ数字になる（統計あり）', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 5, duplicates: 2 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.identifiedTotal, 5);
    assert.equal(result.duplicatesTotal, 2);
    assert.equal(result.screened, 3);
    assert.equal(result.statsComplete, true);
    assert.equal(result.identifiedTotal - (result.duplicatesTotal ?? 0), result.screened);
});

test('computeIdentification: 論理削除ゼロのとき現行と同じ数字になる（統計なし。重複除去後の件数で代用）', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
    ];

    const result = computeIdentification(refs, {});

    assert.equal(result.statsComplete, false);
    assert.equal(result.duplicatesTotal, null);
    assert.equal(result.identifiedTotal, 2);
    assert.equal(result.screened, 2);
    assert.deepEqual(result.files, [{ file: 'a.nbib', identified: 2, hasStats: false }]);
});

// ---------------------------------------------------------------------------
// 論理削除がN件あるケース
// ---------------------------------------------------------------------------

test('computeIdentification: 論理削除がN件あるとscreenedがN減りduplicatesTotalがN増える（identifiedTotal-duplicatesTotal=screenedが成立）', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib', duplicate_of: 'ref-keep-1' }),
        ref({ source_file: 'a.nbib', duplicate_of: 'ref-keep-2' }),
    ];
    const importStats: ImportStatsMap = {
        // 取り込み時の自動スキップ分は0件（=すべて自動スキップをすり抜けた重複が、後から
        // 重複レビューUIで論理削除されたケースを再現する）
        'a.nbib': { identified: 4, duplicates: 0 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.identifiedTotal, 4);
    // duplicatesTotal = import_stats.duplicates(0) + 論理削除された件数(2)
    assert.equal(result.duplicatesTotal, 2);
    // screened = 4 - 2(論理削除)
    assert.equal(result.screened, 2);
    assert.equal(result.identifiedTotal - (result.duplicatesTotal ?? 0), result.screened);
});

test('computeIdentification: import_stats の自動スキップ分と論理削除分が両方ある場合も合算される', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib', duplicate_of: 'ref-keep-1' }),
    ];
    const importStats: ImportStatsMap = {
        // 取り込み前に解析されたレコードは5件、うち1件は取り込み時に自動スキップ（PMID一致等）
        // 残り4件がシートに追加され、そのうち1件が後から重複レビューUIで論理削除された
        'a.nbib': { identified: 5, duplicates: 1 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.identifiedTotal, 5);
    assert.equal(result.duplicatesTotal, 2); // 1(自動スキップ) + 1(論理削除)
    assert.equal(result.screened, 3); // 4件シート行 - 1件論理削除
    assert.equal(result.identifiedTotal - (result.duplicatesTotal ?? 0), result.screened);
});

// ---------------------------------------------------------------------------
// import_stats が無いファイルが混ざる場合（現行挙動の維持）
// ---------------------------------------------------------------------------

test('computeIdentification: import_statsが無いファイルが混ざるとstatsComplete=false、duplicatesTotal=null（論理削除があっても合算しない）', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib', duplicate_of: 'ref-keep-1' }),
        ref({ source_file: 'b.nbib' }), // 統計なし
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 3, duplicates: 1 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.statsComplete, false);
    assert.equal(result.duplicatesTotal, null);
    // screened自体は統計の有無によらず計算される
    assert.equal(result.screened, 2); // a.nbibの非削除1件 + b.nbibの1件
});

// ---------------------------------------------------------------------------
// other methods 腕（related_ref_id 非空）の扱い
// ---------------------------------------------------------------------------

test('computeIdentification: other methods腕（related_ref_id非空）の行はdatabase腕の集計に入らない', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib', related_ref_id: 'reg-1' }),
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 1, duplicates: 0 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.identifiedTotal, 1);
    assert.equal(result.screened, 1);
});

test('computeIdentification: 論理削除されたother methods腕の行がduplicatesTotalに混入しない', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib', related_ref_id: 'reg-1', duplicate_of: 'ref-keep-1' }),
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 1, duplicates: 0 },
    };

    const result = computeIdentification(refs, importStats);

    // other methods腕の論理削除行はdatabase腕の集計から除外される（splitByIdentificationRouteで
    // 先に弾かれるため、その論理削除状態を見る機会自体がない）
    assert.equal(result.identifiedTotal, 1);
    assert.equal(result.duplicatesTotal, 0);
    assert.equal(result.screened, 1);
});

// ---------------------------------------------------------------------------
// refsMayOmitLogicallyDeleted オプション（Issue #145 チャンク2。manuscript.ts の
// getReferences() 取得失敗時の state.allReferences フォールバック用）
// ---------------------------------------------------------------------------

test('computeIdentification: refsMayOmitLogicallyDeletedがtrueだとimport_statsが揃っていてもduplicatesTotal=null・statsComplete=falseに強制される', () => {
    const refs: RefInput[] = [
        // フォールバック元（state.allReferences）は論理削除された行が既に取り除かれた一覧のため、
        // duplicate_ofが立った行はそもそも refs の中に存在しない（欠落であって undefined ではない）。
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 4, duplicates: 0 },
    };

    const result = computeIdentification(refs, importStats, { refsMayOmitLogicallyDeleted: true });

    assert.equal(result.duplicatesTotal, null, '論理削除件数を数えられないため合計不明にする');
    assert.equal(result.statsComplete, false, '既存の manuscript_warnNoStats 警告経路に合流させる');
    // screened/identifiedTotalは refs に実在する行から素直に計算した値のまま
    // （論理削除された行は refs 自体に存在しないため、この値自体は正しい）
    assert.equal(result.screened, 2);
});

test('computeIdentification: refsMayOmitLogicallyDeletedを渡さない（false相当）ときは従来どおりの計算になる', () => {
    const refs: RefInput[] = [
        ref({ source_file: 'a.nbib' }),
        ref({ source_file: 'a.nbib' }),
    ];
    const importStats: ImportStatsMap = {
        'a.nbib': { identified: 2, duplicates: 0 },
    };

    const result = computeIdentification(refs, importStats);

    assert.equal(result.duplicatesTotal, 0);
    assert.equal(result.statsComplete, true);
});
