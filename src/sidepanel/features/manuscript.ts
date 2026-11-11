/**
 * 論文用テキスト（Methods / Results / PRISMA 2020 フロー数値）のモーダル表示
 *
 * TiAb エクスポートメニューとフルテキスト結果ビューから呼び出し、
 * 現在のプロジェクトデータから英語の下書きを生成してモーダルで表示する。
 * 各セクションはボタンでクリップボードへコピーできる。
 *
 * 文章・数値の組み立ては src/lib/manuscript-text.ts の buildManuscriptOutput()（純関数）にある。
 * ここは「state と通信から入力を組み立てる → 純関数を呼ぶ → DOM に出す」だけの層。
 * シートの行から出力までの通しの検査は tests/manuscript-e2e.test.ts にある。
 */

import { state } from '../state';
import { buildManuscriptValidationSentence } from '../../lib/manuscript-ai';
import { t } from '../../lib/i18n';
import { showModal, hideModal } from '../ui/modal';
import { showToast } from '../ui/feedback';
import { getFulltextEnabledJudges } from './fulltext/lazy';
import { getClientVersion } from '../../lib/client-version';
import { AI_EVALUATION_DATASET_DOI, conceptDoiUrl } from '../../lib/citation';
import { parseClientSemver } from '../../lib/manuscript-version';
import { getSpreadsheetInfo, getReferences, getLlmExecutions, getLlmRuns } from '../../lib/sheets-api';
import { buildManuscriptOutput } from '../../lib/manuscript-text';
import type { ManuscriptPhase, ManuscriptInput } from '../../lib/manuscript-text';
import type { ReferenceWithStatus, LlmExecution } from '../../lib/types';

export type { ManuscriptPhase };

// ---------------------------------------------------------------------------
// モーダル表示
// ---------------------------------------------------------------------------

