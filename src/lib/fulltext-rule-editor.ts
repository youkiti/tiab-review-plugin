// fulltext-rule-editor.ts - フルテキスト候補ルールエディタ（共通UIコンポーネント）
//
// フルテキストページとサイドパネルの全文タブの両方から使う。
// voterチェックボックス・必要票数・プリセット・候補件数プレビュー・保存を
// 指定コンテナ内に描画する。永続化は onSave コールバックで呼び出し側が行う。
//
// クラス名は fulltext.css の ft-rule-* を踏襲する（サイドパネル側は
// fulltext-tab.css に同名クラスのスタイルを持つ）。

import { t } from './i18n';
import {
    discoverVoters,
    isInFulltextPool,
} from './fulltext-pool';
import type { FulltextPoolRule, VoterInfo } from './fulltext-pool';
import type { Decision } from './types';

export interface RuleEditorOptions {
    container: HTMLElement;
    references: Array<{ ref_id: string }>;
    decisions: Decision[];
    currentRule: FulltextPoolRule | null;
    keyOpened: boolean;
    isAdmin?: boolean;
    /** 管理者がキー開封を実行。完了後の再マウントは呼び出し側が行う */
    onOpenKey?: () => Promise<void>;
    /** ルールの永続化と後続のUI更新。throw するとエラー表示される */
    onSave: (rule: FulltextPoolRule) => Promise<void>;
    onClose: () => void;
}

/**
 * ルールエディタを container 内に描画する（既存内容は破棄）
 */
