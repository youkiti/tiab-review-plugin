# 変更履歴 / Changelog

TiAb Review Plugin の版ごとの変更です。AI 判定の結果に影響しうる変更（使う AI モデルとその版、プロンプトとその版、既定の閾値、判定の集計方法）は、小さなものでも必ず「AI 判定に影響する変更」に載せます。

This file lists changes per version. Any change that may affect AI screening results (the AI models used and their versions, prompts and prompt versions, default thresholds, how decisions are aggregated) is always listed under "Changes that affect AI screening", however small.

v0.54.0 以前の変更は [コミット履歴](https://github.com/youkiti/tiab-review-plugin/commits/main) をご覧ください。
For changes up to v0.54.0, see the [commit history](https://github.com/youkiti/tiab-review-plugin/commits/main).

## 未リリース / Unreleased

### AI 判定に影響する変更 / Changes that affect AI screening

- GPT-5.6 Terra / Luna の推論の強さ（reasoning effort）の設定を low にした。これまでも一括判定では low が送られており、設定の medium は使われていなかった。送る値は変わらない。
  The reasoning effort setting for GPT-5.6 Terra / Luna is now low. Batch screening already sent low (the medium setting was never used), so the value sent does not change.
- 「失敗分をリトライ」が temperature 0 で送っていたのを、通常の実行と同じ生成設定で送るようにした（Gemini 3 Flash Preview は temperature 1.0・top-p 0.95・思考レベル low）。
  "Retry failed" used to send temperature 0; it now uses the same generation settings as a normal run (for Gemini 3 Flash Preview: temperature 1.0, top-p 0.95, thinking level low).
- フルテキストの AI 判定のプロンプトの版を、TiAb と分けて `fulltext-v2.0.0` とした。v0.54.0 以前のフルテキストの判定に記録された `v1.0.0` は、TiAb の版の値が入っていたもので、フルテキストのプロンプトの文面は版の記録なしに変わっていた。TiAb のプロンプトの版は `v1.0.0` のまま。
  Full-text AI screening now has its own prompt version, `fulltext-v2.0.0`. Full-text decisions up to v0.54.0 recorded `v1.0.0`, which was the TiAb version; the full-text prompt text had changed without a version change. The TiAb prompt version stays `v1.0.0`.
- 閾値の説明を、既定値 0.3（同梱モデルの見落とし率を測った値）を推す内容に揃えた。既定値そのものは変わらない。
  The threshold guidance now recommends the default 0.3, at which the bundled models' miss rates were measured. The default itself is unchanged.

### 記録と論文用テキスト / Records and manuscript text

- AI の実行ごとに、送信した全文の雛形・その SHA-256・プロンプトの版・推論の強さ・最大出力トークン数を LLM_Executions に記録する。送っていない temperature などは空欄にする。TiAb の一括判定にも実行者を記録する。
  Each AI run now records the full prompt template sent, its SHA-256, the prompt version, reasoning effort, and maximum output tokens in LLM_Executions. Settings not sent (such as temperature) are left blank. TiAb batch runs now record who ran them.
- 「失敗分をリトライ」の判定も実行の記録に残し、記録の無い孤立した判定にならないようにした。
  "Retry failed" runs are now recorded like normal runs, so their decisions are no longer orphaned.
- 論文用テキストの AI の文を、実際に送った設定・API が返したモデルの版・プロンプトの版で書くようにした。AI が一部の文献だけを判定したときは件数を書く。ML の停止基準の文から、再現率への到達の言い切りを外した。
  The manuscript text now describes AI screening with the settings actually sent, the model version reported by the API, and the prompt version, and gives the count when the AI screened only some records. The ML stopping sentences no longer claim that a recall level was reached.
- ML 画面の「停止可能性」を「停止基準までの進み具合」に改めた（確率ではないため）。
  The ML panel's "Stop probability" is now "Progress toward the stopping criterion" (it was never a probability).
- 保存されていたモデルが提供終了などで新しい版に置き換わったとき、AI タブに注記を出す。
  The AI tab now shows a note when a saved model was replaced by a newer version.

### 文書 / Documentation

- プライバシーポリシーに、AI 判定の送信先（Gemini・OpenRouter・OpenAI・Anthropic・TypeSafe）、フルテキストの AI 判定で PDF 全体を送ること、全文検索とレジストリ連携の送信先（Unpaywall と OpenAlex にはメールアドレスも送ること）、各社のデータの扱い（Gemini API の無料枠では送った内容が Google の改善に使われうること）、PDF を AI に送るときの著作権の注意を書いた。
  The Privacy Policy now lists every AI provider data can be sent to, that full-text AI screening sends whole PDFs, the services used for full-text search and registry linkage (including the email address sent to Unpaywall and OpenAlex), how each provider handles data (the Gemini API free tier may use content to improve Google's products), and a copyright note on sending PDFs to AI.
- 利用規約から、MIT ライセンスと矛盾していたリバースエンジニアリングの禁止を削除した。取り込んだ内容に開発者が権利を主張せず学習に使わないこと、AI 判定に影響する変更をこの変更履歴に載せることを書いた。
  The Terms of Service no longer prohibit reverse engineering, which contradicted the MIT License. They now state that the developer claims no rights to imported content and does not use it for training, and that changes affecting AI screening are listed in this changelog.
- ヘルプに「AI 判定の検証と限界」の節を足した（開発者自身による評価であること、評価データの偏り、調整と評価に同じデータを使ったこと、学習データとの重なりの可能性、性能が時間とともに変わりうること、レビューの中で確かめる方法）。README にも同じ限界を書いた。
  Added a "Validation and Limitations of AI Screening" section to the help (developer-run evaluations, limited evaluation data, the same data used for tuning and evaluation, possible overlap with training data, performance drift, and how to check within a review). The README describes the same limitations.
- 資金源（JSPS 科研費 25K13585）と利益相反（AI サービスの提供元から報酬や資金を受けていないこと）を、ヘルプ・ランディングページ・README に書いた。
  The funding source (JSPS KAKENHI 25K13585) and a conflict-of-interest statement (no payment or funding from AI service providers) now appear in the help, landing page, and README.
