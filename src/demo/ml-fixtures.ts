// デモ「ML」プロファイル用の合成文献データ生成
//
// ML タブ（TF-IDF + Naive Bayes によるランキング）は state.references.length >= 1000
// （src/lib/ml/cmh-defaults.ts の CMH_DEFAULTS.minRecords）でのみ開放されるため、
// 実データ10件だけでは画面を開けない。ここでは実データに続く合成文献1,090件を
// インデックスから決定論的に組み立てる（Math.random() / Date.now() は一切使わない。
// Playwright 録画のたびに同じ内容が再現される必要があるため）。
//
// 合成文献のタイトル・抄録には研究デザイン語（"randomized" / "meta-analysis" /
// "case report" / "protocol"）を意図的に混ぜ込み、Config シートに既にシードされている
// include_keywords / exclude_keywords（"randomized, meta-analysis" / "case report, protocol"）
// と一致させている。これにより後述の合成ヒト判定（40件）が「ランダムな正解」ではなく
// デザイン語と相関したラベルになり、TF-IDF/NaiveBayes ランキングが学習後に
// 未判定文献の並びを実際に入れ替える様子をデモできる。

import type { Reference } from '../lib/types';
import { DEMO_SEED_TIMESTAMP, DEMO_USER_EMAIL } from './constants';

/** 合成文献の総数（実データ10件と合わせて 1,100 件 = ML 開放条件を満たす） */
export const SYNTHETIC_REFERENCE_COUNT = 1090;

// ---------------------------------------------------------------------------
// 語彙プール（すべて固定・index からの決定論的な選択にのみ使う）
// ---------------------------------------------------------------------------

const POPULATIONS = [
    'adult patients with type 2 diabetes mellitus',
    'children with acute otitis media',
    'postmenopausal women with osteoporosis',
    'patients undergoing elective cardiac surgery',
    'critically ill patients in the intensive care unit',
    'patients with chronic obstructive pulmonary disease',
    'pregnant women with gestational hypertension',
    'elderly patients with hip fracture',
    'patients with major depressive disorder',
    'patients with rheumatoid arthritis',
    'neonates with respiratory distress syndrome',
    'patients with stage III colorectal cancer',
    'patients with chronic kidney disease on hemodialysis',
    'adolescents with generalized anxiety disorder',
];

const INTERVENTIONS = [
    'a structured exercise rehabilitation program',
    'early initiation of metformin therapy',
    'a nurse-led telephone follow-up intervention',
    'high-dose vitamin D supplementation',
    'a laparoscopic surgical approach',
    'a mobile health application for self-monitoring',
    'perioperative goal-directed fluid therapy',
    'cognitive behavioral therapy delivered via telemedicine',
    'a multidisciplinary care bundle',
    'an early mobilization protocol',
    'a single preoperative dose of prophylactic antibiotics',
    'continuous glucose monitoring',
    'a low-sodium dietary intervention',
    'remote patient monitoring with wearable sensors',
];

const COMPARATORS = [
    'standard care',
    'placebo',
    'a wait-list control',
    'conventional therapy',
    'usual outpatient follow-up',
    'an open surgical approach',
    'no intervention',
    'delayed treatment initiation',
];

const OUTCOMES = [
    '30-day all-cause mortality',
    'length of hospital stay',
    'HbA1c reduction at 12 weeks',
    'patient-reported quality of life',
    'the rate of postoperative complications',
    'readmission within 90 days',
    'pain scores measured by visual analogue scale',
    'functional recovery at 6 months',
    'the incidence of surgical site infection',
    'change in disease activity score',
    'time to symptom resolution',
    'health-related costs at 1 year',
    'adherence to treatment at 6 months',
    'the rate of intensive care unit admission',
];

/**
 * 研究デザイン語プール。
 * 0-3: include_keywords（randomized, meta-analysis）と一致する語を含む「include寄り」デザイン
 * 4-7: exclude_keywords（case report, protocol）と一致する語を含む「exclude寄り」デザイン
 * 8-9: どちらのキーワードにも一致しない中立デザイン
 */
const DESIGNS = [
    'randomized controlled trial',
    'randomized clinical trial',
    'systematic review and meta-analysis',
    'meta-analysis of randomized trials',
    'case report',
    'case report and literature review',
    'study protocol',
    'trial protocol',
    'prospective cohort study',
    'cross-sectional study',
];
const INCLUDE_SIGNAL_DESIGN_MAX_INDEX = 3;
const EXCLUDE_SIGNAL_DESIGN_MAX_INDEX = 7;