export function mountRuleEditor(opts: RuleEditorOptions): void {
    const { container } = opts;
    container.innerHTML = '';

    // キー未開封時はルール編集をブロック（他レビュアーの判定が見えない状態で
    // プロジェクト共有ルールを決めるべきではない）
    if (!opts.keyOpened) {
        const blocked = document.createElement('div');
        blocked.className = 'ft-rule-blocked';
        const message = document.createElement('div');
        message.textContent = t('ftRule_blocked');
        blocked.appendChild(message);
        if (opts.isAdmin && opts.onOpenKey) {
            const openKeyBtn = document.createElement('button');
            openKeyBtn.className = 'btn btn-primary ft-rule-open-key-btn';
            openKeyBtn.textContent = t('ftRule_openKeyBtn');
            openKeyBtn.addEventListener('click', () => {
                openKeyBtn.disabled = true;
                opts.onOpenKey!()
                    .finally(() => {
                        // キャンセル時に再度押せるように戻す（成功時は再マウントで破棄される）
                        openKeyBtn.disabled = false;
                    });
            });
            blocked.appendChild(openKeyBtn);
        } else {
            const hint = document.createElement('div');
            hint.className = 'ft-rule-blocked-hint';
            hint.textContent = t('ftRule_blockedAskAdmin');
            blocked.appendChild(hint);
        }
        container.appendChild(blocked);
        return;
    }

    const voters: VoterInfo[] = discoverVoters(opts.decisions);

    // 編集中の一時状態: 既存ルール、なければ「人間のみ・1票」
    const selected = new Set<string>(
        opts.currentRule
            ? opts.currentRule.voters
            : voters.filter(v => v.kind === 'human').map(v => v.key)
    );
    let threshold = opts.currentRule?.threshold ?? 1;

    const form = document.createElement('div');
    form.className = 'ft-rule-form';

    const desc = document.createElement('p');
    desc.className = 'ft-rule-desc';
    desc.textContent = t('ftRule_desc');
    form.appendChild(desc);

    const votersDiv = document.createElement('div');
    votersDiv.className = 'ft-rule-voters';
    form.appendChild(votersDiv);

    const thresholdRow = document.createElement('div');
    thresholdRow.className = 'ft-rule-threshold-row';
    const thresholdLabel = document.createElement('label');
    thresholdLabel.textContent = t('ftRule_thresholdLabel');
    const thresholdSelect = document.createElement('select');
    thresholdSelect.className = 'ft-rule-threshold';
    const voterCountSpan = document.createElement('span');
    voterCountSpan.className = 'ft-rule-voter-count';
    thresholdRow.append(thresholdLabel, thresholdSelect, voterCountSpan);
    form.appendChild(thresholdRow);

    const presets = document.createElement('div');
    presets.className = 'ft-rule-presets';
    const presetsLabel = document.createElement('span');
    presetsLabel.textContent = t('ftRule_presetsLabel');
    const presetHumanBtn = document.createElement('button');
    presetHumanBtn.className = 'btn btn-secondary';
    presetHumanBtn.textContent = t('ftRule_presetHuman');
    const presetMajorityBtn = document.createElement('button');
    presetMajorityBtn.className = 'btn btn-secondary';
    presetMajorityBtn.textContent = t('ftRule_presetMajority');
    presets.append(presetsLabel, presetHumanBtn, presetMajorityBtn);
    form.appendChild(presets);

    const preview = document.createElement('div');
    preview.className = 'ft-rule-preview';
    form.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'ft-rule-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = t('ftRule_save');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = t('ftRule_close');
    actions.append(saveBtn, closeBtn);
    form.appendChild(actions);

    container.appendChild(form);

    // 1文献ごとの判定マップ（プレビュー件数計算用）
    const byRef = new Map<string, Decision[]>();
    for (const d of opts.decisions) {
        const list = byRef.get(d.ref_id);
        if (list) {
            list.push(d);
        } else {
            byRef.set(d.ref_id, [d]);
        }
    }

    function renderVoters(): void {
        votersDiv.innerHTML = '';
        if (voters.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ft-rule-voter-empty';
            empty.textContent = t('ftRule_noVoters');
            votersDiv.appendChild(empty);
        }
        for (const voter of voters) {
            const row = document.createElement('label');
            row.className = 'ft-rule-voter-row';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(voter.key);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selected.add(voter.key);
                } else {
                    selected.delete(voter.key);
                }
                renderThreshold();
                renderPreview();
            });

            const label = document.createElement('span');
            label.textContent = voter.label;

            const count = document.createElement('span');
            count.className = 'ft-voter-count';
            count.textContent = t('ftRule_includeCount', String(voter.includeCount));

            row.append(checkbox, label, count);
            votersDiv.appendChild(row);
        }
    }

    function renderThreshold(): void {
        const max = Math.max(1, selected.size);
        if (threshold > max) threshold = max;

        thresholdSelect.innerHTML = '';
        for (let i = 1; i <= max; i++) {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = String(i);
            if (i === threshold) option.selected = true;
            thresholdSelect.appendChild(option);
        }
        voterCountSpan.textContent = t('ftRule_voterCount', String(selected.size));
    }

    function renderPreview(): void {
        if (selected.size === 0) {
            preview.textContent = t('ftRule_selectVoter');
            return;
        }
        const rule: FulltextPoolRule = {
            version: 1,
            voters: [...selected],
            threshold,
        };
        const count = opts.references.filter(
            r => isInFulltextPool(byRef.get(r.ref_id) ?? [], rule)
        ).length;
        preview.textContent = t('ftRule_preview', [String(count), String(opts.references.length)]);
    }

    thresholdSelect.addEventListener('change', () => {
        threshold = Number(thresholdSelect.value) || 1;
        renderPreview();
    });

    presetHumanBtn.addEventListener('click', () => {
        selected.clear();
        for (const v of voters) {
            if (v.kind === 'human') selected.add(v.key);
        }
        threshold = 1;
        renderVoters();
        renderThreshold();
        renderPreview();
    });

    presetMajorityBtn.addEventListener('click', () => {
        selected.clear();
        for (const v of voters) selected.add(v.key);
        threshold = Math.floor(selected.size / 2) + 1;
        renderVoters();
        renderThreshold();
        renderPreview();
    });

    saveBtn.addEventListener('click', () => {
        if (selected.size === 0) {
            renderPreview();
            return;
        }
        const rule: FulltextPoolRule = {
            version: 1,
            voters: [...selected],
            threshold,
        };
        saveBtn.disabled = true;
        saveBtn.textContent = t('ftRule_saving');
        opts.onSave(rule)
            .catch(err => {
                preview.textContent = t('ftRule_saveFailed', (err as Error).message);
            })
            .finally(() => {
                saveBtn.disabled = false;
                saveBtn.textContent = t('ftRule_save');
            });
    });

    closeBtn.addEventListener('click', () => opts.onClose());

    renderVoters();
    renderThreshold();
    renderPreview();
}