function buildSectionElement(label: string, text: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'manuscript-section';

    const head = document.createElement('div');
    head.className = 'manuscript-section-head';

    const title = document.createElement('span');
    title.className = 'manuscript-section-title';
    title.textContent = label;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-small btn-secondary';
    copyBtn.textContent = t('manuscript_copy');
    copyBtn.addEventListener('click', () => {
        void (async () => {
            try {
                await navigator.clipboard.writeText(text);
                showToast(t('manuscript_copied'), 2000);
            } catch (error) {
                console.error('[manuscript] clipboard write failed:', error);
                showToast(t('manuscript_copyFailed'), 3000);
            }
        })();
    });

    head.appendChild(title);
    head.appendChild(copyBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'manuscript-textarea';
    textarea.readOnly = true;
    textarea.value = text;
    const lineCount = text.split('\n').length;
    textarea.rows = Math.min(Math.max(lineCount + 1, 4), 14);

    section.appendChild(head);
    section.appendChild(textarea);
    return section;
}

/**
 * 論文用テキストのモーダルを表示する
 * @param phase 'tiab' = TiAb相まで / 'fulltext' = フルテキスト相を含む全体
 */
export async function showManuscriptModal(phase: ManuscriptPhase): Promise<void> {
    let validationSentence = '';
    if (phase === 'tiab') {
        try {
            const runs = await getLlmRuns(state.spreadsheetId);
            validationSentence = runs.filter(run => run.is_active && run.status === 'confirmed')
                .map(buildManuscriptValidationSentence).filter(Boolean).join('\n\n');
        } catch {
            // 検証記録の取得失敗を「比較なし」と断定しない。
        }
    }
    let executions: LlmExecution[] = [];
    try {
        executions = await getLlmExecutions(state.spreadsheetId, true);
    } catch {
        // 履歴を取得できない場合は設定未記録として文を組み立てる。
    }
    // プロジェクト名（PRISMAブロックの見出し用。取得失敗時はフォールバック）
    let projectTitle = 'TiAb Review project';
    try {
        projectTitle = (await getSpreadsheetInfo(state.spreadsheetId)).title;
    } catch {
        console.log('[manuscript] Could not get spreadsheet title');
    }

    // Identification 集計は論理削除された行（重複、duplicate_of 非空）も含めた全件が必要
    // （Issue #145 チャンク2。除外件数を duplicatesTotal へ合算するため）。state.allReferences は
    // selectReferencesWithStatus() 経由で論理削除済みの行が既に取り除かれているため使えず、
    // ここで getReferences() を呼んで全件を取り直す。取得に失敗した場合は state.allReferences へ
    // フォールバックするが、その場合は論理削除件数を数えられない（黙って過少になる）ため、
    // refsMayOmitLogicallyDeleted=true を ManuscriptInput へ渡し、duplicatesTotal を
    // 明示的に「合計不明」にする（数字が断りなく狂うことを防ぐ）。
    let allReferencesForIdentification: Pick<ReferenceWithStatus, 'source_file' | 'related_ref_id' | 'duplicate_of'>[] = state.allReferences;
    let refsMayOmitLogicallyDeleted = false;
    try {
        allReferencesForIdentification = await getReferences(state.spreadsheetId);
    } catch {
        console.log('[manuscript] Could not get full references (including logically-deleted); falling back to state.allReferences');
        refsMayOmitLogicallyDeleted = true;
    }

    const now = new Date();
    const generatedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // 判定者選択（enabledJudges）は結果ビュー（features/fulltext/results.ts、Issue #155（#150 工程4）で
    // 遅延読み込みチャンクへ移動）の現在値を lazy.ts 経由で読む。本体が未ロードなら null（全員集計）
    // になり、フルテキストタブを一度も開いていない場合の従来の既定値と一致する。
    const input: ManuscriptInput = {
        phase,
        projectTitle,
        generatedDate,
        currentVersion: parseClientSemver(getClientVersion()) ?? 'unknown',
        conceptDoiUrl: conceptDoiUrl(),
        evaluationDatasetDoi: AI_EVALUATION_DATASET_DOI,
        identificationRefs: allReferencesForIdentification,
        refsMayOmitLogicallyDeleted,
        references: state.allReferences,
        importStats: state.importStats,
        fulltextPoolRule: state.fulltextPoolRule,
        fulltextAssignment: state.fulltextAssignment,
        assignmentConfig: state.assignmentConfig,
        treatMlAsManual: state.treatMlAsManual,
        mlStoppingRule: state.mlState.stoppingRule,
        llmIncludeThreshold: state.llmConfig.llm_include_threshold,
        llmExecutions: executions,
        validationSentence,
        excludeReasonItems: state.excludeReasonItems,
        enabledJudges: phase === 'fulltext' ? getFulltextEnabledJudges() : null,
        userEmail: state.userEmail,
        isKeyOpened: state.isKeyOpened,
    };
    const { methods, results, prisma, warnings: warningItems } = buildManuscriptOutput(input);
    // 警告は純関数がキーと引数で返し、翻訳はここで行う
    const warnings = warningItems.map(w => ('args' in w ? t(w.key, w.args) : t(w.key)));

    const body = document.createElement('div');
    body.className = 'manuscript-modal';

    const disclaimer = document.createElement('div');
    disclaimer.className = 'manuscript-note';
    disclaimer.textContent = t('manuscript_disclaimer');
    body.appendChild(disclaimer);

    const versionNote = document.createElement('div');
    versionNote.className = 'manuscript-note';
    versionNote.textContent = t('manuscript_versionNote');
    body.appendChild(versionNote);

    for (const warning of warnings) {
        const el = document.createElement('div');
        el.className = 'manuscript-warning';
        el.textContent = `⚠ ${warning}`;
        body.appendChild(el);
    }

    body.appendChild(buildSectionElement('Methods', methods));
    body.appendChild(buildSectionElement('Results', results));
    body.appendChild(buildSectionElement(t('manuscript_sectionPrisma'), prisma));

    const footer = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = t('manuscript_close');
    closeBtn.addEventListener('click', () => hideModal());
    footer.appendChild(closeBtn);

    showModal({
        title: t('manuscript_modalTitle'),
        body,
        footer,
    });
}
