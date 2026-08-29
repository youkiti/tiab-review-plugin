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
| `crossref_ct_number` | ✓ | Crossref の `clinical-trial-number`（出版社が論文メタデータとして寄託する試験登録番号）。下記参照 |

`ctgov_references` は Issue #119 の当初案で独立な候補として挙げていたが、**`[si]` と同じ誤りの鏡像**
なので使えない（戦略1がそのフィールドを読んでいる）。

#### `crossref_ct_number` について

Crossref の `clinical-trial-number` は、**出版社が論文のメタデータとして寄託する試験登録番号**。
3戦略のどれとも別系統である:

| 戦略 | 見ている信号 | Crossrefとの関係 |
|---|---|---|
| 1 `ctgov_reference` | レジストリ側の CTGov `referencesModule` | レジストリ側 vs 出版社側で別 |
| 2 `pubmed_id` | NLMが索引する PubMed の `[si]` / `[tiab]` | NLMの索引 vs 出版社のCrossref寄託で別パイプライン |
| 3 `europepmc` | Europe PMC の抄録・全文テキスト | 本文テキスト vs 構造化メタデータで別 |

Crossrefに番号があっても PubMed の `[si]` に索引されているとは限らず、抄録本文に書かれているとも
限らない。つまり**3戦略が取りこぼす論文を実際に含みうる**ので、正解セットの由来として使える。

**ただし `registry_declared` と同じ向きの偏りがある。** 出版社が試験番号を寄託するような論文は、
抄録にも登録番号を書いている可能性が高い（どちらも「この論文はどの試験の報告かをきちんと書く」
という同じ性質の現れ）。したがってこの由来で測った取りこぼし率は**下限**であり、実際の取りこぼしは
これ以上ある。#119 を「実装しない」判断に使う分には保守的だが、「実装する」判断の根拠にするときは
この点を割り引くこと。

##### 実際に使った構築手順（`data/ground-truth.json`）

1. Crossref works API から `has-clinical-trial-number:true`・`type:journal-article`・
   発行 2015-01-01〜2022-12-31 の全 19,583 件を cursor ページングで取得
   （発行年の範囲は、索引ラグで recall が潰れるのを避けるため。既存36ペアの測定と同じ理由）
2. 試験ID→DOI に展開し、**この母集団で論文がちょうど1本の試験だけ**を残す（18,172試験）。
   1試験に複数の論文があると、#118 が「別の正しい論文」を返したときに不当な取りこぼしになるため
3. レジストリ層別に無作為抽出（`random.seed(20260828)`）。`other` 層は特定レジストリに偏らないよう
   レジストリ間の round-robin で混ぜてから抽出
4. 各DOIを Europe PMC へ `DOI:"<doi>"` で照会し、**索引されていること**と発行年を確認。
   索引されていない論文はどの戦略でも原理的に見つけられず、探索の良し悪しと無関係に
   取りこぼしになるため除外する（この測定が答えるのは「結果論文が索引されているとき、
   #118 はそれを見つけられるか」）。この照会は**既知の論文の識別子を引き直しているだけ**で、
   試験↔論文の紐付け自体は手順1のCrossref由来のままなので、戦略3との循環にはならない

得られたのは 120 ペア（ctgov 40 / isrctn 30 / umin 20 / other 30）。全ペアがPMIDとDOIの両方を持つ。
`other` の内訳は ANZCTR・CTRI・DRKS・IRCT・KCT・PACTR・TCTR・ChiCTR・NTR・EUCTR。
jRCT は Crossref のレジストリ一覧に無い（2026-08-29 に `has-clinical-trial-number:true` の1,200件標本で
再確認済み。registry は clinical-trials-gov / isrctn / umin-japan / anzctr / chictr / irct / pactr /
dutch-trial-register / drks / clinical-trial-registry-india / cris / tctr のみでjRCTは無かった）ため、
この由来では jrct 層は作れない。2026-08-29 に `registry_declared`（jRCTの投稿者申告欄）由来で
jrct 43ペアを別途追加した。作り方は下記「jrct 層の正解セットの作り方（2026-08-29 追加）」を参照。

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

## jrct 層の正解セットの作り方（2026-08-29 追加）

上記の `crossref_ct_number` 由来ではjRCTが作れないため、`registry_declared`
（jRCTの投稿者申告欄）由来で別途収集し、`data/ground-truth.json` に追記した。
手順は以下のとおり（由来は `registry_declared`。43ペア、全件がPMIDとDOIの両方を持つ）:

1. jRCT のフリーワード検索に `pubmed`（AND 検索、`free_op=0`）を掛けて 317 件を得る。
   この検索は「結果と出版物に関するURL」欄を索引している（`jRCT1030210638` の当該欄が
   `https://pubmed.ncbi.nlm.nih.gov/41159320/` で、この検索でヒットすることを実地確認した）
2. 検索結果一覧の日付列が 2024 年以前の 225 件に絞る（索引ラグ回避の一次フィルタ）
3. `random.seed(20260829)` で 45 件を無作為抽出
4. 各詳細ページ `https://jrct.mhlw.go.jp/latest-detail/<試験ID>` から
   「結果と出版物に関するURL」を抽出（**20秒間隔**。理由は下の「jRCT へのアクセスについて」）
5. 公表URLがちょうど1件のものだけを残す（1試験に複数論文があると、#118 が「別の正しい論文」を
   返したときに不当な取りこぼしとして数えてしまうため。既存120ペアが「論文がちょうど1本の試験だけ」に
   絞っているのと同じ理由）
