# OR結合アンサンブル（flash-lite × gpt-5.6-luna）ベンチマーク

## 1. 目的

既に収集済みの2つのLLMスクリーニング結果（gemini-3.1-flash-lite 条件C1、gpt-5.6-luna reasoning別3条件）を新規API呼び出しなしで ref_id 突合し、「いずれかのモデルが組み入れ判定=1なら最終的に組み入れとする」OR結合アンサンブルの性能が、既存本番デフォルト B4（gemini-3-flash-preview, thinkingLevel=LOW）の採用基準（Recall≥95%）を満たすかを検証する。

## 2. 比較表（depression データセット, N=1,993 / 陽性280件, threshold=0.5）

| 条件 | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |
|---|---|---|---|---|---|---|---|---|
| **B4**（既存本番デフォルト, 参考値） | 96.1% | 86.3% | 53.4% | 95.2% | 269 | 235 | 1478 | 11 |
| flash-lite単体 (C1, 参考値) | 93.6% | 90.5% | 61.6% | 92.6% | 262 | 163 | 1550 | 18 |
| luna単体 none (参考値) | 92.9% | - | 49.1% | 91.2% | - | - | - | - |
| luna単体 low (参考値) | 91.4% | - | 58.0% | 90.4% | - | - | - | - |
| luna単体 medium (参考値) | 91.4% | - | 64.3% | 90.7% | - | - | - | - |
| **flash-lite(C1) OR luna(none)** | **95.4%** | 83.4% | 48.4% | 93.5% | 267 | 285 | 1428 | 13 |
| **flash-lite(C1) OR luna(low)** | **95.0%** | 87.2% | 54.8% | 93.6% | 266 | 219 | 1494 | 14 |
| **flash-lite(C1) OR luna(medium)** | **94.6%** | 89.6% | 59.8% | 93.6% | 265 | 178 | 1535 | 15 |

（参考値の行はプロンプトで与えられた既存数値をそのまま転記。太字はこのスクリプトで新規に実測した値。）

## 3. 考察

- **Recall改善効果**: OR結合により、flash-lite単体（93.6%）に対して none/low/medium いずれの組み合わせでもRecallが上昇した（+1.0〜+1.8pt）。素朴な期待（片方が見逃した陽性をもう片方が拾う）通りの挙動。
  - `flash-lite OR luna(none)`: 95.4%（B4 96.1%に肉薄、採用基準95%を**達成**）
  - `flash-lite OR luna(low)`: 95.0%（採用基準95%を**ぎりぎり達成**）
  - `flash-lite OR luna(medium)`: 94.6%（採用基準95%に**未達**）
  - luna単体のRecallの序列（none>low≈medium）がそのままアンサンブル後にも反映されている。reasoning_effortを上げるほどlunaが「除外方向」に判断を寄せる傾向（report.md/gpt-5.6の既存考察）が、アンサンブルのRecallにも波及している。
- **Precisionの犠牲**: OR結合はFP（偽陽性）が両モデルのFP集合の和集合に近づくため、Precisionは両単体より必ず悪化する。
  - flash-lite単体 61.6% → アンサンブル(none) 48.4%（-13.2pt）/ (low) 54.8%（-6.8pt）/ (medium) 59.8%（-1.8pt）
  - Fβ7（β=7でRecall重視の指標）で見ても、いずれのアンサンブルもflash-lite単体（92.6%）をわずかに上回る程度（93.5〜93.6%）に留まり、B4（95.2%）には届かない。Fβ7は元々Recall加重が強い指標だが、Precision低下の影響を完全には打ち消せていない。
- **B4採用基準（Recall≥95%）との比較**: `flash-lite OR luna(none)` と `flash-lite OR luna(low)` はRecall基準こそ満たすが、Specificity（83.4% / 87.2%）・Precision（48.4% / 54.8%）・Fβ7（93.5% / 93.6%）はいずれもB4（86.3% / 53.4% / 95.2%）を下回るか同等以下であり、**B4の完全な代替候補にはならない**。B4は単体モデルでこれらのアンサンブルより高いRecallかつ高いFβ7を達成しており、少なくともこのデータセットでは「2モデルOR結合」がB4を上回るメリットを提供していない。
- **コスト面**: OR結合アンサンブルは毎件で flash-lite と luna の両方を呼ぶ必要があるため、API呼び出し回数・コストは単体運用の合計（flash-lite分 + luna分）に増加する。luna単体だけでも none $3.73 / low $4.55 / medium $7.68（全1993件、既存report.md記載）かかっており、flash-liteのコストを加算すると単体運用よりコスト・レイテンシとも確実に悪化する。Recall改善幅（+1.0〜+1.8pt）に対してコスト増（2モデル分）が見合うかは、費用対効果の観点でも本番採用のハードルが高い。
- **結論**: OR結合アンサンブルはRecallを単体より改善するが、B4を上回る、あるいはB4に代わる決定打にはならない。Precision/Fβ7の低下とコスト増を考慮すると、現時点でB4を置き換える根拠は乏しい。

## 4. 突合結果

- flash-lite(C1) decisions: 1,993件、`note`フィールドのJSON.parse成功 1,993件（失敗0件）
- luna（none/low/medium）: 各1,993件、error/include_probability=null 0件（3条件とも）
- **ref_id突合**: 3条件すべてで flash-lite と luna の ref_id が完全一致（1,993件、片側のみに存在するref_idは0件）
- 件数不一致・パース失敗は発生しなかった

## 5. 成果物・ソース

- 解析スクリプト: [analyze.ts](analyze.ts)
- 実測結果JSON: [ensemble_results.json](ensemble_results.json)
- 入力データ:
  - flash-lite(C1): `experiments/gemini-3.1-flash-lite-ga/results/decisions_2026-05-15T12-17-04.json`
  - luna: `experiments/gpt-5.6/results/items_G56-{none,low,med}_*.json`
