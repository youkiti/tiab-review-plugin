# ML Enhanced Review 実装計画

## 概要

MLスクリーニング機能を拡張し、以下の機能を実装する:
1. ML画面での判定に「ML enhanced」マーカーを付与
2. 停止基準到達時に残りの未判定を一括exclude
3. 新規MLレビュー開始機能

---

## 1. ML Enhanced マーカー

### 目的
ML画面で行った判定を通常のレビュー画面で識別できるようにする。

### 実装方針

#### 選択肢A: reviewer_id にプレフィックス追加
```typescript
// 例: "user@example.com" → "ml:user@example.com"
reviewer_id: `ml:${state.userEmail}`
```
- ✅ シンプル
- ❌ 同一ユーザーの通常判定とML判定が別レビュアーとして扱われる

#### 選択肢B: note フィールドに source 情報を追加 (推奨)
```typescript
const decisionObj: Decision = {
    ...
    note: JSON.stringify({ source: 'ml', ...existingNote }),
};
```
- ✅ 既存の reviewer_id 構造を維持
- ✅ 通常のメモと共存可能
- ❌ JSON パースが必要

#### 選択肢C: client_version に情報追加
```typescript
client_version: '0.7.0-ml'
```
- ✅ シンプル
- ✅ 既存構造に影響なし
- ❌ バージョン情報と混在

### 推奨: 選択肢C (`client_version` 利用)

理由:
- 最もシンプルで影響範囲が小さい
- レビュー画面での表示時に `client_version.includes('-ml')` で判定可能

### 変更対象ファイル
- `src/sidepanel/features/ml/actions.ts`
  - `handleMlDecision()` 内の `client_version` を `'0.7.0-ml'` に変更
- `src/sidepanel/features/screening/render.ts`
  - `renderAllDecisions()` で ML 判定にバッジ表示

---

## 2. 残り全除外機能

### 目的
停止基準到達時に「終了」を選択すると、未判定レコードを一括でexcludeとして保存する。

### フロー
```
[停止基準到達]
    ↓
[ダイアログ表示]
    ├── "20件追加でレビュー" → 閾値を+20して続行
    └── "終了して残りを除外" → 残り全件をexclude保存
            ↓
        [確認ダイアログ]
            ├── "実行" → 一括保存 → 完了画面
            └── "キャンセル" → ダイアログに戻る
```

### 実装詳細

#### 2.1 一括exclude関数
```typescript
// src/sidepanel/features/ml/actions.ts

async function bulkExcludeRemaining(): Promise<number> {
    const unlabeledRefs = state.references.filter(r => 
        !r.myDecision || r.myDecision.decision === 'pending'
    );
    
    let successCount = 0;
    const batchSize = 10; // 並列処理数
    
    for (let i = 0; i < unlabeledRefs.length; i += batchSize) {
        const batch = unlabeledRefs.slice(i, i + batchSize);
        await Promise.all(batch.map(async (ref) => {
            const decision: Decision = {
                decision_id: crypto.randomUUID(),
                ref_id: ref.ref_id,
                reviewer_id: state.userEmail,
                decision: 'exclude',
                note: JSON.stringify({ auto_excluded: true, reason: 'ML stopping rule' }),
                decided_at: new Date().toISOString(),
                client_version: '0.7.0-ml-auto',
            };
            
            try {
                await apiSaveDecision(state.spreadsheetId, decision);
                ref.myDecision = decision;
                ref.status = 'exclude';
                successCount++;
            } catch (err) {
                console.error('Failed to auto-exclude:', ref.ref_id, err);
            }
        }));
        
        // 進捗表示更新
        updateBulkExcludeProgress(i + batch.length, unlabeledRefs.length);
    }
    
    return successCount;
}
```

#### 2.2 ダイアログ更新
```typescript
// src/sidepanel/features/ml/stopping.ts

// 「終了してエクスポート」を「終了して残りを除外」に変更
// onFinish コールバックで bulkExcludeRemaining() を呼び出す
```

### 変更対象ファイル
- `src/sidepanel/features/ml/actions.ts`
  - `bulkExcludeRemaining()` 関数追加
  - `updateBulkExcludeProgress()` 関数追加
- `src/sidepanel/features/ml/stopping.ts`
  - `showStoppingReachedDialog()` のUI更新
  - 確認ダイアログ追加
- `src/sidepanel/sidepanel.html`
  - 進捗表示用のUI要素追加（任意）

---

## 3. 新規MLレビュー開始機能

### 目的
MLレビュー完了後に、新しいMLレビューセッションを開始できるようにする。

### ユースケース
1. 停止基準到達後に全除外を実行した後
2. 既存のMLレビューをリセットしてやり直したい場合

