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
    /**
     * パスB（論文候補探索）で使う。CTGにリンクされた関連論文のPMID（'BACKGROUND' 種別の
     * 参照は除外済み。重複は排除し、元の出現順を保つ）。
     */
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
    /**
     * CTGov API v2 が返す参照分類。'BACKGROUND'（試験結果と無関係な背景文献）/ 'RESULT'
     * （スポンサーが手動登録した結果論文）/ 'DERIVED'（PubMed側がそのNCT番号を参照している
     * 論文。結果論文の主要な供給源）のいずれか。fetchCtgStudy() 側でBACKGROUNDのみ除外する
     * （詳細は同関数内のコメント参照）。
     */
    type?: string;
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

        // 論文候補探索（パスB）の素材となるPMID。'BACKGROUND'（試験結果と無関係な背景文献）
        // だけを denylist で除外する。
        //
        // 'RESULT' のみの allowlist にはしない: CTGovの 'DERIVED' は「PubMed側がそのNCT番号を
        // 参照している論文」で、結果論文の主要な供給源。'RESULT' はスポンサーが手動登録した
        // 分しか入らないため、allowlistにすると取りこぼしが大きい。目的（結果論文の候補探索）
        // に対しては 'BACKGROUND' のdenylistが妥当。
        // type欠落・未知の値（将来API側に新種別が増えた場合を含む）は残す側に倒す（後方互換）。
        const pmids: string[] = [];
        const seenPmids = new Set<string>();
        for (const ref of protocol.referencesModule?.references ?? []) {
            const type = ref.type?.trim().toUpperCase();
            if (type === 'BACKGROUND') continue;
            const pmid = ref.pmid?.trim();
            if (!pmid || seenPmids.has(pmid)) continue;
            seenPmids.add(pmid);
            pmids.push(pmid);
        }

        return { title, fields, pmids };
    } catch {
        return null;
    }
}