const JOURNALS = [
    'Journal of Clinical Epidemiology (Demo)',
    'International Journal of Evidence Synthesis (Demo)',
    'Annals of Internal Medicine Reports (Demo)',
    'BMJ Open Reviews (Demo)',
    'Journal of Applied Clinical Research (Demo)',
    'Cochrane Methodology Digest (Demo)',
    'European Journal of Health Outcomes (Demo)',
    'Asia-Pacific Journal of Medicine (Demo)',
    'Journal of Perioperative Care (Demo)',
    'Global Public Health Reviews (Demo)',
    'Journal of Rehabilitation Science (Demo)',
    'Clinical Trials Quarterly (Demo)',
];

const LAST_NAMES = [
    'Tanaka', 'Suzuki', 'Yamamoto', 'Watanabe', 'Kobayashi',
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones',
    'Garcia', 'Martinez', 'Müller', 'Rossi', 'Nguyen',
];
const INITIALS = ['A', 'B', 'C', 'H', 'J', 'K', 'M', 'R', 'S', 'T'];

function capitalize(text: string): string {
    return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** 決定論的な擬似乱数っぽい選択のための単純ハッシュ（index から安定値を作るだけの用途） */
function pick<T>(pool: T[], seed: number): T {
    return pool[((seed % pool.length) + pool.length) % pool.length];
}

interface SyntheticPlan {
    designIndex: number;
    population: string;
    intervention: string;
    comparator: string;
    outcome: string;
    design: string;
    journal: string;
    year: number;
}

/** index（1始まり、合成文献内での通し番号）から組み立てプランを決定論的に導出する */
function planFor(index: number): SyntheticPlan {
    const designIndex = index % DESIGNS.length;
    return {
        designIndex,
        population: pick(POPULATIONS, index * 3 + 1),
        intervention: pick(INTERVENTIONS, index * 5 + 2),
        comparator: pick(COMPARATORS, index * 7 + 3),
        outcome: pick(OUTCOMES, index * 11 + 4),
        design: DESIGNS[designIndex],
        journal: pick(JOURNALS, index * 13 + 5),
        year: 2004 + (index % 21), // 2004-2024
    };
}

/** true: このデザインは include_keywords（randomized / meta-analysis）と語が一致する */
export function isIncludeSignalDesign(designIndex: number): boolean {
    return designIndex <= INCLUDE_SIGNAL_DESIGN_MAX_INDEX;
}

/** true: このデザインは exclude_keywords（case report / protocol）と語が一致する */
export function isExcludeSignalDesign(designIndex: number): boolean {
    return designIndex > INCLUDE_SIGNAL_DESIGN_MAX_INDEX && designIndex <= EXCLUDE_SIGNAL_DESIGN_MAX_INDEX;
}

function buildTitle(index: number, plan: SyntheticPlan): string {
    const templateIndex = index % 4;
    const design = capitalize(plan.design);
    switch (templateIndex) {
        case 0:
            return `${design}: ${capitalize(plan.intervention)} versus ${plan.comparator} for ${plan.outcome} in ${plan.population}`;
        case 1:
            return `Effect of ${plan.intervention} on ${plan.outcome} among ${plan.population}: a ${plan.design}`;
        case 2:
            return `${design} of ${plan.intervention} for ${plan.population}: focus on ${plan.outcome}`;
        default:
            return `Comparing ${plan.intervention} and ${plan.comparator} in ${plan.population}: a ${plan.design}`;
    }
}

function buildAbstract(index: number, plan: SyntheticPlan): string {
    const n = 40 + (index % 460); // 40-499（症例数 or 統合対象研究数）
    const isSynthesis = plan.designIndex === 2 || plan.designIndex === 3; // meta-analysis系
    const sampleUnit = isSynthesis ? `${n} studies` : `${n} participants`;
    const favorsIntervention = index % 2 === 0;
    const directionPhrase = favorsIntervention
        ? `a significant improvement`
        : `no significant difference`;
    const pValue = favorsIntervention ? '0.0' + String(1 + (index % 9)) : '0.' + String(30 + (index % 60));
    const ciLow = (0.4 + (index % 30) / 100).toFixed(2);
    const ciHigh = (1.1 + (index % 40) / 100).toFixed(2);
    const conclusion = isIncludeSignalDesign(plan.designIndex)
        ? `These findings provide evidence relevant to ${plan.intervention} and warrant consideration in future systematic reviews and clinical guidance.`
        : isExcludeSignalDesign(plan.designIndex)
            ? `Given the descriptive nature of this report, no generalizable conclusions regarding efficacy can be drawn and further controlled studies are needed.`
            : `Further prospective research with longer follow-up is needed to confirm these observational findings.`;

    return [
        `Background: ${capitalize(plan.population)} frequently experience substantial clinical burden, and the optimal management strategy remains uncertain in routine practice.`,
        `Objective: This ${plan.design} aimed to evaluate ${plan.intervention} compared with ${plan.comparator} for ${plan.outcome} in ${plan.population}.`,
        `Methods: We conducted a ${plan.design} enrolling ${plan.population}. Participants were allocated to receive ${plan.intervention} or ${plan.comparator}, and the primary outcome was ${plan.outcome}, assessed using standardized instruments at predefined follow-up timepoints. Analyses followed an intention-to-treat approach, and where applicable, a random-effects meta-analytic model was used to pool effect estimates across included studies.`,
        `Results: A total of ${sampleUnit} were analyzed. ${capitalize(plan.intervention)} was associated with ${directionPhrase} in ${plan.outcome} relative to ${plan.comparator} (p=${pValue}, 95% CI ${ciLow}-${ciHigh}). Adverse events were infrequent and did not differ meaningfully between groups.`,
        `Conclusion: ${conclusion}`,
    ].join(' ');
}

function buildAuthors(index: number): string {
    const a1 = pick(LAST_NAMES, index * 17 + 6);
    const i1 = pick(INITIALS, index * 19 + 7);
    const a2 = pick(LAST_NAMES, index * 23 + 8);
    const i2 = pick(INITIALS, index * 29 + 9);
    return index % 3 === 0
        ? `${a1} ${i1}, ${a2} ${i2}, et al.`
        : `${a1} ${i1}, ${a2} ${i2}`;
}

/**
 * 合成文献1,090件を組み立てる。
 * globalNumber（demo-ref-XXX の連番）は 11 から始まる（1-10 は実データ用に予約済み）。
 */
export function buildSyntheticReferences(): Reference[] {
    const refs: Reference[] = [];
    for (let index = 1; index <= SYNTHETIC_REFERENCE_COUNT; index += 1) {
        const globalNumber = 10 + index;
        const plan = planFor(index);
        const refId = `demo-ref-${String(globalNumber).padStart(3, '0')}`;
        const pmid = `9${String(index).padStart(6, '0')}`;
        refs.push({
            ref_id: refId,
            title: buildTitle(index, plan),
            abstract: buildAbstract(index, plan),
            year: plan.year,
            authors: buildAuthors(index),
            journal: plan.journal,
            volume: String(10 + (index % 50)),
            issue: String(1 + (index % 12)),
            pages: `${100 + (index % 400)}-${120 + (index % 400)}`,
            issn: `19${String(10 + (index % 89)).padStart(2, '0')}-000${index % 10}`,
            doi: `10.9999/demo.ml.${globalNumber}`,
            pmid,
            url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
            source: 'PubMed',
            source_file: 'demo-ml-profile-synthetic',
            imported_at: DEMO_SEED_TIMESTAMP,
            imported_by: DEMO_USER_EMAIL,
            dedupe_key: `demo-ml-dedupe-${globalNumber}`,
        });
    }
    return refs;
}

export interface SyntheticDecisionSeed {
    /** buildSyntheticReferences() が生成した文献内でのインデックス（1-1090） */
    syntheticIndex: number;
    decision: 'include' | 'exclude';
}

/**
 * ML学習用の合成ヒト判定（40件）を組み立てる。
 * stride=27, start=5 で 1,090 件中から均等に間引くと、designIndex (= i % 10) の剰余が
 * gcd(27,10)=1 のため 10個の剰余を1周ずつ均等に巡回する（40件 = 4周）。
 * これにより include 系デザイン(0-3) 16件・exclude 系デザイン(4-7) 16件・
 * 中立デザイン(8-9) 8件（偶奇で include/exclude に均等配分）と、include/exclude が
 * ちょうど20件ずつになるよう構成している。
 */
export function buildSyntheticDecisionSeeds(): SyntheticDecisionSeed[] {
    const seeds: SyntheticDecisionSeed[] = [];
    const stride = 27;
    const start = 5;
    const count = 40;
    for (let k = 0; k < count; k += 1) {
        const syntheticIndex = start + stride * k;
        const designIndex = syntheticIndex % DESIGNS.length;
        let decision: 'include' | 'exclude';
        if (isIncludeSignalDesign(designIndex)) {
            decision = 'include';
        } else if (isExcludeSignalDesign(designIndex)) {
            decision = 'exclude';
        } else {
            decision = k % 2 === 0 ? 'include' : 'exclude';
        }
        seeds.push({ syntheticIndex, decision });
    }
    return seeds;
}
