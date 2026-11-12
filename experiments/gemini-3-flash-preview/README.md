# gemini-3-flash-preview の初期評価（B1〜B8）の元の結果

`experiments/report.md`（初期評価のレポート）の B1〜B8 の判定結果と実行ログ。2026-01-01 に depression データセット（1,993件）で、`gemini-3-flash-preview` の topP と Thinking の段階を変えて流した。実行時は `experiments/results/`（`.gitignore` の対象）に書かれていたので、そこから写した。どの条件でどのファイルが出たかは `experiments/logs/experiments_B1_B8_full.log.txt` の `Condition:` と `Decisions saved to` の行で確かめた。

README の主表にある `gemini-3-flash-preview`（Recall 96.1%）は B4 の行で、ログの評価は Sensitivity 96.07%（TP 269、FN 11、閾値0.5）。

| 条件 | topP | Thinking | 判定のファイル | 実行ログ |
| --- | --- | --- | --- | --- |
| B1 | 0.65 | MINIMAL | `results/decisions_2026-01-01T09-29-48.json` | `results/experiment_2026-01-01T09-29-48.log.json` |
| B2 | 0.95 | MINIMAL | `results/decisions_2026-01-01T09-39-27.json` | `results/experiment_2026-01-01T09-39-27.log.json` |
| B3 | 0.65 | LOW | `results/decisions_2026-01-01T09-46-08.json` | `results/experiment_2026-01-01T09-46-08.log.json` |
| B4 | 0.95 | LOW | `results/decisions_2026-01-01T09-55-41.json` | `results/experiment_2026-01-01T09-55-41.log.json` |
| B5 | 0.65 | MEDIUM | `results/decisions_2026-01-01T10-03-42.json` | `results/experiment_2026-01-01T10-03-42.log.json` |
| B6 | 0.95 | MEDIUM | `results/decisions_2026-01-01T10-15-34.json` | `results/experiment_2026-01-01T10-15-34.log.json` |
| B7 | 0.65 | HIGH | `results/decisions_2026-01-01T10-25-53.json` | `results/experiment_2026-01-01T10-25-53.log.json` |
| B8 | 0.95 | HIGH | `results/decisions_2026-01-01T10-36-51.json` | `results/experiment_2026-01-01T10-36-51.log.json` |

temperature はすべて 1。`experiments/report.md` が「B1 Decisions」として参照する `decisions_2026-01-01T09-08-40.json` は、この8回より前に B1 の条件を1回だけ流した別の実行で、ここには入れていない。

判定のファイルは Decisions の行と同じ形（`decision` は `pending`、確率・理由・`evidence` は `note` の JSON）。題名・抄録は入っていない。`evidence[].quote`（抄録の原文の抜粋）は含むが、Zenodo の公開物を作るときに `scripts/zenodo-eval/pack.mjs` が落とす。
