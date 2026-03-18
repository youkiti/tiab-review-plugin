// ICTRP XML パーサー

import type { Reference } from './types';
import { truncateAbstract, truncateField, generateDedupeKey } from './import-helpers';

/**
 * abstract に合成する要素の順序定義
 * 主要情報（Python版互換）を先頭に、追加の臨床情報を末尾に配置
 * データを落とさない方針
 */
const ABSTRACT_ELEMENTS_PRIMARY = [
    'Condition', 'Intervention', 'Study_design',
];

const ABSTRACT_ELEMENTS_SECONDARY = [
    'Study_type', 'Phase', 'Primary_outcome', 'Secondary_outcome',
    'Inclusion_Criteria', 'Exclusion_Criteria', 'Countries',
    'Recruitment_Status', 'Target_size',
    'Inclusion_agemin', 'Inclusion_agemax', 'Inclusion_gender',
    'Public_title', 'Primary_sponsor', 'Secondary_Sponsor',
    'Source_Support', 'Prospective_registration', 'Date_enrollement',
];

/** 専用フィールドにマッピングされる要素（abstractには含めない） */
const MAPPED_ELEMENTS = new Set([
    'Scientific_title', 'TrialID', 'web_address',
    'Date_registration', 'Source_Register',
]);

/** メタデータ要素（abstractに含めない） */
const EXCLUDED_PREFIXES = [
    'Export_date', 'Internal_Number', 'Last_Refreshed_on',
    'Date_registration3', 'other_records',
    'Ethics_review_', 'results_', 'Contact_',
];

/**
 * 要素名が除外対象かどうか
 */
function isExcludedElement(tagName: string): boolean {
    return EXCLUDED_PREFIXES.some(prefix =>
        tagName === prefix || tagName.startsWith(prefix)
    );
}

/**
 * Trial要素からReferenceに変換
 */
function trialToReference(trial: Element, sourceFile?: string): Reference | null {
    const getText = (tag: string): string => {
        const el = trial.querySelector(tag);
        return el?.textContent?.trim() || '';
    };

    const title = getText('Scientific_title');
    if (!title) return null;

    const trialId = getText('TrialID');
    const webAddress = getText('web_address');
    const dateRegistration = getText('Date_registration');
    const sourceRegister = getText('Source_Register');

    // Date_registration から年を抽出（例: "29/12/2025" → 2025）
    const yearMatch = dateRegistration.match(/\d{4}/);

    // abstract 合成（データを落とさない方針）
    const abstractParts: string[] = [];

    // 主要情報（Python版互換）
    for (const tag of ABSTRACT_ELEMENTS_PRIMARY) {
        const val = getText(tag);
        if (val) abstractParts.push(`${tag}: ${val}`);
    }

    // 追加の臨床情報
    for (const tag of ABSTRACT_ELEMENTS_SECONDARY) {
        const val = getText(tag);
        if (val) abstractParts.push(`${tag}: ${val}`);
    }

    // 定義済みリストにない要素も追加（将来の要素追加に対応）
    const knownElements = new Set([
        ...ABSTRACT_ELEMENTS_PRIMARY,
        ...ABSTRACT_ELEMENTS_SECONDARY,
        ...MAPPED_ELEMENTS,
    ]);

    const children = trial.children;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const tagName = child.tagName;
        if (knownElements.has(tagName) || isExcludedElement(tagName)) continue;
        const val = child.textContent?.trim();
        if (val) abstractParts.push(`${tagName}: ${val}`);
    }

    const abstractText = abstractParts.join(' | ');

    return {
        ref_id: crypto.randomUUID(),
        title: truncateField(title)!,
        abstract: truncateAbstract(abstractText || undefined),
        year: yearMatch ? parseInt(yearMatch[0], 10) : undefined,
        pmid: trialId || undefined,
        url: truncateField(webAddress || undefined),
        journal: 'ICTRP',
        source: truncateField(sourceRegister) || 'ICTRP',
        source_file: truncateField(sourceFile),
        imported_at: new Date().toISOString(),
        dedupe_key: generateDedupeKey(title, trialId || undefined, undefined),
    };
}

/**
 * ICTRP XML コンテンツをパースして Reference 配列に変換
 */
export function parseICTRP(content: string, sourceFile?: string): Reference[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');

    // パースエラーチェック
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        console.error('[parseICTRP] XML parse error:', parseError.textContent);
        return [];
    }

    const trials = doc.querySelectorAll('Trial');
    const references: Reference[] = [];

    trials.forEach(trial => {
        const ref = trialToReference(trial, sourceFile);
        if (ref) references.push(ref);
    });

    return references;
}

/**
 * ICTRP XML ファイルをパース
 */
export async function parseICTRPFile(file: File): Promise<Reference[]> {
    const content = await file.text();
    return parseICTRP(content, file.name);
}

/**
 * XML コンテンツが ICTRP 形式かどうかを判定
 */
export function isICTRPFormat(content: string): boolean {
    return content.includes('<Trial>') || content.includes('ICTRP');
}
