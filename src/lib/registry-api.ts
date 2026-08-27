// registry-api.ts
// Issue #118「レジストリ連携フェーズ1」チャンク2（パスA）: 試験登録レコードの
// スナップショット生成に使う外部API取得を担当する。UI 非依存。
// レジストリ連携フェーズ1チャンク2パスB（論文候補探索）で PubMed/Europe PMC 検索を
// 足す際も、このファイルに fetch 担当の関数を追加していく想定。

/** fetchCtgStudy() が返すスナップショット用に整形済みのデータ */
export interface CtgStudySnapshot {
    title: string;
    /** buildRegistrySnapshotHtml() にそのまま渡せる形（値があるものだけを積む） */
    fields: Array<{ label: string; value: string }>;
    /** パスB（論文候補探索）で使う。CTGにリンクされた関連論文のPMID */
    pmids: string[];
}

// --- ClinicalTrials.gov API v2 レスポンスの型（使用する部分のみ定義。any は使わない） ---

interface CtgIdentificationModule {
    officialTitle?: string;
    briefTitle?: string;
}

interface CtgConditionsModule {
    conditions?: string[];
}

interface CtgIntervention {
    type?: string;
    name?: string;
}

interface CtgArmsInterventionsModule {
    interventions?: CtgIntervention[];
}

interface CtgOutcome {
    measure?: string;
}

interface CtgOutcomesModule {
    primaryOutcomes?: CtgOutcome[];
}

interface CtgDescriptionModule {
    briefSummary?: string;
}

interface CtgDateStruct {
    date?: string;
}

interface CtgStatusModule {
    overallStatus?: string;
    startDateStruct?: CtgDateStruct;
    completionDateStruct?: CtgDateStruct;
}

interface CtgMaskingInfo {
    masking?: string;
}

interface CtgDesignInfo {
    allocation?: string;
    interventionModel?: string;
    primaryPurpose?: string;
    maskingInfo?: CtgMaskingInfo;
}

interface CtgEnrollmentInfo {
    count?: number;
}

interface CtgDesignModule {
    studyType?: string;
    phases?: string[];
    designInfo?: CtgDesignInfo;
    enrollmentInfo?: CtgEnrollmentInfo;
}

interface CtgLeadSponsor {
    name?: string;
}

interface CtgSponsorCollaboratorsModule {
    leadSponsor?: CtgLeadSponsor;
}

interface CtgReference {
    pmid?: string;
}

interface CtgReferencesModule {
    references?: CtgReference[];
}

interface CtgProtocolSection {
    identificationModule?: CtgIdentificationModule;
    conditionsModule?: CtgConditionsModule;
    armsInterventionsModule?: CtgArmsInterventionsModule;
    outcomesModule?: CtgOutcomesModule;
    descriptionModule?: CtgDescriptionModule;
    statusModule?: CtgStatusModule;
    designModule?: CtgDesignModule;
    sponsorCollaboratorsModule?: CtgSponsorCollaboratorsModule;
    referencesModule?: CtgReferencesModule;
}

interface CtgStudyResponse {
    protocolSection?: CtgProtocolSection;
}

/**
 * ClinicalTrials.gov API v2 から試験の詳細を取得し、スナップショット用に整形して返す。
 *
 * ネットワーク失敗・非200・JSON不正のいずれも例外を投げず null を返す
 * （呼び出し側の src/lib/fulltext-retriever.ts が、References に保存済みのフィールドだけを
 * 使うフォールバック経路へ進む）。
 */
export async function fetchCtgStudy(nctId: string): Promise<CtgStudySnapshot | null> {
    try {
        const resp = await fetch(
            `https://clinicaltrials.gov/api/v2/studies/${encodeURIComponent(nctId)}?format=json`
        );
        if (!resp.ok) return null;

        const data = await resp.json() as CtgStudyResponse;
        const protocol = data.protocolSection;
        if (!protocol) return null;

        const title =
            protocol.identificationModule?.officialTitle?.trim() ||
            protocol.identificationModule?.briefTitle?.trim() ||
            nctId;

        const fields: Array<{ label: string; value: string }> = [];
        const push = (label: string, value: string | undefined): void => {
            const trimmed = value?.trim();
            if (trimmed) fields.push({ label, value: trimmed });
        };

        push('Conditions', protocol.conditionsModule?.conditions?.join(', '));
        push(
            'Interventions',
            protocol.armsInterventionsModule?.interventions
                ?.map(iv => [iv.type, iv.name].filter(Boolean).join(': '))
                .filter(Boolean)
                .join(' / ')
        );
        push(
            'Primary Outcome Measures',
            protocol.outcomesModule?.primaryOutcomes
                ?.map(o => o.measure)
                .filter(Boolean)
                .join(' / ')
        );
        push('Brief Summary', protocol.descriptionModule?.briefSummary);
        push('Status', protocol.statusModule?.overallStatus);
        push('Phase', protocol.designModule?.phases?.join(', '));
        const enrollmentCount = protocol.designModule?.enrollmentInfo?.count;
        push('Enrollment', enrollmentCount != null ? String(enrollmentCount) : undefined);
        push('Sponsor', protocol.sponsorCollaboratorsModule?.leadSponsor?.name);
        push('Study Type', protocol.designModule?.studyType);
        const designInfo = protocol.designModule?.designInfo;
        push(
            'Study Design',
            [
                designInfo?.allocation,
                designInfo?.interventionModel,
                designInfo?.primaryPurpose,
                designInfo?.maskingInfo?.masking,
            ].filter(Boolean).join(', ')
        );
        push('Start Date', protocol.statusModule?.startDateStruct?.date);
        push('Completion Date', protocol.statusModule?.completionDateStruct?.date);

        const pmids = (protocol.referencesModule?.references ?? [])
            .map(r => r.pmid)
            .filter((pmid): pmid is string => !!pmid);

        return { title, fields, pmids };
    } catch {
        return null;
    }
}
