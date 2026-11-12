// 除外理由の文を機械的な規則で区分に寄せる。
// 評価のための近似であり、Cochrane-bench の正解ではない。
const rules: Record<string, RegExp[]> = {
    population: [
        /\b(wrong|ineligible|incorrect|inappropriate|different|not (the )?(eligible|relevant|target))\s+(patient\s+)?(population|participants?|patients?|age group)\b/i,
        /\bpopulation\s+(was|is|were)\s+(incorrect|wrong|ineligible|not)\b/i,
        /^\s*(ineligible\s+)?population\b/i,
    ],
    intervention: [
        /\b(wrong|ineligible|incorrect|inappropriate|different)\s+(interventions?|exposures?|treatments?)\b/i,
        /\bintervention\s+(was|is|were|did)\s+not\b/i,
        /^\s*(ineligible\s+)?interventions?\b/i,
    ],
    comparator: [
        /\b(wrong|ineligible|incorrect|inappropriate|no( appropriate)?|inadequate)\s+(comparators?|comparisons?|control( groups?)?)\b/i,
        /^\s*(ineligible\s+)?comparators?\b/i,
    ],
    outcome: [
        /\b(wrong|ineligible|irrelevant|incorrect|no( relevant)?)\s+(outcomes?|outcome measures?)\b/i,
        /\b(did not|does not|not)\s+(report|measure|assess)\w*\s+(on\s+)?(the\s+)?(relevant\s+)?outcomes?\b/i,
        /^\s*(ineligible\s+)?outcomes?\b/i,
    ],
    study_design: [
        /\b(wrong|ineligible|incorrect|inappropriate)\s+(study\s+)?design\b/i,
        /\bnot\s+(an?\s+)?(rct|randomi[sz]ed)\b/i,
        /\bnon-?randomi[sz]ed\b/i,
        /\b(observational|cohort|case[- ]control|cross-sectional|case series|case report|before[- ]and[- ]after|qualitative)\s+(study|design)\b/i,
        /\b(systematic|narrative|literature)\s+review\b/i,
        /\b(editorial|commentary|letter)\b/i,
    ],
    duplicate: [/\bduplicate\b/i],
};
export function mapReasons(text: string): Set<string> {
    return new Set(Object.entries(rules).filter(([, expressions]) => expressions.some(re => re.test(text))).map(([key]) => key));
}