### UIデザイン
```
┌─────────────────────────────────────┐
│ ✅ MLレビュー完了                    │
│                                     │
│ Include: 42件  Exclude: 958件       │
│ (自動除外: 800件)                   │
│                                     │
│ [📊 結果をエクスポート]              │
│ [🔄 新しいMLレビューを開始]          │
│ [← レビュー画面に戻る]              │
└─────────────────────────────────────┘
```

### 実装詳細

#### 3.1 完了画面の表示
```typescript
// src/sidepanel/features/ml/render.ts

function renderMlComplete(stats: { include: number; exclude: number; autoExcluded: number }) {
    // ML section の内容を完了画面に置き換え
}
```

#### 3.2 新規MLレビュー開始
```typescript
// src/sidepanel/features/ml/actions.ts

export async function resetAndStartNewMlReview() {
    // 1. ML状態をリセット
    state.setMlState(createInitialMlState());
    
    // 2. 参照データを再読み込み（判定情報込み）
    const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);
    state.setReferences(refs);
    
    // 3. ML Workerを再初期化
    await initMlWorker();
    
    // 4. UI更新
    renderMlSection();
    
    showToast('新しいMLレビューを開始しました');
}
```

### 変更対象ファイル
- `src/sidepanel/features/ml/actions.ts`
  - `resetAndStartNewMlReview()` 関数追加
  - エクスポート追加
- `src/sidepanel/features/ml/render.ts`
  - `renderMlComplete()` 関数追加
  - 完了画面のレンダリング
- `src/sidepanel/sidepanel.html`
  - 完了画面用のHTML構造追加
- `src/sidepanel/sidepanel.ts`
  - 新規MLレビューボタンのイベントリスナー

---

## 4. レビュー画面でのML判定表示

### 目的
通常のレビュー画面で、ML画面で行った判定を識別できるようにする。

### UIデザイン
```
┌─────────────────────────────────────┐
│ 👤 user@example.com                 │
│ ⭕ include                          │
│ 📝 メモ内容...                       │
│ 🤖 ML Enhanced                      │  ← 追加
└─────────────────────────────────────┘
```

### 実装詳細
```typescript
// src/sidepanel/features/screening/render.ts

function renderAllDecisions(ref: ReferenceWithStatus) {
    ref.allDecisions?.forEach((d) => {
        // ...既存のコード...
        
        // ML Enhanced バッジ
        if (d.client_version?.includes('-ml')) {
            const mlBadge = document.createElement('span');
            mlBadge.className = 'ml-enhanced-badge';
            mlBadge.textContent = '🤖 ML Enhanced';
            div.appendChild(mlBadge);
        }
    });
}
```

### 変更対象ファイル
- `src/sidepanel/features/screening/render.ts`
  - `renderAllDecisions()` にバッジ表示追加
- `src/sidepanel/sidepanel.css`
  - `.ml-enhanced-badge` スタイル追加

---

## 実装順序

### Phase 1: ML Enhanced マーカー (最小変更)
1. `actions.ts` の `client_version` を変更
2. `render.ts` でバッジ表示追加
3. CSS追加

### Phase 2: 一括exclude機能
1. `bulkExcludeRemaining()` 関数実装
2. `stopping.ts` のダイアログ更新
3. 確認ダイアログ追加
4. 進捗表示（任意）

### Phase 3: 完了画面と新規開始
1. 完了画面のHTML/CSS追加
2. `renderMlComplete()` 実装
3. `resetAndStartNewMlReview()` 実装
4. イベントリスナー追加

---

## テスト項目

### 手動テスト
- [ ] ML画面で判定 → レビュー画面で「ML Enhanced」バッジが表示される
- [ ] 停止基準到達 → 「終了」選択 → 残り全件がexcludeになる
- [ ] 一括exclude後 → 「新しいMLレビューを開始」で状態がリセットされる
- [ ] 新規MLレビュー開始 → ランキングが再計算される

### エッジケース
- [ ] 一括exclude中にエラーが発生した場合の処理
- [ ] 0件の未判定でも正常に動作する
- [ ] 大量データ（3000件）での一括excludeパフォーマンス

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| 一括excludeに時間がかかる | バッチ処理 + 進捗表示 |
| 誤って一括excludeを実行 | 確認ダイアログを必須に |
| auto-excludedの判定を取り消したい | レビュー画面で個別に変更可能（既存機能） |

---

## 見積もり時間

| Phase | 見積もり |
|-------|---------|
| Phase 1 | 15分 |
| Phase 2 | 30分 |
| Phase 3 | 30分 |
| テスト・調整 | 15分 |
| **合計** | **約1.5時間** |
