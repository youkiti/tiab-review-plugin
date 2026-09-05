// デモ「bench」プロファイル用のベンチマーク合成データ生成（Issue #151（#150 工程0）チャンク2）
//
// 固定サイズではなく size 引数で 1千・1万・5万件規模の References / Decisions /
// LLM_Runs / LLM_Executions を決定論的に組み立てる。判定履歴・TiAb/全文・AIラウンド・
// 論理削除・登録情報と関連論文まで一通り含める（親Issue #150 の計測基盤要求）。
// src/demo/ml-fixtures.ts の「index からの決定論的な組み立て（Math.random() / Date.now() /
// new Date() を一切使わない）」を手本にしている。
//
// 依存の制約: このファイルは tests/ から直接 import してテストする。src/demo/seed.ts は
// sample/*.nbib を raw-text import しているため tsc + node --test の経路から import できない
// （AGENTS.md「テスト・作業ツリーの落とし穴」参照）。そのためこのファイルは seed.ts は
// もちろん src/demo/ml-fixtures.ts 等の他デモファイルにも依存せず、src/lib/types の型と
// src/demo/constants.ts の定数のみに依存する。
//
// 乱数について: 割り当てはすべて index からの決定論的な剰余演算・等間隔ストライド選択で行い、
// Math.random() は使わない。ブリーフでは「乱数が要るなら mulberry32 等のシード固定PRNGを
// 自前で実装する」ことを許容しているが、本ファイルでは PRNG を導入していない。理由は、
// 構成比の各カテゴリを「floor(size * 割合) 件」という正確な件数で満たす必要があり
// （割合ベースの構成比の要求）、PRNG による近似選択では狙った件数と一致しない一方、
// strideIndices()（後述）による等間隔選択なら件数を厳密に一致させつつ十分にばらけた
// 分布が得られるため。
//
// 日時について: 禁じているのは Date.now() と引数なしの new Date()（呼ぶたびに値が変わるもの）
// であって、固定エポック値（2026-01-01T00:00:00.000Z）へオフセットを足した
// new Date(number).toISOString() は何度呼んでも同じ結果になる完全な決定論的計算なので問題ない。
// isoFromOffsetSeconds() はこの形で ISO 8601 文字列を組み立てる（手書きのカレンダー計算はしない）。

import type { Reference, LlmRun, LlmExecution, FulltextLlmDecisionNote, FulltextEvidence } from '../lib/types';
import {
    DEMO_SEED_TIMESTAMP,
    DEMO_USER_EMAIL,
    DEMO_COLLEAGUE_EMAIL,
    DEMO_HUMAN_CLIENT_VERSION,
    DEMO_FULLTEXT_DRIVE_FILE_ID,
} from './constants';

// ---------------------------------------------------------------------------
// 構成比・端数処理
// ---------------------------------------------------------------------------
// すべて Math.floor(size * 割合) で計算し、端数は切り捨てる。size=1000 での実際の件数は
// tests/bench-fixtures.test.ts のコメント・実装レポートを参照。

/** 登録情報レコード（record_type='registration'）の割合 */
const REGISTRATION_FRACTION = 0.02;
/** 登録情報レコードのうち、取り込んだ論文行（related_ref_id 付き）を持たせる割合 */
const IMPORTED_PUB_FRACTION_OF_REGISTRATION = 0.5;
/** 論理削除（duplicate_of 設定）される行の割合（登録情報行を除いた全体からの割合ではなく size 全体からの割合） */
const DUPLICATE_FRACTION = 0.03;
/** 本人（DEMO_USER_EMAIL）のTiAb判定を持たせる行の割合 */
const TIAB_HUMAN_FRACTION = 0.40;
/** 本人TiAb判定のうち、判定変更履歴（2-3行）を持たせる割合 */
const HISTORY_FRACTION_OF_TIAB = 0.25;
/** 同僚（DEMO_COLLEAGUE_EMAIL）のTiAb判定を持たせる行の割合 */
const COLLEAGUE_FRACTION = 0.30;
/** 本人TiAbでincludeになった行のうち、フルテキスト判定も持たせる割合 */
const FULLTEXT_FRACTION_OF_INCLUDED = 0.5;
/** AI（LLM）一括判定を持たせる行の割合（size全体からの割合。buildBenchLlmRound() の target_count） */
const LLM_TARGET_FRACTION = 0.20;
/** LLM判定のうち include にする割合（残りは exclude。TiAbのAI一括判定では maybe/failed を持たせない） */
const LLM_INCLUDE_FRACTION_OF_TARGET = 0.40;

/** LLM判定の client_version（isLlmDecision() が '-llm' の部分一致で判定するため） */
const BENCH_LLM_CLIENT_VERSION = 'demo-0.0.0-llm';

