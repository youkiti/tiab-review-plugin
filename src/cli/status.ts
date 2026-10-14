// 状態確認は読み取りだけで完結し、抄録や API の応答本文は出力しない。
import { getSpreadsheetInfo, getReferences, getDecisionsRaw, collapseToLatestDecisions, getSheetValues, CONFIG_SHEET, parseAssignmentConfig, parseConfigBundle, parseFulltextAiActiveRound, getLlmHistory, selectActiveBatchIds } from '../lib/sheets-api';
import { getSpreadsheetPermissions } from '../lib/drive-permissions';
import { mergeReferencesWithAllDecisions, mergeReferencesWithStatus } from '../lib/reference-status';
import { collectReviewerKeys, summarizeTeamDecision, type TeamStatus } from '../lib/decision-summary';
import { computeReviewerKey, hasEffectiveConflict } from '../lib/decision-conflict';
import { isHumanDecision } from '../lib/client-version';
import { DEFAULT_USER_SETTINGS } from '../lib/user-settings';

export async function runStatus(spreadsheetId: string, userEmail: string) {
    const { title } = await getSpreadsheetInfo(spreadsheetId);
    const [references, raw, config, permissions] = await Promise.all([
        getReferences(spreadsheetId), getDecisionsRaw(spreadsheetId),
        getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`), getSpreadsheetPermissions(spreadsheetId),
    ]);
    const keyOpened = parseConfigBundle(config).keyOpened;
    const assignment = parseAssignmentConfig(config);
    const latest = collapseToLatestDecisions(raw);
    // AI 票がある場合だけ履歴を読み、旧形式の移行結果も保存せずに計算する。
    const history = latest.some(r => r.decision.reviewer_id.startsWith('llm:'))
        ? await getLlmHistory(spreadsheetId, true) : { llmRuns: [], llmExecutions: [] };
    const all = mergeReferencesWithAllDecisions(references, latest, userEmail,
        selectActiveBatchIds(history.llmRuns, history.llmExecutions), parseFulltextAiActiveRound(config), () => {});
    const visible = keyOpened ? all : mergeReferencesWithStatus(references, latest, userEmail, () => {});
    const treatMlAsManual = DEFAULT_USER_SETTINGS.treatMlAsManual;
    const enabled = new Set<string>(userEmail ? [userEmail] : []);
    if (keyOpened) visible.forEach(ref => ref.allDecisions?.forEach(d => {
        const key = computeReviewerKey(d, treatMlAsManual);
        if (key) enabled.add(key);
    }));
    const reviewerKeys = collectReviewerKeys(all, new Set(), treatMlAsManual);
    const team: Record<TeamStatus, number> = { pending: 0, incomplete: 0, conflict: 0, include: 0, exclude: 0, maybe: 0, blinded: 0 };
    const reviewers: Record<string, { include: number; exclude: number; maybe: number; notes: number }> = {};
    const bySource: Record<string, number> = {};
    // References 件数は論理削除済みを含む保存行数、画面の集計は表示対象のみ。
    references.forEach(ref => { const source = ref.source_file || '（未設定）'; bySource[source] = (bySource[source] ?? 0) + 1; });
    const rows = all.map(ref => {
        const summary = summarizeTeamDecision(ref, reviewerKeys, treatMlAsManual, assignment);
        team[summary.teamStatus]++;
        const humans = (ref.allDecisions ?? []).filter(d => isHumanDecision(d.client_version));
        for (const d of humans) {
            const counts = reviewers[d.reviewer_id] ??= { include: 0, exclude: 0, maybe: 0, notes: 0 };
            if (d.decision !== 'pending') {
                counts[d.decision]++;
                if (d.note?.trim()) counts.notes++;
            }
        }
        return {
            ref_id: ref.ref_id, pmid: ref.pmid ?? '', doi: ref.doi ?? '', team_status: summary.teamStatus,
            decisions: Object.fromEntries([...summary.byReviewer].map(([key, d]) => [key, {
                decision: d.decision, note: d.note ?? '', decided_at: d.decided_at,
            }])),
            has_human_consensus: raw.some(({ decision: d }) => d.ref_id === ref.ref_id &&
                (d.screening_phase ?? 'tiab') === 'tiab' && d.client_version?.includes('-human-consensus')),
        };
    });
    const filterConflict = visible.filter(ref => hasEffectiveConflict(ref, enabled, keyOpened, treatMlAsManual)).length;
    return {
        spreadsheet_id: spreadsheetId, title, references: { total: references.length, by_source: bySource, visible: all.length },
        key_opened: keyOpened, assignment_status: assignment.status, reviewers, team,
        filter_conflict: filterConflict, conflict_counts_differ: filterConflict !== team.conflict,
        filter_settings: { treatMlAsManual, enabledReviewers: [...enabled], userEmail },
        permissions: permissions.map(p => ({ email: p.emailAddress, role: p.role, type: p.type })), rows,
    };
}

export function statusText(status: Awaited<ReturnType<typeof runStatus>>): string {
    return [
        `プロジェクト: ${status.title}`,
        `References: ${status.references.total} 件（画面の対象 ${status.references.visible} 件）`,
        `取り込み元ごと: ${JSON.stringify(status.references.by_source)}`,
        `key_opened: ${status.key_opened} / 担当セット: ${status.assignment_status}`,
        `人の最新判定（メモあり件数を含む）: ${JSON.stringify(status.reviewers)}`,
        `チーム集計: ${JSON.stringify(status.team)}`,
        `画面の「不一致」: ${status.filter_conflict} 件${status.conflict_counts_differ ? '（チーム集計と異なります）' : ''}`,
        `画面の計算条件: ${JSON.stringify(status.filter_settings)}`,
        `共有済みユーザー: ${JSON.stringify(status.permissions)}`,
        '文献ごとの詳細は --json で出力',
    ].join('\n');
}
