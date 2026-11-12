# TypeSafe 全文 PDF 評価

ソース:

- [common.ts](common.ts)
- [config.json](config.json)
- [extract.ts](extract.ts)
- [runner.ts](runner.ts)
- [reasons.ts](reasons.ts)
- [summarize.ts](summarize.ts)
- [selftest.ts](selftest.ts)
- [tsconfig.json](tsconfig.json)
- [pdf-text-extract.ts](../../src/lib/pdf-text-extract.ts)
- [typesafe-fulltext.ts](../../src/lib/typesafe-fulltext.ts)

元データ: [Cochrane-bench](<C:/Users/youki/codes/Cochrane-bench>)。
XML 比較確率の出所: [比較確率](../gemini-decision-1/fulltext/plan.md) の「比較確率」。

除外理由の区分は機械的な近似であり、Cochrane-bench の正解ではない。
比較の集合は成功した記録だけとする。研究単位の分母も同じ成功集合の陽性に限る。
理由の対応表は複数区分に該当した記録を各行に数える。choice 分布は成功集合全体を数える。
費用・トークンは成功した最終試行だけの合計であり、失敗した試行の課金は不明である。

## cc-by

入力: [records.jsonl](../gemini-decision-1/fulltext/data/cc-by/records.jsonl)
records SHA-256: `52b3aefe91635967722f71df76a2daf8b9d07c1fedd6df7604b81bca0b1950db`
config_hash: `fef0f3c07db773814de721cda4461d09e6154c60d80b03d74d9577b63a58c3f1`

判定: 下がっていない

| 状態 | 記録数 |
|---|---:|
| ok | 1216 |
| no_pdf | 57 |
| image_only | 0 |
| too_long | 1 |
| pdf_error | 0 |
| failed | 0 |
| unexecuted | 0 |

truncated: 7、references_removed: 1173、chars_sent 中央値: 34571

| 入力 | 閾値 | TP | FP | TN | FN | Recall | Specificity | Precision | 研究 Recall | found / 全研究 | AUC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pdf | 0.3 | 601 | 220 | 312 | 83 | 0.8786549707602339 | 0.5864661654135338 | 0.7320341047503045 | 0.8973063973063973 | 533 / 594 | 0.8218023127995427 |
| pdf | 0.5 | 539 | 150 | 382 | 145 | 0.7880116959064327 | 0.7180451127819549 | 0.7822931785195936 | 0.8114478114478114 | 482 / 594 | 0.8218023127995427 |
| xml | 0.3 | 593 | 215 | 317 | 91 | 0.8669590643274854 | 0.5958646616541353 | 0.7339108910891089 | 0.8872053872053872 | 527 / 594 | 0.8219905575341864 |
| xml | 0.5 | 519 | 146 | 386 | 165 | 0.7587719298245614 | 0.7255639097744361 | 0.7804511278195488 | 0.7760942760942761 | 461 / 594 | 0.8219905575341864 |

全記録 XML 0.3: n=1274、Recall=0.8672199170124482、Specificity=0.5916515426497277

| ゴールド | XML のみ | PDF のみ | 両方 | どちらもなし |
|---|---:|---:|---:|---:|
| included | 3 | 11 | 590 | 80 |
| excluded | 3 | 8 | 212 | 309 |

単一: 154、一致: 92、割合: 0.5974025974025974
複数: 0、集合内: 0、割合: —
unmapped: 158

| Cochrane 区分 | population | intervention | comparator | outcome | study_design | duplicate | other |
|---|---:|---:|---:|---:|---:|---:|---:|
| comparator | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| unmapped | 16 | 45 | 1 | 32 | 60 | 0 | 4 |
| study_design | 3 | 6 | 0 | 8 | 36 | 0 | 0 |
| population | 21 | 4 | 0 | 1 | 0 | 0 | 0 |
| intervention | 14 | 24 | 1 | 1 | 1 | 0 | 0 |
| outcome | 10 | 2 | 0 | 11 | 9 | 0 | 0 |

| jev choice | 成功集合の件数 |
|---|---:|
| population | 84 |
| missing | 821 |
| other | 5 |
| study_design | 119 |
| intervention | 109 |
| outcome | 74 |
| comparator | 3 |
| duplicate | 1 |

input_tokens=15798024、output_tokens=109003、cost_usd=0、費用不明=1216

## cc-by-nc

入力: [records.jsonl](../gemini-decision-1/fulltext/data/cc-by-nc/records.jsonl)
records SHA-256: `135cc9cc3212d1141063c2791e6ef3bdf33673e9cb790e7df48169e015622127`
config_hash: `fa4d29f96b2ea862766891e93fcc84ed452d3530e731292e6530eb4b2cdc1545`

判定: 下がっていない

| 状態 | 記録数 |
|---|---:|
| ok | 5045 |
| no_pdf | 139 |
| image_only | 0 |
| too_long | 2 |
| pdf_error | 0 |
| failed | 0 |
| unexecuted | 0 |

truncated: 39、references_removed: 4878、chars_sent 中央値: 35161

| 入力 | 閾値 | TP | FP | TN | FN | Recall | Specificity | Precision | 研究 Recall | found / 全研究 | AUC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pdf | 0.3 | 2247 | 992 | 1572 | 234 | 0.905683192261185 | 0.6131045241809673 | 0.6937326335288669 | 0.9274475524475524 | 2122 / 2288 | 0.8662127017124216 |
| pdf | 0.5 | 2024 | 587 | 1977 | 457 | 0.8158000806126562 | 0.7710608424336973 | 0.7751819226350057 | 0.8426573426573427 | 1928 / 2288 | 0.8662127017124216 |
| xml | 0.3 | 2224 | 935 | 1629 | 257 | 0.8964127367996776 | 0.6353354134165367 | 0.7040202595758152 | 0.9195804195804196 | 2104 / 2288 | 0.8670657527631214 |
| xml | 0.5 | 1987 | 544 | 2020 | 494 | 0.8008867392180572 | 0.7878315132605305 | 0.7850651916238641 | 0.8304195804195804 | 1900 / 2288 | 0.8670657527631214 |

全記録 XML 0.3: n=5186、Recall=0.8967540086038326、Specificity=0.6356028908330164

| ゴールド | XML のみ | PDF のみ | 両方 | どちらもなし |
|---|---:|---:|---:|---:|
| included | 8 | 31 | 2216 | 226 |
| excluded | 32 | 89 | 903 | 1540 |

単一: 691、一致: 427、割合: 0.61794500723589
複数: 5、集合内: 5、割合: 1
unmapped: 876

| Cochrane 区分 | population | intervention | comparator | outcome | study_design | duplicate | other |
|---|---:|---:|---:|---:|---:|---:|---:|
| unmapped | 248 | 378 | 28 | 59 | 150 | 0 | 13 |
| population | 110 | 20 | 6 | 12 | 19 | 0 | 1 |
| intervention | 20 | 96 | 3 | 6 | 13 | 0 | 2 |
| outcome | 13 | 15 | 0 | 41 | 19 | 0 | 0 |
| study_design | 37 | 46 | 4 | 13 | 183 | 0 | 2 |
| comparator | 3 | 3 | 2 | 1 | 4 | 0 | 0 |
| duplicate | 1 | 5 | 0 | 2 | 0 | 0 | 0 |

| jev choice | 成功集合の件数 |
|---|---:|
| comparator | 50 |
| missing | 3239 |
| population | 471 |
| intervention | 648 |
| study_design | 426 |
| other | 34 |
| outcome | 177 |

input_tokens=68198275、output_tokens=452619、cost_usd=0、費用不明=5045