// ---------------------------------------------------------------------------
// 決定論的ユーティリティ
// ---------------------------------------------------------------------------

/** ref_id（bench-ref-000001 のようなゼロ埋め連番。デモの demo-ref-001 と衝突しないprefix） */
function benchRefId(index: number): string {
    return `bench-ref-${String(index).padStart(6, '0')}`;
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function pick<T>(pool: T[], seed: number): T {
    return pool[((seed % pool.length) + pool.length) % pool.length];
}

/**
 * 1..poolSize の範囲から count 件のインデックスを等間隔ストライドで重複なく取り出す
 * （擬似乱数を使わない決定論的な均等抽出。ファイル冒頭「乱数について」参照）。
 * stride は Math.floor(poolSize / count) 未満にならないため、start を 1..stride の範囲に
 * 収めれば安全に (count-1)*stride + start <= poolSize となり、折り返し（モジュロ）なしで
 * 重複なく選べる。start が stride を超えて渡された場合は 1..stride の範囲へ丸め直す。
 */
function strideIndices(poolSize: number, count: number, start: number): number[] {
    if (count <= 0 || poolSize <= 0) return [];
    const stride = Math.max(1, Math.floor(poolSize / count));
    const safeStart = ((start - 1) % stride) + 1;
    const result: number[] = [];
    for (let k = 0; k < count; k += 1) {
        result.push(safeStart + k * stride);
    }
    return result;
}

/** 起点エポック（2026-01-01T00:00:00.000Z）のミリ秒値。isoFromOffsetSeconds() の基準点。 */
const BENCH_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/**
 * 起点エポック（BENCH_EPOCH_MS = 2026-01-01T00:00:00.000Z）を totalSeconds 秒だけ進めた
 * ISO 8601 文字列を作る。固定エポック値へオフセットを足すだけなので、同じ引数なら常に
 * 同じ結果になる（ファイル冒頭「日時について」参照）。年またぎ・うるう年・タイムゾーンの
 * 扱いは Date 組み込みの UTC 計算に委ね、手書きのカレンダー計算はしない。
 */
function isoFromOffsetSeconds(totalSeconds: number): string {
    const safeTotal = Math.max(0, Math.floor(totalSeconds));
    return new Date(BENCH_EPOCH_MS + safeTotal * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// 語彙プール（すべて固定・index からの決定論的な選択にのみ使う。実データのコピーではない）
// ---------------------------------------------------------------------------

const BENCH_POPULATIONS = [
    'adult patients with type 2 diabetes mellitus',
    'children with acute bronchiolitis',
    'older adults with sarcopenia',
    'patients undergoing elective knee arthroplasty',
    'critically ill patients requiring mechanical ventilation',
    'patients with moderate persistent asthma',
    'pregnant women with iron deficiency anemia',
    'patients with chronic low back pain',
    'patients with treatment-resistant hypertension',
    'patients with early-stage breast cancer',
    'infants with congenital heart disease',
    'patients with inflammatory bowel disease',
];

const BENCH_INTERVENTIONS = [
    'a structured pulmonary rehabilitation program',
    'early initiation of enteral nutrition',
    'a pharmacist-led medication review',
    'high-intensity interval training',
    'a robot-assisted surgical approach',
    'a smartphone-based adherence reminder',
    'restrictive intraoperative fluid management',
    'internet-delivered cognitive behavioral therapy',
    'a bundled infection-prevention protocol',
    'progressive resistance training',
    'a single perioperative dose of dexamethasone',
    'closed-loop insulin delivery',
];

const BENCH_COMPARATORS = [
    'standard care',
    'placebo',
    'a wait-list control',
    'conventional management',
    'usual outpatient follow-up',
    'an open surgical approach',
    'no intervention',
    'delayed treatment initiation',
];

const BENCH_OUTCOMES = [
    '90-day all-cause mortality',
    'length of intensive care unit stay',
    'change in forced expiratory volume at 12 weeks',
    'patient-reported functional status',
    'the rate of postoperative wound infection',
    'unplanned readmission within 30 days',
    'pain intensity measured by numeric rating scale',
    'return to baseline activity at 6 months',
    'the incidence of catheter-related bloodstream infection',
    'change in composite symptom score',
    'time to independent ambulation',
    'cumulative healthcare costs at 1 year',
];

const BENCH_DESIGNS = [
    'randomized controlled trial',
    'multicentre randomized trial',
    'systematic review and meta-analysis',
    'case report',
    'retrospective cohort study',
    'prospective cohort study',
    'cross-sectional study',
    'study protocol',
];

const BENCH_JOURNALS = [
    'Journal of Bench Clinical Research (Fixture)',
    'International Review of Evidence Synthesis (Fixture)',
    'Annals of Applied Medicine Reports (Fixture)',
    'Open Reviews in Perioperative Care (Fixture)',
    'Journal of Rehabilitation and Recovery (Fixture)',
    'Digest of Methodology in Health Research (Fixture)',
    'European Journal of Bench Outcomes (Fixture)',
    'Asia-Pacific Bench Medicine Journal (Fixture)',
];

const BENCH_LAST_NAMES = [
    'Sato', 'Ito', 'Takahashi', 'Nakamura', 'Kimura',
    'Anderson', 'Thompson', 'Clark', 'Lewis', 'Walker',
    'Fernandez', 'Rodriguez', 'Schmidt', 'Bianchi', 'Tran',
];
const BENCH_INITIALS = ['A', 'D', 'E', 'H', 'K', 'L', 'M', 'N', 'R', 'Y'];

const BENCH_EXCLUDE_REASONS = [
    '研究デザインが組み入れ基準に合致しないため対象外',
    '対象集団が適格基準を満たさないため対象外',
    'アウトカムの報告が組み入れ基準に合致しないため対象外',
    '会議抄録のみでフルテキストが存在しないため対象外',
];

function benchExcludeReason(index: number): string {
    return pick(BENCH_EXCLUDE_REASONS, index);
}

interface BenchPlan {
    population: string;
    intervention: string;
    comparator: string;
    outcome: string;
    design: string;
    journal: string;
    year: number;
}

function planFor(index: number): BenchPlan {
    return {
        population: pick(BENCH_POPULATIONS, index * 3 + 1),
        intervention: pick(BENCH_INTERVENTIONS, index * 5 + 2),
        comparator: pick(BENCH_COMPARATORS, index * 7 + 3),
        outcome: pick(BENCH_OUTCOMES, index * 11 + 4),
        design: pick(BENCH_DESIGNS, index),
        journal: pick(BENCH_JOURNALS, index * 13 + 5),
        year: 2005 + (index % 20), // 2005-2024
    };
}

function buildTitle(index: number, plan: BenchPlan): string {
    const templateIndex = index % 3;
    const design = capitalize(plan.design);
    if (templateIndex === 0) {
        return `${design}: ${capitalize(plan.intervention)} versus ${plan.comparator} for ${plan.outcome} in ${plan.population}`;
    }
    if (templateIndex === 1) {
        return `Effect of ${plan.intervention} on ${plan.outcome} among ${plan.population}: a ${plan.design}`;
    }
    return `${design} of ${plan.intervention} for ${plan.population}: focus on ${plan.outcome}`;
}

/** 抄録は実データと同程度の長さ（数百文字程度）に収める（5万件規模でも生成できるよう長さを抑える） */
function buildAbstract(index: number, plan: BenchPlan): string {
    const n = 30 + (index % 470); // 30-499
    const favorsIntervention = index % 2 === 0;
    const direction = favorsIntervention ? 'a significant improvement' : 'no significant difference';
    const pValue = favorsIntervention ? `0.0${1 + (index % 9)}` : `0.${30 + (index % 60)}`;
    return [
        `Background: ${capitalize(plan.population)} face substantial clinical burden, and the optimal approach to ${plan.outcome} remains uncertain in routine practice.`,
        `Methods: This ${plan.design} enrolled ${n} participants who received ${plan.intervention} or ${plan.comparator}; the primary outcome was ${plan.outcome}, assessed at predefined follow-up timepoints.`,
        `Results: ${capitalize(plan.intervention)} was associated with ${direction} in ${plan.outcome} relative to ${plan.comparator} (p=${pValue}).`,
        `Conclusion: These findings contribute to the evidence base regarding ${plan.intervention} in ${plan.population}.`,
    ].join(' ');
}

function buildAuthors(index: number): string {
    const a1 = pick(BENCH_LAST_NAMES, index * 17 + 6);
    const i1 = pick(BENCH_INITIALS, index * 19 + 7);
    const a2 = pick(BENCH_LAST_NAMES, index * 23 + 8);
    const i2 = pick(BENCH_INITIALS, index * 29 + 9);
    return index % 3 === 0 ? `${a1} ${i1}, ${a2} ${i2}, et al.` : `${a1} ${i1}, ${a2} ${i2}`;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

interface BenchPartition {
    n: number;
    registrationCount: number;
    importedPubCount: number;
    articlePoolSize: number;
}

/**
 * References の index 帯を決める（1-based）。
 * [1, registrationCount] -> registration
 * (registrationCount, registrationCount+importedPubCount] -> 取り込んだ論文行（article, related_ref_id付き）
 * (registrationCount+importedPubCount, n] -> 通常の論文行
 * buildBenchReferences() と buildBenchDecisionSeeds() の両方から同じ計算式で呼ぶことで、
 * 同じ size なら常に同じ帯域分けになることを保証する。
 */
function computePartition(size: number): BenchPartition {
    const n = Math.max(0, Math.floor(size));
    const registrationCount = Math.floor(n * REGISTRATION_FRACTION);
    const importedPubCount = Math.floor(registrationCount * IMPORTED_PUB_FRACTION_OF_REGISTRATION);
    return {
        n,
        registrationCount,
        importedPubCount,
        articlePoolSize: n - registrationCount,
    };
}

// ---------------------------------------------------------------------------
// フルテキスト取得済み文献（PDF先頭ページ・根拠ジャンプの計測用。Issue #151（#150 工程0）
// チャンク3b）
// ---------------------------------------------------------------------------
// scripts/bench/run.mjs のPDFシナリオは、根拠ハイライトが1件もseedされていない既定デモ
// プロファイルの demo-ref-001 ではなく、この bench 合成データのうち「先頭付近の通常論文行」
// 1件を使う。run.mjs は plain Node ESM のためこの TypeScript 定数を import できず、
// 値を複製している（DEMO_SPREADSHEET_ID 等と同じ理由。run.mjs 側のコメント参照）。
// 複製箇所がズレたら気づけるよう、複製側には必ず
// 「BENCH_FULLTEXT_CACHED_REF_ID (src/demo/bench-fixtures.ts)」とコメントすること。
//
// この ref_id は size=FULLTEXT_CACHED_REFERENCE_SIZE のときに「最初の通常論文行」になる
// インデックスから求める固定値（FALLBACK_BENCH_SIZE と同じ1000。run.mjs のPDFシナリオも
// この値と一致するサイズで実行する前提）。buildBenchReferences() は、実際に呼ばれた size の
// パーティションでこのインデックスが通常論文行の範囲に入っているときだけ
// fulltext_status='cached' 等を付与する（登録情報行・取り込み論文行に誤って付与しないための
// ガード）。size が大きく異なる（例: 10000, 50000）とこのインデックスは登録情報行の範囲に
// 入ってしまい、付与自体がスキップされる「安全側の無効化」になる
// （tests/bench-fixtures.test.ts で size=1000 のときは必ず付与されることを検証する）。
const FULLTEXT_CACHED_REFERENCE_SIZE = 1000;
const FULLTEXT_CACHED_PARTITION = computePartition(FULLTEXT_CACHED_REFERENCE_SIZE);
const FULLTEXT_CACHED_INDEX =
    FULLTEXT_CACHED_PARTITION.registrationCount + FULLTEXT_CACHED_PARTITION.importedPubCount + 1;
/** PDF表示・根拠ジャンプ計測の対象にする ref_id（上記コメント参照）。 */
export const BENCH_FULLTEXT_CACHED_REF_ID = benchRefId(FULLTEXT_CACHED_INDEX);

/**
 * フルテキストAI判定の根拠(evidence)。video/fixtures/demo-paper.pdf（生成元:
 * video/fixtures/demo-paper.html）に実在する文字列をそのまま抜粋する。
 * pdfRenderer.highlight()（src/fulltext/pdf-text-match.ts の findQuoteItems()）は
 * 空白圧縮・小文字化した部分一致でマッチするため、改行や句読点の位置は多少ずれても良いが、
 * 単語そのものは fixture のHTML本文と一致させる必要がある。
 */
const BENCH_FULLTEXT_LLM_EVIDENCE: FulltextEvidence[] = [
    {
        // Abstract 中の一文（demo-paper.html 1ページ目、最初の page-break より前）
        quote: 'Two trials on abdominal massage following colonoscopy suggested a possible benefit for reduced abdominal pain',
        page: 1,
        polarity: 'include',
    },
    {
        // "3. Results" > "3.1 Study selection" 冒頭（2ページ目、1つ目の page-break の後）
        quote: 'The search identified 812 records after deduplication',
        page: 2,
    },
    {
        // "4. Discussion" 冒頭付近（3ページ目、2つ目の page-break の後）
        quote: 'the overall certainty of the evidence was low to very low across all assessed outcomes',
        page: 3,
        polarity: 'exclude',
    },
];

/** BENCH_FULLTEXT_CACHED_REF_ID に付与するフルテキストAI判定の note（Decisions.note のJSON）。 */
function buildBenchFulltextLlmNote(executionId: string): FulltextLlmDecisionNote {
    return {
        type: 'llm_fulltext',
        execution_id: executionId,
        model: BENCH_LLM_MODEL,
        requested_model: BENCH_LLM_MODEL,
        include_probability: 0.72,
        reason: 'Bench fixture fulltext screening note for evidence-jump measurement (Issue #151 チャンク3b).',
        evidence: BENCH_FULLTEXT_LLM_EVIDENCE,
        prompt_version: 'bench-fixture-fulltext-v1',
    };
}

function buildRegistrationReference(index: number): Reference {
    const plan = planFor(index);
    const refIdValue = benchRefId(index);
    const trialId = `NCT-BENCH-${String(index).padStart(6, '0')}`;
    return {
        ref_id: refIdValue,
        title: `${capitalize(plan.design)} of ${plan.intervention} in ${plan.population} (trial registration)`,
        abstract: buildAbstract(index, plan),
        year: plan.year,
        authors: buildAuthors(index),
        journal: 'ClinicalTrials.gov (Bench Fixture)',
        pmid: trialId,
        url: `https://clinicaltrials.gov/study/${trialId}`,
        source: 'ClinicalTrials.gov',
        source_file: 'bench-fixture-registration',
        imported_at: DEMO_SEED_TIMESTAMP,
        imported_by: DEMO_USER_EMAIL,
        dedupe_key: `bench-dedupe-${refIdValue}`,
        record_type: 'registration',
        related_ref_id: '',
        duplicate_of: '',
    };
}

/**
 * 登録行（registrationIndex）から取り込まれた論文行を組み立てる。
 * src/lib/publication-import.ts の buildImportedPublicationReference() と同じ規則
 * （record_type='article' を確定値で書く・related_ref_id=発見元registration行のref_id・
 * source='Registry linkage (試験ID)' 形式）を踏襲しているが、bench-fixtures.ts は
 * src/lib/ 配下に依存できない制約があるため、その関数は呼ばずここで直接組み立てる。
 */
function buildImportedPublicationReferenceBench(index: number, registrationIndex: number): Reference {
    const plan = planFor(index);
    const refIdValue = benchRefId(index);
    const registrationRefId = benchRefId(registrationIndex);
    const trialId = `NCT-BENCH-${String(registrationIndex).padStart(6, '0')}`;
    const pmidValue = `8${String(index).padStart(7, '0')}`;
    return {
        ref_id: refIdValue,
        title: buildTitle(index, plan),
        abstract: buildAbstract(index, plan),
        year: plan.year,
        authors: buildAuthors(index),
        journal: plan.journal,
        volume: String(1 + (index % 40)),
        issue: String(1 + (index % 12)),
        pages: `${100 + (index % 400)}-${120 + (index % 400)}`,
        doi: `10.9999/bench.${index}`,
        pmid: pmidValue,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmidValue}/`,
        source: `Registry linkage (${trialId})`,
        source_file: 'bench-fixture-imported-publication',
        imported_at: DEMO_SEED_TIMESTAMP,
        imported_by: DEMO_USER_EMAIL,
        dedupe_key: `bench-dedupe-${refIdValue}`,
        record_type: 'article',
        related_ref_id: registrationRefId,
        duplicate_of: '',
    };
}

function buildNormalArticleReference(index: number): Reference {
    const plan = planFor(index);
    const refIdValue = benchRefId(index);
    const pmidValue = `7${String(index).padStart(7, '0')}`;
    const built: Reference = {
        ref_id: refIdValue,
        title: buildTitle(index, plan),
        abstract: buildAbstract(index, plan),
        year: plan.year,
        authors: buildAuthors(index),
        journal: plan.journal,
        volume: String(1 + (index % 40)),
        issue: String(1 + (index % 12)),
        pages: `${100 + (index % 400)}-${120 + (index % 400)}`,
        issn: `19${String(10 + (index % 89)).padStart(2, '0')}-000${index % 10}`,
        doi: `10.9999/bench.${index}`,
        pmid: pmidValue,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmidValue}/`,
        source: 'PubMed',
        source_file: 'bench-fixture-article',
        imported_at: DEMO_SEED_TIMESTAMP,
        imported_by: DEMO_USER_EMAIL,
        dedupe_key: `bench-dedupe-${refIdValue}`,
        related_ref_id: '',
        duplicate_of: '',
    };
    if (index === FULLTEXT_CACHED_INDEX) {
        // PDF先頭ページ・根拠ジャンプ計測用（Issue #151（#150 工程0）チャンク3b）。
        // src/demo/seed.ts の buildRealDemoReferences() が demo-ref-001 に対して行っているのと
        // 同じ組み立て（fulltext_status='cached' ＋ Drive URL・コピーID）。
        built.fulltext_status = 'cached';
        built.fulltext_url = `https://drive.google.com/file/d/${DEMO_FULLTEXT_DRIVE_FILE_ID}/view`;
        built.fulltext_drive_copy_id = DEMO_FULLTEXT_DRIVE_FILE_ID;
    }
    return built;
}

/**
 * 記事プール（登録情報行を除いた範囲）の末尾 duplicateCount 件を「重複として論理削除された行」
 * にし、記事プール前方（末尾ブロックと重ならない範囲）の行を残す側（生存側）として指す。
 * 末尾ブロックと前方ブロックが重ならないため、生存側は常に「生きている（duplicate_of が空の）
 * 別の行」になり、登録情報行・自分自身を指すことはない。
 */
function applyDuplicateFlags(refs: Reference[], partition: BenchPartition): void {
    const { n, registrationCount, articlePoolSize } = partition;
    const rawDuplicateCount = Math.floor(n * DUPLICATE_FRACTION);
    // 生存側を最低1件残すため、記事プールから最大 articlePoolSize-1 件までに抑える
    const duplicateCount = Math.max(0, Math.min(rawDuplicateCount, articlePoolSize - 1));
    if (duplicateCount === 0) return;

    const frontPoolSize = articlePoolSize - duplicateCount;
    for (let j = 0; j < duplicateCount; j += 1) {
        const sourceIndex = n - duplicateCount + 1 + j;
        const targetIndex = registrationCount + 1 + (j % frontPoolSize);
        refs[sourceIndex - 1].duplicate_of = benchRefId(targetIndex);
    }
}

export function buildBenchReferences(size: number): Reference[] {
    const partition = computePartition(size);
    const { n, registrationCount, importedPubCount } = partition;
    if (n === 0) return [];

    const refs: Reference[] = [];
    for (let i = 1; i <= n; i += 1) {
        if (i <= registrationCount) {
            refs.push(buildRegistrationReference(i));
        } else if (i <= registrationCount + importedPubCount) {
            refs.push(buildImportedPublicationReferenceBench(i, i - registrationCount));
        } else {
            refs.push(buildNormalArticleReference(i));
        }
    }

    applyDuplicateFlags(refs, partition);
    return refs;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface BenchDecisionSeed {
    decisionId: string;
    refId: string;
    reviewerId: string;
    decision: 'include' | 'exclude' | 'maybe';
    reason?: string;
    note?: string;
    decidedAt: string;
    clientVersion: string;
    screeningPhase: '' | 'fulltext';
}

/** index から決定論的に判定値を決める（約1/7がmaybe、残りのうち約1/3がexclude、他はinclude） */
function decisionValueFor(index: number): 'include' | 'exclude' | 'maybe' {
    const m = ((index % 7) + 7) % 7;
    if (m === 0) return 'maybe';
    return ((index % 3) + 3) % 3 === 0 ? 'exclude' : 'include';
}

// ---------------------------------------------------------------------------
// AIラウンド（LLM_Runs / LLM_Executions）
// ---------------------------------------------------------------------------

const BENCH_LLM_MODEL = 'bench-demo-model';
const BENCH_LLM_TIMESTAMP = isoFromOffsetSeconds(0); // 2026-01-01T00:00:00.000Z 固定
const BENCH_LLM_RUN_ID = 'bench-llm-run-000001';
const BENCH_LLM_EXECUTION_ID = `llm:${BENCH_LLM_MODEL}@${BENCH_LLM_TIMESTAMP}`;

export interface BenchLlmRound {
    run: LlmRun;
    execution: LlmExecution;
}

/**
 * 採用済み（is_active && status='confirmed'）AIラウンド1本分の LLM_Runs / LLM_Executions
 * データを組み立てる。
 *
 * オブジェクトを返す設計にした理由（ブリーフでは行=string[]を返す設計との選択を委ねられている）:
 * LLM_RUNS_HEADERS / LLM_EXECUTIONS_HEADERS の並び順に沿った string[] をここで直接組み立てる
 * には、そのヘッダー定義を bench-fixtures.ts 側へ複製する必要があるが、それは制約
 * （ヘッダー定義を複製しないこと）に反する。LlmRun / LlmExecution 型（src/lib/types.ts）の
 * プロパティ名はヘッダー名と一致しているため、呼び出し側（src/demo/seed.ts）が
 * src/lib/sheets/llm-history.ts の serializeLlmRunRow() と同じ「ヘッダー名でプロパティを引く」方式で
 * 行配列へ並べ替えられる。ヘッダー配列は seed.ts が既存の LLM_RUNS_HEADERS /
 * LLM_EXECUTIONS_HEADERS ミラーをそのまま使う。
 *
 * target_count は size に比例させる（LLM_TARGET_FRACTION の floor(size * 割合)）。
 * include_count は target_count のうち LLM_INCLUDE_FRACTION_OF_TARGET を floor した件数、
 * exclude_count は残り全部（target_count - include_count）にする。exclude_count を差分で
 * 求めることで、include_count 側の端数切り捨てがどう転んでも
 * include_count + exclude_count === target_count が常に成り立つ
 * （TiAbのAI一括判定では maybe/failed を持たせない）。
 */
export function buildBenchLlmRound(size: number): BenchLlmRound {
    const n = Math.max(0, Math.floor(size));
    const targetCount = Math.floor(n * LLM_TARGET_FRACTION);
    const includeCount = Math.floor(targetCount * LLM_INCLUDE_FRACTION_OF_TARGET);
    const excludeCount = targetCount - includeCount;

    const screeningPrompt = 'Bench fixture screening prompt (Issue #151 チャンク2)';

    const run: LlmRun = {
        run_id: BENCH_LLM_RUN_ID,
        config_hash: 'v1:bench-fixture',
        created_at: BENCH_LLM_TIMESTAMP,
        model: BENCH_LLM_MODEL,
        requested_model: BENCH_LLM_MODEL,
        temperature: 0.2,
        topP: 0.9,
        thinkingLevel: 'low',
        criteria_snapshot: null,
        screening_prompt: screeningPrompt,
        include_threshold: 0.5,
        status: 'confirmed',
        is_active: true,
    };

    const execution: LlmExecution = {
        execution_id: BENCH_LLM_EXECUTION_ID,
        execution_type: 'batch_screening',
        timestamp: BENCH_LLM_TIMESTAMP,
        model: BENCH_LLM_MODEL,
        requested_model: BENCH_LLM_MODEL,
        temperature: 0.2,
        topP: 0.9,
        thinkingLevel: 'low',
        criteria_snapshot: null,
        screening_prompt: screeningPrompt,
        include_threshold: 0.5,
        target_count: targetCount,
        include_count: includeCount,
        exclude_count: excludeCount,
        status: 'confirmed',
        is_active: true,
        run_id: BENCH_LLM_RUN_ID,
    };

    return { run, execution };
}

export function buildBenchDecisionSeeds(size: number): BenchDecisionSeed[] {
    const n = Math.max(0, Math.floor(size));
    if (n === 0) return [];

    const seeds: BenchDecisionSeed[] = [];
    let decisionSeq = 0;
    const nextDecisionId = (): string => {
        decisionSeq += 1;
        return `bench-dec-${String(decisionSeq).padStart(7, '0')}`;
    };

    // --- 1) 本人（DEMO_USER_EMAIL）のTiAb判定（全体の約40%、端数切り捨て） ---
    const tiabCount = Math.floor(n * TIAB_HUMAN_FRACTION);
    const tiabIndices = strideIndices(n, tiabCount, 1);
    // うち約1/4（端数切り捨て）は判定変更履歴（2-3行）を持たせる。追記専用ログの再現。
    const historyCount = Math.floor(tiabCount * HISTORY_FRACTION_OF_TIAB);

    tiabIndices.forEach((refIndex, pos) => {
        const finalDecision = decisionValueFor(refIndex);
        const hasHistory = pos < historyCount;
        const revisionCount = hasHistory ? 2 + (refIndex % 2) : 1; // 履歴ありは2件 or 3件
        for (let rev = 0; rev < revisionCount; rev += 1) {
            const isFinal = rev === revisionCount - 1;
            // 履歴の途中行は最終判定と異なる式で値を決め、「判定を変更した」履歴を再現する
            const value = isFinal ? finalDecision : decisionValueFor(refIndex + rev + 101);
            seeds.push({
                decisionId: nextDecisionId(),
                refId: benchRefId(refIndex),
                reviewerId: DEMO_USER_EMAIL,
                decision: value,
                reason: value === 'exclude' ? benchExcludeReason(refIndex + rev) : undefined,
                // revision が大きいほど decided_at が新しくなるようにし、最新行が一意に決まるようにする
                decidedAt: isoFromOffsetSeconds(refIndex * 7 + rev),
                clientVersion: DEMO_HUMAN_CLIENT_VERSION,
                screeningPhase: '',
            });
        }
    });

    // --- 2) 同僚（DEMO_COLLEAGUE_EMAIL）のTiAb判定（全体の約30%） ---
    const colleagueCount = Math.floor(n * COLLEAGUE_FRACTION);
    // start=2 にして本人セット（start=1）と位相をずらす。ストライドが異なるため、
    // 一部は本人セットと重なり（比較対象になる）、一部は本人未判定の行になる。
    const colleagueIndices = strideIndices(n, colleagueCount, 2);
    colleagueIndices.forEach((refIndex) => {
        // 本人の式（decisionValueFor(refIndex)）とはあえてオフセットをずらし、
        // 重なる行の一部で判定が不一致になるようにする。
        const value = decisionValueFor(refIndex + 1);
        seeds.push({
            decisionId: nextDecisionId(),
            refId: benchRefId(refIndex),
            reviewerId: DEMO_COLLEAGUE_EMAIL,
            decision: value,
            reason: value === 'exclude' ? benchExcludeReason(refIndex + 1) : undefined,
            decidedAt: isoFromOffsetSeconds(refIndex * 7 + 3),
            clientVersion: DEMO_HUMAN_CLIENT_VERSION,
            screeningPhase: '',
        });
    });

    // --- 3) フルテキスト判定: 本人がTiAbでincludeにした行の約半分 ---
    const includedTiabIndices = tiabIndices.filter((refIndex) => decisionValueFor(refIndex) === 'include');
    const fulltextCount = Math.floor(includedTiabIndices.length * FULLTEXT_FRACTION_OF_INCLUDED);
    const fulltextIndices = strideIndices(includedTiabIndices.length, fulltextCount, 1)
        .map((pos) => includedTiabIndices[pos - 1]);
    fulltextIndices.forEach((refIndex) => {
        const value = decisionValueFor(refIndex + 5);
        seeds.push({
            decisionId: nextDecisionId(),
            refId: benchRefId(refIndex),
            reviewerId: DEMO_USER_EMAIL,
            decision: value,
            reason: value === 'exclude' ? benchExcludeReason(refIndex + 5) : undefined,
            // TiAb判定より確実に後の時刻になるよう大きなオフセットを足す
            decidedAt: isoFromOffsetSeconds(refIndex * 7 + 500000),
            clientVersion: DEMO_HUMAN_CLIENT_VERSION,
            screeningPhase: 'fulltext',
        });
    });

    // --- 4) AI（LLM）判定: buildBenchLlmRound(n) の採用ラウンドと execution_id で整合させる ---
    const llmRound = buildBenchLlmRound(n);
    const llmIndices = strideIndices(n, llmRound.execution.target_count, 3);
    llmIndices.forEach((refIndex, pos) => {
        const value: 'include' | 'exclude' = pos < llmRound.execution.include_count ? 'include' : 'exclude';
        seeds.push({
            decisionId: nextDecisionId(),
            refId: benchRefId(refIndex),
            reviewerId: llmRound.execution.execution_id,
            decision: value,
            reason: value === 'exclude' ? benchExcludeReason(refIndex + 7) : undefined,
            decidedAt: isoFromOffsetSeconds(refIndex * 7 + 4),
            clientVersion: BENCH_LLM_CLIENT_VERSION,
            screeningPhase: '',
        });
    });

    // --- 5) フルテキストAI判定: 根拠ジャンプ計測用に BENCH_FULLTEXT_CACHED_REF_ID へ1件だけ
    //     追加する（Issue #151（#150 工程0）チャンク3b）。buildBenchReferences() と同じ
    //     パーティション判定で、この ref_id が実際に通常論文行として存在する size のときだけ
    //     追加する（存在しない size に判定だけ浮いて残ることを防ぐガード）。
    //     reviewer_id は llmRound.execution.execution_id と揃える。Config の
    //     fulltext_ai_active_round も同じ execution_id にする必要があり、
    //     src/demo/seed.ts の buildDemoConfig() 側で行う（fulltext.ts の findAiFulltext() が
    //     reviewer_id===採用ラウンドの判定のみを拾うため）。
    const fulltextCachedPartitionForSize = computePartition(n);
    const fulltextCachedRefIsNormalArticle =
        FULLTEXT_CACHED_INDEX > fulltextCachedPartitionForSize.registrationCount + fulltextCachedPartitionForSize.importedPubCount
        && FULLTEXT_CACHED_INDEX <= n;
    if (fulltextCachedRefIsNormalArticle) {
        seeds.push({
            decisionId: nextDecisionId(),
            refId: BENCH_FULLTEXT_CACHED_REF_ID,
            reviewerId: llmRound.execution.execution_id,
            decision: 'include',
            decidedAt: isoFromOffsetSeconds(FULLTEXT_CACHED_INDEX * 7 + 900000),
            clientVersion: BENCH_LLM_CLIENT_VERSION,
            screeningPhase: 'fulltext',
            note: JSON.stringify(buildBenchFulltextLlmNote(llmRound.execution.execution_id)),
        });
    }

    return seeds;
}
