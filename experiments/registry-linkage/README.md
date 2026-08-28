# #118 論文候補探索の取りこぼし率測定（Issue #119 の着手条件）

## これは何か

[Issue #119](https://github.com/youkiti/tiab-review-plugin/issues/119)（LLMによるPubMed検索式生成）を
**実装すべきかどうかを決めるための測定**。#118 で入った3戦略が結果論文をどれだけ取りこぼすかを測り、
取りこぼしが小さければ #119 は実装しない（LLMのコストと非決定性に見合わないため）。

判断の閾値は Issue #119 本文の「着手条件」と同じで、`scoring.ts` の `decide()` にそのまま書いてある:

| 取りこぼし率 | 判断 |
|---|---|
| 10% 未満 | #119 をクローズ（`not_planned`） |
| 10〜25% | 実装するが優先度は低のまま |
| 25% 超 | 実装する |

## なぜ既存の36ペアで測れないのか

AGENTS.md「試験登録レコードの論文候補探索」節に、3レジストリ×各12試験=36ペアでの実測
（Europe PMC 戦略の recall 89%）が記録されている。**この数字はこの測定の代わりにならない。**

36ペアの正解は **PubMed の `[si]`（Secondary Source ID）から作られている**。戦略2（`pubmed_id`）は
まさに `[si]` を検索するので、正解セットに入っているペアは戦略2が自明に当てる。逆に言えば
「`[si]` に索引されていない論文」は最初から正解セットに入り得ない。#119 が埋めようとしているのは
まさにその集団なので、36ペアはその穴を1件も測っていない。

## 正解セットの作り方（ここが測定の全て）

**正解ペアの紐付け元が、測定対象の戦略が使う信号と重なっていないこと。** 重なると、その戦略は
自明に当てるので取りこぼし率が過小評価される。

| 由来（`provenance`） | 使えるか | 理由 |
|---|---|---|
| `pubmed_si` | ✗ | 戦略2（`pubmed_id`）が同じ `[si]` を引く |
| `ctgov_references` | ✗ | 戦略1（`ctgov_reference`）が読むのがまさにこのフィールド |
| `sr_included_table` | ✓ | 既発表SR/メタ解析の組み入れ研究表。人手の紐付けで3戦略のどれとも独立 |
| `registry_declared` | ✓ | **CTGov以外**のレジストリの投稿者申告欄（jRCTの主たる公表論文、UMIN-CTRの結果の公表状況、ISRCTNのpublication citations 等） |
| `manual_curation` | ✓ | 上記以外の人手紐付け。`source_note` に根拠を書くこと |

`ctgov_references` は Issue #119 の当初案で独立な候補として挙げていたが、**`[si]` と同じ誤りの鏡像**
なので使えない（戦略1がそのフィールドを読んでいる）。

この制約は運用の心がけではなく `scoring.ts` の `validateGroundTruth()` が実際に弾く。循環する由来の
ペアを混ぜても黙って通ることはない。

### 層別すること

`measure-recall.ts` はレジストリ種別（ctgov / jrct / umin / isrctn / other）で層別集計する。

戦略1（CTGov `referencesModule`）は **NCT にしか効かない**。非CTGov（jRCT/UMIN等）は戦略2・3だけで
戦うことになり、しかも日本のレジストリIDは PubMed の `[si]` に索引されにくい。**取りこぼしは
非NCT側に偏っている可能性が高い**ので、全体を1つの数字にまとめると「NCTは十分／非NCTは全然ダメ」が
平均に埋もれる。層ごとに取りこぼし率が大きく違えば、「非NCTのみLLM検索式生成を使う」という結論があり得る。

これは #119 が挙げている差別化点（スナップショットを使うのでCTGov APIのない jRCT/UMIN でも検索式を
生成できる）とも一致する。**本プラグインは ICTRP XML 取り込みで非NCTの登録を多く扱うので、
非NCT層は最低でも15件は集めること。**

### データ形式

`data/ground-truth.example.json` がスキーマの実例（ダミー値。**そのまま測定に使わないこと**）。

```json
{
  "trial_id": "jRCT2031200153",
  "pmid": "12345678",
  "doi": "10.1000/xyz",
  "provenance": "registry_declared",
  "source_note": "出典。再現性のため必ず書く"
}
```

`pmid` と `doi` は少なくとも一方が必要（両方あると照合が安定する）。1試験1行。

## 実行

`ts-node` は package.json の devDependencies に入っていない（`experiments/README.md` と同じ扱い）。
初回だけ入れること:

```bash
npm install --save-dev ts-node
```

```bash
npx ts-node --project experiments/tsconfig.json experiments/registry-linkage/measure-recall.ts \
  --input experiments/registry-linkage/data/ground-truth.json \
  --email you@example.com
```

`--input` の既定パス（`data/ground-truth.json`）のファイルはリポジトリに入っていない。
正解セットは人手で作るものなので、下の「正解セットの作り方」に従って自分で用意すること
（`data/ground-truth.example.json` はスキーマの実例で、ダミー値なので測定には使えない）。

| オプション | 既定 | 説明 |
|---|---|---|
| `--input` | `experiments/registry-linkage/data/ground-truth.json` | 正解セット |
| `--out` | `experiments/registry-linkage/results` | 結果の出力先 |
| `--email` | 環境変数 `NCBI_EMAIL` | eutils へ申告する連絡先（NCBIの利用規約） |
| `--delay-ms` | 350 | esearch→esummary の間隔（APIキー無しは3 req/s上限） |
| `--pair-delay-ms` | 1000 | 試験間の待機 |
| `--limit` | なし | 先頭n件だけ流す（動作確認用） |

`results/` に `report-<timestamp>.md`（層別の表と取りこぼし一覧）と `results-<timestamp>.json`（生データ）が出る。

### ネットワークについて

`clinicaltrials.gov` / `eutils.ncbi.nlm.nih.gov` / `www.ebi.ac.uk` の3ホストへ到達できる環境が要る。
スクリプトは本体を走らせる前に3ホストへ実際に到達できるか確かめ、駄目なら中止する。

これは必須のガード。`discoverPublicationCandidates()` は各戦略の失敗を握りつぶして空配列を返す設計
（一括ループを止めないための正しい挙動）なので、**ネットワークが遮断されていても例外は出ず、
「候補0件＝全部取りこぼし＝取りこぼし率100%」という、いかにも「LLM検索式が必要」に見える結果が
そのまま出てしまう。**

開始時のチェックだけでは「途中から eutils が 429 を返し始めた」「回線が落ちた」を防げないため、
全ペアを流し終えたあとにも同じ到達性チェックを走らせ、失敗していればレポート冒頭に警告を出す。
あわせて `detectStrategyOutage()` が「ある戦略が末尾10件で一度も候補を返していない」状態を検出して
警告する（正常でも0件は起きうるので中止はせず、判断材料として出すだけ）。
**レポートに「⚠ 警告」節がある結果は、原因を潰してから測り直すこと。**

## 測定の限界（結果を読むときに承知しておくこと）

- **`registry_declared` は取りこぼしを過小評価する方向に偏りうる。** レジストリの公表論文欄を
  更新するような几帳面な研究者は、論文中に登録番号を書いている可能性も高い。つまり
  「レジストリに申告がある試験」は「論文に登録番号が載っている試験」に寄りやすい。
  偏りの向きは**取りこぼしを小さく見せる側**なので、#119 を実装しない判断に使う分には保守的だが、
  実装する判断の根拠にするときはこの点を割り引くこと。
- **`sr_included_table` は「発表され索引された論文」に限られる。** SRはデータベース検索で組み入れ
  研究を見つけるため、そもそも見つからない論文は表に載らない。この測定が答えるのは
  「結果論文が存在するとき、#118 はそれを見つけられるか」であって、「結果論文が存在するか」ではない。
- **索引ラグ**。発行直後の論文はPubMed/Europe PMCの索引が追いついておらず、実力とは無関係に
  取りこぼしになる。既存36ペアの測定が発行年2015-2022に限定していたのと同じ理由で、
  直近1〜2年の論文は避けること。
