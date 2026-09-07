import { t } from '../../../lib/i18n';
import { state } from '../../state';
import {
    calculateThresholdFromPercent,
    STOPPING_PRESETS,
    canUseCmhStopping,
    isCmhStoppingReached,
    getCmhStoppingProgressPercent
} from '../../../lib/ml/stopping-rules';
import {
    createStoppingRule,
    createCmhStoppingRule,
    CmhStoppingRule,
    isCmhStoppingRule
} from '../../../lib/ml/types';
import { CMH_DEFAULTS } from '../../../lib/ml/cmh';
import { showModal, hideModal } from '../../ui/modal';
import { renderMlStats } from './render';
import { bulkExcludeRemaining, getMlStats, resetAndStartNewMlReview } from './operations';
import { saveStoppingRuleToStorage } from './stopping-storage';
import { showToast } from '../../ui/feedback';

// Store互換レイヤー（Phase 5）
import { setMlState as syncSetMlState } from '../../store/compat';

/**
 * 初回セットアップダイアログを表示（CMH対応）
 */
export function showInitialStoppingRuleDialog(
    onConfirm: (threshold: number) => void
) {
    const totalRecords = state.references.length;
    const canUseCmh = canUseCmhStopping(totalRecords);

    // CMH が使える場合は CMH 設定ダイアログを表示
    if (canUseCmh) {
        showCmhSetupDialog(onConfirm);
    } else {
        // N < 1000 の場合は旧ダイアログを表示
        showLegacyStoppingRuleDialog(onConfirm, totalRecords);
    }
}

/**
 * CMH セットアップダイアログ
 */
function showCmhSetupDialog(onConfirm: (threshold: number) => void) {
    const totalRecords = state.references.length;

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom: 16px;">
            <div style="background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0; font-size: 14px; line-height: 1.6;">
                    <strong>📊 統計的停止基準（CMH）</strong><br>
                    目標リコール <strong>${(CMH_DEFAULTS.targetRecall * 100).toFixed(0)}%</strong> を
                    信頼水準 <strong>${(CMH_DEFAULTS.confidence * 100).toFixed(0)}%</strong> で達成したと判断できた時点で
                    停止を提案します。
                </p>
            </div>
            
            <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
                <p style="margin: 0 0 8px 0; font-weight: 500;">スクリーニング手順:</p>
                <ol style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8;">
                    <li>最初の <strong>${CMH_DEFAULTS.initialRandomSize}件</strong> はランダムに提示</li>
                    <li>その後は ML の優先順位に従って提示</li>
                    <li>統計基準を満たしたら停止を提案</li>
                </ol>
            </div>
            
            <div style="font-size: 12px; color: #666; line-height: 1.5;">
                <p style="margin: 0;">
                    ⓘ 詳しくは
                    <a href="https://doi.org/10.1186/s13643-020-01521-4" 
                       target="_blank" 
                       style="color: #1a73e8; text-decoration: underline;">
                       Callaghan & Müller-Hansen (2020)
                    </a>
                    を参照してください。
                </p>
            </div>
        </div>
    `;

    // フッター
    const footer = document.createElement('div');
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-full';
    confirmBtn.textContent = t('ml_startWithSettings');
    confirmBtn.onclick = () => {
        // CMH ルールを作成して state に設定
        const cmhRule = createCmhStoppingRule();
        syncSetMlState({
            ...state.mlState,
            stoppingRule: cmhRule,
            screeningPhase: 'initial_random',
        });

        // 後方互換性のため threshold も渡す
        onConfirm(cmhRule.initialRandomSize);
        hideModal();
    };
    footer.appendChild(confirmBtn);

    showModal({
        title: t('ml_cmhSettingsTitle'),
        body: body,
        footer: footer
    });
}

/**
 * 旧停止基準ダイアログ（N < 1000 の場合）
 */
function showLegacyStoppingRuleDialog(
    onConfirm: (threshold: number) => void,
    totalRecords: number
) {
    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom: 16px;">
            <div style="background: #fff3e0; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
                <p style="margin: 0; font-size: 13px; color: #e65100;">
                    ⚠️ レコード数が ${totalRecords} 件のため、統計的停止基準は使用できません。<br>
                    連続除外ルールを使用します。
                </p>
            </div>
            
            <p style="margin-bottom: 12px; line-height: 1.6;">
                連続で <strong><span id="threshold-display">50</span>件</strong> Excludeされたら<br>
                スクリーニング終了を提案します。
            </p>
            
            <div style="margin: 16px 0;">
                <label style="font-weight: 500;">推奨値: </label>
                <select id="initial-threshold-select" style="padding: 6px 12px; border-radius: 4px; border: 1px solid #ccc;">
                    <option value="30">30件</option>
                    <option value="50" selected>50件（推奨）</option>
                    <option value="100">100件</option>
                    <option value="200">200件</option>
                </select>
            </div>
        </div>
    `;

    // セレクトボックスの変更を反映
    const select = body.querySelector('#initial-threshold-select') as HTMLSelectElement;
    const display = body.querySelector('#threshold-display') as HTMLElement;
    select.onchange = () => {
        display.textContent = select.value;
    };

    // フッター
    const footer = document.createElement('div');
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-full';
    confirmBtn.textContent = t('ml_startWithSettings');
    confirmBtn.onclick = () => {
        const threshold = parseInt(select.value, 10);
        onConfirm(threshold);
        hideModal();
    };
    footer.appendChild(confirmBtn);

    showModal({
        title: t('ml_stoppingCriteriaTitle'),
        body: body,
        footer: footer
    });
}

