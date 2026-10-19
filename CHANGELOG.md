# 変更履歴 / Changelog

TiAb Review Plugin の版ごとの変更です。AI 判定の結果に影響しうる変更（使う AI モデルとその版、プロンプトとその版、既定の閾値、判定の集計方法）は、小さなものでも必ず「AI 判定に影響する変更」に載せます。

This file lists changes per version. Any change that may affect AI screening results (the AI models used and their versions, prompts and prompt versions, default thresholds, how decisions are aggregated) is always listed under "Changes that affect AI screening", however small.

v0.54.0 以前の変更は [コミット履歴](https://github.com/youkiti/tiab-review-plugin/commits/main) をご覧ください。
For changes up to v0.54.0, see the [commit history](https://github.com/youkiti/tiab-review-plugin/commits/main).

## 未リリース / Unreleased

### 文書 / Documentation

- プライバシーポリシーに、AI 判定の送信先（Gemini・OpenRouter・OpenAI・Anthropic・TypeSafe）、フルテキストの AI 判定で PDF 全体を送ること、全文検索とレジストリ連携の送信先（Unpaywall と OpenAlex にはメールアドレスも送ること）、各社のデータの扱い（Gemini API の無料枠では送った内容が Google の改善に使われうること）、PDF を AI に送るときの著作権の注意を書いた。
  The Privacy Policy now lists every AI provider data can be sent to, that full-text AI screening sends whole PDFs, the services used for full-text search and registry linkage (including the email address sent to Unpaywall and OpenAlex), how each provider handles data (the Gemini API free tier may use content to improve Google's products), and a copyright note on sending PDFs to AI.
- 利用規約から、MIT ライセンスと矛盾していたリバースエンジニアリングの禁止を削除した。取り込んだ内容に開発者が権利を主張せず学習に使わないこと、AI 判定に影響する変更をこの変更履歴に載せることを書いた。
  The Terms of Service no longer prohibit reverse engineering, which contradicted the MIT License. They now state that the developer claims no rights to imported content and does not use it for training, and that changes affecting AI screening are listed in this changelog.
- ヘルプに「AI 判定の検証と限界」の節を足した（開発者自身による評価であること、評価データの偏り、調整と評価に同じデータを使ったこと、学習データとの重なりの可能性、性能が時間とともに変わりうること、レビューの中で確かめる方法）。README にも同じ限界を書いた。
  Added a "Validation and Limitations of AI Screening" section to the help (developer-run evaluations, limited evaluation data, the same data used for tuning and evaluation, possible overlap with training data, performance drift, and how to check within a review). The README describes the same limitations.
- 資金源（JSPS 科研費 25K13585）と利益相反（AI サービスの提供元から報酬や資金を受けていないこと）を、ヘルプ・ランディングページ・README に書いた。
  The funding source (JSPS KAKENHI 25K13585) and a conflict-of-interest statement (no payment or funding from AI service providers) now appear in the help, landing page, and README.