6. URL から PMID / DOI を解決し、Europe PMC で索引されていることと `pubYear` を確認。`pubYear<=2024` に限定
7. 除外は5件のみ: 発行年2026が2件、発行年2025が1件、公表URLの申告なしが2件 → **43件を採用**

### 副登録番号の対照セット（`data/ground-truth-jrct-secondary.json`）の作り方

目的は「jRCT ID の代わりに、jRCT レコードが申告している副登録番号で探索したらどうなるか」を
測る対照セットを作ること。元にするのは上の手順で作った jrct 43ペアと同じ試験で、追加のページ取得は
していない（手順4で取得済みの詳細ページを再利用した）。手順は以下のとおり:

1. 各詳細ページから「他の登録機関でのID番号 / Secondary ID No.」欄の値を抜き、正規表現
   `(JapicCTI-?\d+|UMIN0*\d{6,}|C\d{9}|NCT\d{8}|ISRCTN\d+|EudraCT\s*[\d-]+|\d{4}-\d{6}-\d{2})`
   （大文字小文字は無視）で登録番号を取り出す
2. 申告があったのは43件中34件。複数の副登録番号を持つ試験は0件だった（全件がちょうど1件）
3. `trial_id` をその副登録番号に差し替え、`pmid` / `doi` は元の43ペアと同じ値をそのまま使う。
   紐付けの由来は変わらず jRCT の「結果と出版物に関するURL」欄なので `provenance` は
   `registry_declared` のまま

得られた34ペアの層別内訳は ctgov（NCT）21 / umin 9 / other（JapicCTI）4。測定は本測定と同じ
`measure-recall.ts` に `--input data/ground-truth-jrct-secondary.json` を渡して実行した。

## jRCT へのアクセスについて

- **旧ホスト `jrct.niph.go.jp` は到達不能。** TLS handshake failure（alert 40）で、
  curl(schannel) / Node(OpenSSL) / PowerShell(.NET) / Chrome(BoringSSL) の**4スタックすべてで再現**した。
  DNS は正引きできる（CloudFrontを指す）ので、名前解決の問題ではない。
- **現行ホストは `https://jrct.mhlw.go.jp/`。** jRCT は **2025-03-25 に国立保健医療科学院（NIPH）から
  厚生労働省へ移管**され URL が変わった。詳細ページは `https://jrct.mhlw.go.jp/latest-detail/<試験ID>`。
  Issue #131 が挙げていた「実行環境から到達できなかった」というブロッカーの正体はこれ（古いホスト名）で、
  ネットワーク制限ではなかった。
- **サイトは大量の自動データ収集を明示的に断っている**（検索画面に
  「個人利用の範囲を超えた大量データ収集はお控えください。プログラムを利用した自動操作等による
  意図的な大量データ収集は個人利用の範囲を超えた利用とみなされます。」の掲示）。
  CloudFront WAF は headless ブラウザを 403 で遮断し、**4秒間隔・約30リクエストで IP 単位のブロック**を
  受けた（約10分で解除された）。**総当たりクロールはしないこと。** 上の手順は
  「公表論文を申告済みの試験だけを検索で絞り込む」ことで取得件数を最小化している。
- 一括ダウンロードAPI・構造化データ提供は存在しない（検索結果CSVダウンロードは利用規約の同意チェックが要る
  人手操作の機能）。

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
あわせて `detectStrategyOutage()` が「ある戦略が末尾で一度も候補を返していない」状態を検出して
警告する（正常でも0件は起きうるので中止はせず、判断材料として出すだけ）。素朴に「末尾N件が0件なら
警告」にすると誤検出だらけになるため、実測で踏んだ2つの要因を潰してある: (1) 戦略1はNCTにしか
効かないので、**その戦略が一度でも候補を返した層だけ**に絞って数える、(2) 戦略3は正常時でも
まばら（実測で120件中20件、途中に最大18件の空白）なので、**その戦略が動いていた区間で見せた
最大の空白より長い**ときだけ警告する。
**レポートに「⚠ 警告」節がある結果は、原因を潰してから測り直すこと。**

## 測定の限界（結果を読むときに承知しておくこと）

- **`registry_declared` は取りこぼしを過小評価する方向に偏りうる。** レジストリの公表論文欄を
  更新するような几帳面な研究者は、論文中に登録番号を書いている可能性も高い。つまり
  「レジストリに申告がある試験」は「論文に登録番号が載っている試験」に寄りやすい。
  偏りの向きは**取りこぼしを小さく見せる側**なので、#119 を実装しない判断に使う分には保守的だが、
  実装する判断の根拠にするときはこの点を割り引くこと。
- **jrct 43ペアのプールは「公表論文URLとして PubMed リンクを申告した試験」に限定される（2026-08-29 追加）。**
  DOI リンクや雑誌ページを申告した試験は入らない。紐付けの信号（jRCTの申告欄）は3戦略のいずれとも
  独立なので循環はしないが、上の `registry_declared` の偏り（几帳面な研究者に寄る＝取りこぼしを
  小さく見せる方向）を一段強める。それでも jrct 層の取りこぼし率は 86.0% だったという読み方になる。
- **`sr_included_table` は「発表され索引された論文」に限られる。** SRはデータベース検索で組み入れ
  研究を見つけるため、そもそも見つからない論文は表に載らない。この測定が答えるのは
  「結果論文が存在するとき、#118 はそれを見つけられるか」であって、「結果論文が存在するか」ではない。
- **索引ラグ**。発行直後の論文はPubMed/Europe PMCの索引が追いついておらず、実力とは無関係に
  取りこぼしになる。既存36ペアの測定が発行年2015-2022に限定していたのと同じ理由で、
  直近1〜2年の論文は避けること。