export function showStoppingSettingsDialog() {
    const totalRecords = state.references.length;
    const rule = state.mlState.stoppingRule;

    // CMH ルールの場合
    if (isCmhStoppingRule(rule)) {
        showCmhSettingsDialog(rule, totalRecords);
        return;
    }

    // 旧ルールの場合
    let currentThreshold = rule?.threshold || 50;

    const body = document.createElement('div');
    body.innerHTML = `
        <div class="stopping-options-tabs">
            <button id="tab-custom" class="stopping-tab-btn active">${t('ml_customTab')}</button>
            <button id="tab-percent" class="stopping-tab-btn">${t('ml_percentageTab')}</button>
        </div>
        
        <div id="panel-custom">
            <label>${t('ml_consecutiveExcludeLabel')}</label>
            <input type="number" id="threshold-input" value="${currentThreshold}" min="1" max="${totalRecords}" style="width: 100%; padding: 8px; margin-top: 4px;">
            <p style="font-size: 12px; color: #666; margin-top: 4px;">
                ${t('ml_consecutiveExcludeHelp')}
            </p>
        </div>

        <div id="panel-percent" class="hidden">
            <label>${t('ml_datasetPercentageLabel')}</label>
            <div class="preset-chip-container" id="preset-container">
                <!-- presets generated by JS -->
            </div>
            <p style="font-size: 12px; color: #666;">
                選択した割合: <span id="calculated-count">-</span> 件
            </p>
        </div>
    `;

    // Presets generation
    const presetContainer = body.querySelector('#preset-container')!;
    STOPPING_PRESETS.forEach(preset => {
        const chip = document.createElement('div');
        chip.className = 'preset-chip';
        chip.textContent = `${preset.label}`;
        chip.onclick = () => {
            // Calculate count
            const count = calculateThresholdFromPercent(totalRecords, preset.percent);
            currentThreshold = count;
            updateDisplay();

            // Update active state
            presetContainer.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
        };
        presetContainer.appendChild(chip);
    });

    // Tab switching
    const tabCustom = body.querySelector('#tab-custom') as HTMLElement;
    const tabPercent = body.querySelector('#tab-percent') as HTMLElement;
    const panelCustom = body.querySelector('#panel-custom') as HTMLElement;
    const panelPercent = body.querySelector('#panel-percent') as HTMLElement;

    tabCustom.onclick = () => {
        tabCustom.classList.add('active');
        tabPercent.classList.remove('active');
        panelCustom.classList.remove('hidden');
        panelPercent.classList.add('hidden');
    };

    tabPercent.onclick = () => {
        tabPercent.classList.add('active');
        tabCustom.classList.remove('active');
        panelPercent.classList.remove('hidden');
        panelCustom.classList.add('hidden');
        updateDisplay();
    };

    // Update display helper
    const updateDisplay = () => {
        const input = body.querySelector('#threshold-input') as HTMLInputElement;
        const calcDisplay = body.querySelector('#calculated-count') as HTMLElement;

        input.value = currentThreshold.toString();
        calcDisplay.textContent = currentThreshold.toString();
    };

    const input = body.querySelector('#threshold-input') as HTMLInputElement;
    input.onchange = () => {
        currentThreshold = parseInt(input.value, 10) || 50;
    };

    // Footer buttons
    const footer = document.createElement('div');

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-small';
    saveBtn.textContent = t('common_save');
    saveBtn.onclick = () => {
        // Save to state - Store経由で更新
        const newRule = createStoppingRule(currentThreshold);
        syncSetMlState({
            ...state.mlState,
            stoppingRule: newRule
        });

        // ブラウザストレージに永続化
        saveStoppingRuleToStorage(currentThreshold);

        renderMlStats(); // Update UI
        hideModal();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline btn-small';
    cancelBtn.textContent = t('common_cancel');
    cancelBtn.onclick = () => hideModal();

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    showModal({
        title: t('ml_stoppingSettingsTitle'),
        body: body,
        footer: footer
    });
}

/**
 * CMH 設定ダイアログ（設定変更用）
 */
function showCmhSettingsDialog(rule: CmhStoppingRule, totalRecords: number) {
    const progressPercent = getCmhStoppingProgressPercent(rule);

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom: 16px;">
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span>${t('ml_targetRecall')}</span>
                    <strong>${(rule.targetRecall * 100).toFixed(0)}%</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span>${t('ml_confidenceLevel')}</span>
                    <strong>${(rule.confidence * 100).toFixed(0)}%</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span>${t('ml_screenedCount')}</span>
                    <strong>${rule.screened} / ${totalRecords}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span>Include:</span>
                    <strong style="color: #34a853;">${rule.included}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span>${t('ml_stoppingProbability')}</span>
                    <strong style="color: ${rule.canStop ? '#34a853' : '#666'};">
                        ${rule.canStop ? t('ml_canStop') : `${progressPercent}%`}
                    </strong>
                </div>
            </div>
            
            <div style="background: #e3f2fd; padding: 12px; border-radius: 6px;">
                <p style="margin: 0; font-size: 12px; line-height: 1.5;">
                    ${t('ml_cmhInfo')}
                </p>
            </div>
        </div>
    `;

    const footer = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-outline btn-full';
    closeBtn.textContent = t('common_close');
    closeBtn.onclick = () => hideModal();
    footer.appendChild(closeBtn);

    showModal({
        title: t('ml_cmhStatusTitle'),
        body: body,
        footer: footer
    });
}

/**
 * 停止到達ダイアログ（CMH対応）
 */
export function showStoppingReachedDialog(onContinue: (addCount: number) => void, onFinish: () => void) {
    const rule = state.mlState.stoppingRule;
    const totalRecords = state.references.length;

    // CMH ルールの場合
    if (isCmhStoppingRule(rule)) {
        showCmhStoppingReachedDialog(rule, totalRecords, onContinue, onFinish);
        return;
    }

    // 旧ルールの場合
    const body = document.createElement('div');
    body.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
            <p style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">${t('ml_reachedTitle')}</p>
            <p style="color: #666;">${t('ml_noRelevantFound')}</p>
        </div>
        
        <div class="list-item-btn" id="action-more">
            <span class="list-item-icon">📄</span>
            <div class="list-item-content">
                <span class="list-item-primary">${t('ml_review20More')}</span>
                <span class="list-item-secondary">${t('ml_thresholdPlus20')}</span>
            </div>
        </div>

        <div class="list-item-btn" id="action-finish">
            <span class="list-item-icon">🏁</span>
            <div class="list-item-content">
                <span class="list-item-primary">${t('ml_finishExcludeRest')}</span>
                <span class="list-item-secondary">${t('ml_saveAllExclude')}</span>
            </div>
        </div>
    `;

    // Bind actions
    body.querySelector('#action-more')!.addEventListener('click', () => {
        onContinue(20);
        hideModal();
    });

    body.querySelector('#action-finish')!.addEventListener('click', () => {
        hideModal();
        showBulkExcludeConfirmDialog(onFinish);
    });

    const footer = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-outline btn-small';
    closeBtn.textContent = t('ml_closeNoAction');
    closeBtn.onclick = () => hideModal();
    footer.appendChild(closeBtn);

    showModal({
        title: t('ml_stopRecommended'),
        body: body,
        footer: footer
    });
}

/**
 * CMH 停止到達ダイアログ
 */
function showCmhStoppingReachedDialog(
    rule: CmhStoppingRule,
    totalRecords: number,
    onContinue: (addCount: number) => void,
    onFinish: () => void
) {
    const remaining = totalRecords - rule.screened;
    const pValue = rule.probUnderTarget;

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
            <div style="font-size: 48px; margin-bottom: 8px;">✅</div>
            <p style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">${t('ml_cmhCriteriaMet')}</p>
            <p style="color: #666; font-size: 14px; line-height: 1.6;">
                目標リコール <strong>${(rule.targetRecall * 100).toFixed(0)}%</strong> を<br>
                信頼水準 <strong>${(rule.confidence * 100).toFixed(0)}%</strong> で達成したと推定されます。
            </p>
        </div>
        
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span>${t('ml_screenedCount')}</span>
                <strong>${rule.screened} 件</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span>Include:</span>
                <strong style="color: #34a853;">${rule.included} 件</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span>${t('ml_remainingUnread')}</span>
                <strong>${remaining} 件</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <span>${t('ml_pValue')}</span>
                <strong>${pValue.toFixed(4)}</strong>
            </div>
        </div>
        
        <div class="list-item-btn" id="action-audit">
            <span class="list-item-icon">🔍</span>
            <div class="list-item-content">
                <span class="list-item-primary">${t('ml_auditSamplingRecommended')}</span>
                <span class="list-item-secondary">${t('ml_auditRandomSample', String(CMH_DEFAULTS.auditSampleSize))}</span>
            </div>
        </div>

        <div class="list-item-btn" id="action-finish">
            <span class="list-item-icon">🏁</span>
            <div class="list-item-content">
                <span class="list-item-primary">${t('ml_finishWithoutAudit')}</span>
                <span class="list-item-secondary">${t('ml_saveAllExclude')}</span>
            </div>
        </div>
        
        <div class="list-item-btn" id="action-continue">
            <span class="list-item-icon">📄</span>
            <div class="list-item-content">
                <span class="list-item-primary">${t('ml_continueScreening')}</span>
                <span class="list-item-secondary">${t('ml_continueNoStop')}</span>
            </div>
        </div>
    `;

    // Bind actions
    body.querySelector('#action-audit')!.addEventListener('click', () => {
        hideModal();
        showAuditSamplingDialog(rule, totalRecords, onContinue, onFinish);
    });

    body.querySelector('#action-finish')!.addEventListener('click', () => {
        hideModal();
        showBulkExcludeConfirmDialog(onFinish);
    });

    body.querySelector('#action-continue')!.addEventListener('click', () => {
        onContinue(0);
        hideModal();
    });

    const footer = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-outline btn-small';
    closeBtn.textContent = t('ml_closeNoAction');
    closeBtn.onclick = () => hideModal();
    footer.appendChild(closeBtn);

    showModal({
        title: t('ml_stopRecommendedTitle'),
        body: body,
        footer: footer
    });
}

/**
 * 監査サンプリングダイアログ
 */
function showAuditSamplingDialog(
    rule: CmhStoppingRule,
    totalRecords: number,
    onContinue: (addCount: number) => void,
    onFinish: () => void
) {
    const remaining = totalRecords - rule.screened;
    const auditSize = Math.min(CMH_DEFAULTS.auditSampleSize, remaining);

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="font-size: 14px; line-height: 1.6; margin-bottom: 16px;">
                残り <strong>${remaining}件</strong> から
                <strong>${auditSize}件</strong> をランダムに抽出してレビューします。
            </p>
            
            <div style="background: #e8f5e9; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                <p style="margin: 0; font-size: 13px; line-height: 1.5;">
                    ✅ 監査で <strong>0件</strong> の Include が見つかった場合：<br>
                    → スクリーニング完了を確定
                </p>
            </div>
            
            <div style="background: #fff3e0; padding: 12px; border-radius: 6px;">
                <p style="margin: 0; font-size: 13px; line-height: 1.5;">
                    ⚠️ 監査で <strong>1件以上</strong> の Include が見つかった場合：<br>
                    → スクリーニング続行を強く推奨
                </p>
            </div>
        </div>
    `;

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline btn-small';
    cancelBtn.textContent = t('common_cancel');
    cancelBtn.onclick = () => hideModal();

    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary btn-small';
    startBtn.textContent = t('ml_startAudit');
    startBtn.onclick = () => {
        hideModal();
        // TODO: 監査サンプリングを実行
        showToast(t('ml_auditStartMessage', String(auditSize)));
        onContinue(auditSize);
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(startBtn);

    showModal({
        title: t('ml_auditTitle'),
        body: body,
        footer: footer
    });
}

/**
 * 一括Exclude確認ダイアログ
 */
function showBulkExcludeConfirmDialog(onComplete: () => void) {
    // 未判定件数を計算
    const stats = getMlStats();

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
            <p style="font-size: 14px; margin-bottom: 8px;">
                残り <strong>${stats.remaining}件</strong> の未判定文献を<br>
                すべて <span style="color: #ea4335; font-weight: bold;">Exclude</span> として保存します。
            </p>
            <p style="color: #666; font-size: 12px;">
                この操作は取り消せません。<br>
                個別に変更する場合はレビュー画面から行ってください。
            </p>
        </div>
        <div id="bulk-progress" style="display: none;">
            <div style="text-align: center; margin-bottom: 8px;">
                <span id="bulk-progress-text">処理中... 0 / ${stats.remaining}</span>
            </div>
            <div style="background: #e0e0e0; border-radius: 4px; height: 8px; overflow: hidden;">
                <div id="bulk-progress-bar" style="background: #1a73e8; height: 100%; width: 0%; transition: width 0.3s;"></div>
            </div>
        </div>
    `;

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.justifyContent = 'flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline btn-small';
    cancelBtn.textContent = t('common_cancel');
    cancelBtn.onclick = () => hideModal();

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-small';
    confirmBtn.textContent = t('common_execute');
    confirmBtn.onclick = async () => {
        // ボタンを無効化
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        confirmBtn.textContent = t('common_processing');

        // 進捗表示を表示
        const progressDiv = body.querySelector('#bulk-progress') as HTMLElement;
        const progressText = body.querySelector('#bulk-progress-text') as HTMLElement;
        const progressBar = body.querySelector('#bulk-progress-bar') as HTMLElement;
        progressDiv.style.display = 'block';

        // 一括Exclude実行
        const result = await bulkExcludeRemaining((current: number, total: number) => {
            progressText.textContent = t('ml_processingProgress', [String(current), String(total)]);
            progressBar.style.width = `${(current / total) * 100}%`;
        });

        hideModal();

        // 完了通知
        showToast(t('ml_savedExcludeCount', String(result.successCount)));

        // コールバック実行
        onComplete();

        // 完了画面を表示
        showMlCompleteDialog();
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);

    showModal({
        title: t('ml_confirmWarning'),
        body: body,
        footer: footer
    });
}

/**
 * ML完了ダイアログ
 */
function showMlCompleteDialog() {
    const stats = getMlStats();

    const body = document.createElement('div');
    body.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
            <p style="font-size: 24px; margin-bottom: 8px;">✅</p>
            <p style="font-size: 16px; font-weight: bold; margin-bottom: 16px;">${t('ml_reviewComplete')}</p>
            
            <div style="display: flex; justify-content: center; gap: 24px; margin-bottom: 16px;">
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #34a853;">${stats.include}</div>
                    <div style="font-size: 12px; color: #666;">Include</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #ea4335;">${stats.exclude}</div>
                    <div style="font-size: 12px; color: #666;">Exclude</div>
                </div>
            </div>
            
            <p style="font-size: 12px; color: #666;">
                ${t('ml_autoExcludedCount', String(stats.autoExcluded))}
            </p>
        </div>
    `;

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.flexDirection = 'column';
    footer.style.gap = '8px';

    const newReviewBtn = document.createElement('button');
    newReviewBtn.className = 'btn btn-primary btn-full';
    newReviewBtn.innerHTML = t('ml_startNewReview');
    newReviewBtn.onclick = async () => {
        hideModal();
        await resetAndStartNewMlReview();
    };

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-outline btn-full';
    backBtn.innerHTML = t('ml_backToReview');
    backBtn.onclick = () => {
        hideModal();
        document.getElementById('tab-screening')?.click();
    };

    footer.appendChild(newReviewBtn);
    footer.appendChild(backBtn);

    showModal({
        title: t('ml_reviewResultsTitle'),
        body: body,
        footer: footer
    });
}


