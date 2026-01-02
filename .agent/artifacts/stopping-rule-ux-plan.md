# 停止基準の初期設定UX改善計画

## 概要

MLタブを初めて開いたときに、停止基準についてユーザーに確認を求めるUIを実装する。

## 現状の問題

- 停止基準が自動的に50に設定されるが、ユーザーへの説明がない
- 停止基準の意味がわからないユーザーにとって不親切

## 改善案

### フロー

```
[MLタブを初めて開く]
    ↓
[停止基準が未確認の場合]
    ↓
[確認ダイアログ表示]
    ┌─────────────────────────────────────────┐
    │ 📊 停止基準の設定                        │
    ├─────────────────────────────────────────┤
    │                                         │
    │ 連続で50件Excludeされたら               │
    │ スクリーニング終了を提案します。         │
    │                                         │
    │ 推奨: 50件 [▼]                          │
    │                                         │
    │ ⓘ 詳しくはASReviewの議論を参照:        │
    │    🔗 Stopping Criteria Discussion      │
    │                                         │
    │ [この設定で開始]                        │
    └─────────────────────────────────────────┘
    ↓
[設定をブラウザに保存]
    ↓
[MLレビュー開始]
    ↓
[学習状態セクションは折りたたみ可能に]
```

### 保存データ

```typescript
// chrome.storage.local に保存
{
    mlStoppingRuleConfirmed: true,
    mlStoppingRuleThreshold: 50
}
```

## 実装詳細

### 1. 初期ダイアログの表示

**ファイル:** `src/sidepanel/features/ml/stopping.ts`

```typescript
/**
 * 初回セットアップダイアログを表示
 */
export function showInitialStoppingRuleDialog(
    onConfirm: (threshold: number) => void
) {
    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="margin-bottom: 8px;">
                連続で <strong><span id="threshold-display">50</span>件</strong> Excludeされたら<br>
                スクリーニング終了を提案します。
            </p>
            
            <div style="margin: 16px 0;">
                <label>推奨値: </label>
                <select id="initial-threshold-select" style="padding: 4px 8px;">
                    <option value="30">30件</option>
                    <option value="50" selected>50件（推奨）</option>
                    <option value="100">100件</option>
                    <option value="200">200件</option>
                </select>
            </div>
            
            <div style="background: #f0f4f8; padding: 12px; border-radius: 6px; font-size: 12px;">
                <p style="margin: 0;">
                    ⓘ わからない場合は50件で問題ありません。<br>
                    詳しくは 
                    <a href="https://github.com/asreview/asreview/discussions/557" 
                       target="_blank" 
                       style="color: #1a73e8;">
                       ASReviewの議論
                    </a> 
                    を参照してください。
                </p>
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
    confirmBtn.textContent = 'この設定で開始';
    confirmBtn.onclick = () => {
        const threshold = parseInt(select.value, 10);
        onConfirm(threshold);
        hideModal();
    };
    footer.appendChild(confirmBtn);
    
    showModal({
        title: '📊 停止基準の設定',
        body: body,
        footer: footer
    });
}
```

### 2. 設定の永続化

**ファイル:** `src/sidepanel/features/ml/actions.ts`

```typescript
// 設定の保存
async function saveStoppingRuleToStorage(threshold: number) {
    await chrome.storage.local.set({
        mlStoppingRuleConfirmed: true,
        mlStoppingRuleThreshold: threshold
    });
}

// 設定の読み込み
async function loadStoppingRuleFromStorage(): Promise<{ confirmed: boolean; threshold: number }> {
    const result = await chrome.storage.local.get(['mlStoppingRuleConfirmed', 'mlStoppingRuleThreshold']);
    return {
        confirmed: result.mlStoppingRuleConfirmed === true,
        threshold: result.mlStoppingRuleThreshold || 50
    };
}
```

### 3. activateMlTab の更新

```typescript
export async function activateMlTab() {
    state.setCurrentTab('ml');
    renderMlSection();

    if (state.mlState.status === 'idle') {
        // ストレージから設定を読み込み
        const savedRule = await loadStoppingRuleFromStorage();
        
        if (!savedRule.confirmed) {
            // 初回: ダイアログを表示
            showInitialStoppingRuleDialog(async (threshold) => {
                // 設定を保存
                await saveStoppingRuleToStorage(threshold);
                
                // 停止基準を設定
                state.setMlState({
                    ...state.mlState,
                    stoppingRule: createStoppingRule(threshold)
                });
                
                renderMlStats();
                await initMlWorker();
            });
        } else {
            // 2回目以降: 保存された設定を使用
            if (!state.mlState.stoppingRule) {
                state.setMlState({
                    ...state.mlState,
                    stoppingRule: createStoppingRule(savedRule.threshold)
                });
            }
            await initMlWorker();
        }
    }
}
```

### 4. 学習状態カードの折りたたみ

**ファイル:** `src/sidepanel/sidepanel.html`

```html
<!-- 学習状態・停止基準 (折りたたみ可能) -->
<div class="llm-card collapsible">
    <h4 class="collapsible-header">
        📊 学習状態
        <span class="collapse-icon">▼</span>
    </h4>
    <div class="collapsible-content">
        <!-- 既存の内容 -->
    </div>
</div>
```

### 5. 折りたたみのイベントリスナー

既存の `collapsible` クラスの挙動を利用。LLMセクションと同じ仕組み。

## 変更対象ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/sidepanel/features/ml/stopping.ts` | `showInitialStoppingRuleDialog` 関数追加 |
| `src/sidepanel/features/ml/actions.ts` | ストレージ読み書き、activateMlTab更新 |
| `src/sidepanel/sidepanel.html` | 学習状態カードを折りたたみ可能に |

## 見積もり時間

約20分

## テスト項目

- [ ] 初回MLタブ表示時にダイアログが表示される
- [ ] ダイアログから値を選択して確定できる
- [ ] 確定後、設定がブラウザに保存される
- [ ] 2回目以降はダイアログなしで保存された値が使用される
- [ ] ASReviewリンクが新しいタブで開く
- [ ] 学習状態カードが折りたたみ可能
