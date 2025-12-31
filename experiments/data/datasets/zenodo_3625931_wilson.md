# Wilson Disease Treatment Dataset (zenodo_3625931)

## 概要

| 項目 | 内容 |
|------|------|
| **レビュータイトル** | Comparative effectiveness of common therapies for Wilson disease: A systematic review and meta‐analysis of controlled studies |
| **Zenodo DOI** | [10.5281/zenodo.3625931](https://zenodo.org/records/3625931) |
| **元論文DOI** | [10.1111/liv.14179](https://doi.org/10.1111/liv.14179) |
| **データ日付** | 2020年1月16日 |
| **スクリーニング対象** | 3,453件 (Title-Abstract) |
| **フルテキスト審査** | 174件 |
| **最終採用** | 26件 |

## ローカルファイル

| ファイル名 | 内容 | サイズ |
|-----------|------|--------|
| `DOKU_All TiAb-Screening_20200116_cap.txt` | T&Aスクリーニング全レコード | ~10MB |
| `DOKU_All FT-Screening_20200116_cap.txt` | フルテキスト審査対象 | ~650KB |
| `DOKU_All Included_20200116_cap.txt` | 最終採用論文 | ~100KB |

- **パス**: `scripts/asreview-baseline/datasets/zenodo_3625931/`
- **形式**: RIS形式

## 適格基準 (Eligibility Criteria)

> **出典**: [Liver International, 10.1111/liv.14179](https://onlinelibrary.wiley.com/doi/10.1111/liv.14179), Section 2.1

### 組み入れ基準 (Inclusion Criteria)

#### 対象患者
- **Wilson病患者** (年齢・病期は問わない)

#### 対象治療法
- D-penicillamine (DPen)
- Trientine (トリエンチン)
- Tetrathiomolybdate (TTM)
- Zinc (Zn)

#### 対照条件
- プラセボ、無治療、または研究薬を含まない他治療との比較
- 例: Zn vs trientine ✅
- 例: Zn 50mg vs Zn 100mg ❌ (用量比較は除外)
- 併用療法の場合、対照群と同一の併用薬を使用すること

#### 対象アウトカム
- 全死因死亡
- 肝移植 (OLT)
- 神経症状 (ジストニア、構音障害、認知機能低下、流涎、振戦、歩行障害、舞踏病、痙攣、精神病)
- 肝関連症状 (黄疸、腹水、脂肪症、線維化、軽度肝炎、急性肝不全、肝硬変、血清トランスアミナーゼ)
- 有害事象 (皮膚症状、腎毒性、肺毒性、自己免疫疾患、貧血、顆粒球減少症、血小板減少症、甲状腺機能低下症、肝機能障害、大腸炎、ジストニア発作、重症筋無力症、関節症、女性化乳房、早期神経症状悪化、消化器症状)
- 治療中止率 (薬剤変更、中止、治療変更)

#### 対象研究デザイン
- 前向き・後向き研究
- ランダム化・非ランダム化比較試験
- 比較観察研究
- 言語: 英語、ドイツ語、オランダ語、フランス語、スペイン語、ポルトガル語

### 除外基準 (Exclusion Criteria)

- 動物実験
- 症例報告 (case reports)
- ケースシリーズ (case series)
- 横断研究 (cross-sectional studies)
- 前後比較研究 (before-after studies)
- レビュー
- レター
- 抄録のみの発表
- エディトリアル
- 診断・検査研究
- 非対照研究
- 単剤療法 vs その単剤を含む併用療法の比較 (例: DPen + Zn vs Zn)

## スクリーニングフロー

```
検索結果 (merged from original and update search)
         ↓
  3,453件 → Title-Abstract スクリーニング
         ↓
    174件 → Full-text スクリーニング
         ↓
     26件 → 最終採用 (メタ分析に含む)
```

## データセット特徴

- **疾患特異的**: Wilson病という希少疾患に特化
- **治療比較**: 薬物療法の有効性比較が目的
- **メタ分析用**: 定量的統合を目的としたデータ収集
- **高い採用/除外比**: 26/3453 = 0.75% (非常に厳しい基準)

## 備考

- RIS形式のため、パース処理が必要
- ラベル情報はファイル間の差分で判定 (TiAb vs Included)
- 元論文がLiver International誌に掲載 (2019)

---
*最終更新: 2025-12-31*
