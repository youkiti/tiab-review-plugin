# 変更履歴 / Changelog

TiAb Review Plugin の版ごとの変更です。AI 判定の結果に影響しうる変更（使う AI モデルとその版、プロンプトとその版、既定の閾値、判定の集計方法）は、小さなものでも必ず「AI 判定に影響する変更」に載せます。

This file lists changes per version. Any change that may affect AI screening results (the AI models used and their versions, prompts and prompt versions, default thresholds, how decisions are aggregated) is always listed under "Changes that affect AI screening", however small.

v0.54.0 以前の変更は [コミット履歴](https://github.com/youkiti/tiab-review-plugin/commits/main) をご覧ください。
For changes up to v0.54.0, see the [commit history](https://github.com/youkiti/tiab-review-plugin/commits/main).

## 未リリース

### AI 判定に影響する変更 / Changes that affect AI screening

- AI 一括判定で、API キーの誤り・残高不足・存在しないモデルなど送り直しても通らないエラーは、どの AI でも1回で打ち切り、組み入れ確率 1.0 の判定（人の確認に必ず回る扱い）として保存するようにしました。これまでは Gemini・OpenAI では同じ文献を最大3回、OpenRouter のチャットモデルでは最大9回送り直していました。レート制限（429）と一時的なサーバーエラー・通信エラーは従来どおり再試行します。
  In AI batch screening, errors that cannot succeed on resend (invalid API key, insufficient credit, unknown model, and similar) now stop after one attempt for every AI provider, and the reference is saved with an inclusion probability of 1.0 so that it always goes to human review. Previously, Gemini and OpenAI resent the same reference up to three times, and OpenRouter chat models up to nine times. Rate limits (429) and temporary server or network errors are still retried as before.
- プロジェクトを切り替えた直後に、前のプロジェクトの AI 設定（基準）が全文の AI 判定の実行記録に入ることがある経路をなくしました。
  Removed a path by which the previous project's AI settings (criteria) could be recorded in the full-text AI screening log right after switching projects.
- プロジェクトを切り替えた直後に、全文の AI 判定のプロンプト欄に前のプロジェクトのプロンプトが残り、そのまま実行できた経路をなくしました。
  Removed a path by which the previous project's prompt could remain in the full-text AI screening prompt box after switching projects and be used as is.

### 画面 / Interface

- 別のプロジェクトへ切り替えたとき、前のプロジェクトの検索語・ステータスの絞り込み・AI の設定・「新規にやり直す」の切替が残ることがあったのを直しました。AI 一括判定の実行中に「戻る」を押した場合は、一括判定を中止してから切り替えます（中止までの判定は保存され、続きから再開できます）。
  When switching to another project, the search text, status filter, AI settings and the "start over" toggle of the previous project could carry over; this is fixed. If you press Back while AI batch screening is running, the batch is now stopped before switching (decisions saved so far are kept and the run can be resumed).
- 別のプロジェクトへ切り替えたとき・ログアウトしたときに、全文タブの AI 判定のプロンプト・対象範囲・一覧の絞り込み・結果で選んだ判定者が前のプロジェクトのまま残ることがあったのを直しました。全文の AI 一括判定と一括 OA 検索の実行中に「戻る」を押した場合は、中止してから切り替えます（中止までの結果は元のプロジェクトに保存されます）。
  When switching to another project or logging out, the full-text AI prompt, scope, list filter and the reviewers selected in the results could carry over from the previous project; this is fixed. If you press Back while full-text AI batch screening or bulk open-access retrieval is running, it is now stopped before switching (results so far are saved to the original project).
- Web版の判定に記録する版に、ビルド元のコミット（例 web-0.57.2+abc1234）を含めるようにしました。AI 判定には影響しません。
  The version recorded with web-version decisions now includes the build commit (for example web-0.57.2+abc1234). AI screening is unaffected.

### 文書 / Documentation

- README に「機能の追加について」の節を足し、保守の段階で足さない機能と、新しい機能を検討する条件を書いた。AI 判定には影響しない。
  Added an "About new features" section to the README describing what is not added in the maintenance phase and when new features are considered. AI screening is unaffected.

## v0.57.2（2026-11-09）

### 画面 / Interface

- 管理者（シートの編集者以上）も、担当表に名前があれば TiAb は最初に自分の担当セット（キャリブレーションと未割当を含む）だけを表示し、担当外のセットはチェックで表示できます。全文の担当状態行にも自分の担当グループを表示します。AI 判定には影響しません。
  Admins (sheet editors or owners) with assigned groups now start TiAb with only their own assignment sets, including calibration and unassigned references, and can check other sets to show them. Their own groups are also shown in the full-text assignment status row. AI screening is unaffected.

## v0.57.1（2026-11-07）

### 画面 / Interface

- 接続時に編集権限がないと確定した場合は TiAb・ML の判定を止め、アカウントと対処を表示します。途中で権限不足になった場合は未送信件数つきの警告を表示し続け、未送信が残る間は完了表示を出しません。AI 判定には影響しません。
  TiAb and ML decisions are blocked when the sheet is confirmed to be read-only at connection, with the account and recovery steps shown. If edit access is lost during screening, a persistent warning shows the unsent count. Screening is not shown as complete while decisions remain unsent. AI screening is unaffected.
- 全文の判定ページで、根拠カードから別のページへ飛んだ後に1ページ目のカードへ戻ると、1ページ目が白紙のまま描かれないことがある不具合を直しました。AI 判定には影響しません。
  Fixed an issue on the full-text screening page where page 1 could stay blank after jumping from an evidence card to another page and then back to a page-1 card. AI screening is unaffected.
- 全文の判定ページで、AI の根拠を示す帯が文字より少し上にずれて表示される不具合を直しました。AI 判定には影響しません。
  Fixed an issue on the full-text screening page where the highlight marking AI evidence was drawn slightly above the text. AI screening is unaffected.

## v0.57.0（2026-11-07）

### 画面 / Interface

- 編集権限不足で判定の保存を拒否されたとき、プロジェクトの管理者への依頼を案内するようにしました。
  When saving a decision is refused for lack of edit access, the message now asks the reviewer to contact the project administrator.
- Chrome 拡張のサイドパネルの「?」の吹き出しに「相談する」を追加しました。ヘルプをキーワードで探せるほか（API キー不要）、登録済みの API キーで AI に質問できます（Gemini 3.1 Flash-Lite、GPT-5.6 Luna、Claude Haiku 5.5、OpenRouter では DeepSeek V4 Flash）。AI に送るのは質問と、AI が選んだヘルプの一部だけで、文献・判定・メールアドレスは送りません。解決しないときは、内容を確かめたうえで GitHub に質問・報告する下書きを作れます。AI の判定（スクリーニング）の結果には影響しません。
  Added "Ask for help" to the "?" popovers in the Chrome extension side panel. You can search the help by keyword (no API key needed) or ask the AI with an API key you have already registered (Gemini 3.1 Flash-Lite, GPT-5.6 Luna, Claude Haiku 5.5, or DeepSeek V4 Flash through OpenRouter). Only your question and the help excerpts selected by the AI are sent; references, decisions and email addresses are not. If that does not solve it, you can review and open a draft question or report on GitHub. This does not affect AI screening results.

### 文書 / Documentation

- ヘルプの各小節に「こんなとき」の困りごとの例を日英で追加し、「困ったときに AI に相談する」の節を足しました。プライバシーポリシーに「ヘルプの相談」の項を足しました。
  Added "When to read this" examples of common problems to each help section, in Japanese and English, and a section on asking the AI when you are stuck. Added a "Help Consultation" item to the privacy policy.

## v0.56.0（2026-10-31）

### AI 判定に影響する変更 / Changes that affect AI screening

- Chrome 拡張の TiAb 一括判定と基準の最適化にローカル LLM（Ollama・LM Studio 等）を追加。ループバック URL だけを許可し、API キーなしで接続します。モデル一覧と JSON 応答を「保存して接続テスト」で確認します。並列1、待機0、5件ごと保存とし、クラウド用 tier に依存しません。ローカルモデルのベンチマーク結果はないため、レビュー内検証で精度を確認してください。
  Added a local LLM option (Ollama, LM Studio and the like) for TiAb batch screening and criteria optimization in the Chrome extension. Only loopback URLs are allowed, and no API key is needed. "Save and test connection" checks the model list and a JSON response. Requests run one at a time with results saved every 5 references, independent of the cloud tiers. No benchmark results exist for local models, so check accuracy with validation within your review.

### 画面 / Interface

- AI タブの接続設定を「AI の接続」カードに統合し、プロバイダを選ぶと対応するキー入力欄とモデル候補だけを表示するようにしました。
  The AI tab's settings are now one "AI connection" card: choosing a provider shows only its key field and models.

### 文書 / Documentation

- 解説動画（長編）を、AI タブの新しい接続画面で第6章を撮り直した版に差し替えました。
  The walkthrough video now uses a re-recorded chapter 6 showing the new connection card.

## v0.55.0（2026-10-20）

### AI 判定に影響する変更 / Changes that affect AI screening

- GPT-5.6 Terra / Luna の推論の強さ（reasoning effort）の設定を low にした。これまでも一括判定では low が送られており、設定の medium は使われていなかった。送る値は変わらない。
  The reasoning effort setting for GPT-5.6 Terra / Luna is now low. Batch screening already sent low (the medium setting was never used), so the value sent does not change.
- 「失敗分をリトライ」が temperature 0 で送っていたのを、通常の実行と同じ生成設定で送るようにした（Gemini 3 Flash Preview は temperature 1.0・top-p 0.95・思考レベル low）。
  "Retry failed" used to send temperature 0; it now uses the same generation settings as a normal run (for Gemini 3 Flash Preview: temperature 1.0, top-p 0.95, thinking level low).
- フルテキストの AI 判定のプロンプトの版を、TiAb と分けて `fulltext-v2.0.0` とした。v0.54.0 以前のフルテキストの判定に記録された `v1.0.0` は、TiAb の版の値が入っていたもので、フルテキストのプロンプトの文面は版の記録なしに変わっていた。TiAb のプロンプトの版は `v1.0.0` のまま。
  Full-text AI screening now has its own prompt version, `fulltext-v2.0.0`. Full-text decisions up to v0.54.0 recorded `v1.0.0`, which was the TiAb version; the full-text prompt text had changed without a version change. The TiAb prompt version stays `v1.0.0`.
- 閾値の説明を、既定値 0.3（同梱モデルの見落とし率を測った値）を推す内容に揃えた。既定値そのものは変わらない。
  The threshold guidance now recommends the default 0.3, at which the bundled models' miss rates were measured. The default itself is unchanged.

### 人の監督と注意の表示 / Human oversight and notices

- キー未開封の間はレビュー内検証を比較不能と表示し、閾値確定時に検証列を保存・上書きしない。人の組み入れが0件でも比較件数があれば、論文用テキストに比較件数と見落とし率を評価できないことを書く。
- TiAb の AI 判定を人の合議と比べ、閾値に連動して見落とし率と合否を表示する。実行前に合格基準（既定 5%）を保存でき、確定時の検証記録を論文用テキストに反映する。
  TiAb AI screening now shows the miss rate and acceptance result against reviewer consensus as the threshold changes. An acceptable miss rate (default 5%) can be saved before the run, and validation records at confirmation are included in manuscript text.
- 全文の候補ルールで、人の判定者を選ばず AI だけで候補を決めるときに警告を出す。全文の結果にも、人の票が無く AI だけで決まった文献の件数（うち除外）を警告として出す。保存も合議の規則（OR）も変えない。
  The full-text candidate rule now warns when candidates are decided by AI alone, with no human voters. Full-text results now warn with the number of reports decided by AI alone (and how many were excluded). Saving and the OR consensus rule are unchanged.
- ML の停止基準で残りを一括除外した文献を「ML の停止基準で除外（未読）」と表示し、人が判定した人数には数えない。論文用テキストでは、人が読まずに除外した件数を人の除外と分けて書く。チームの状態（除外・判定待ちなど）の決め方と保存形式は変えない。停止時のダイアログでは「続ける」を上に置いた。
  Records bulk-excluded by the ML stopping criterion are now shown as "Excluded by the ML stopping criterion (unread)" and are not counted as judged by a reviewer. The manuscript text reports the number excluded without reviewer screening separately from reviewer exclusions. How team status is determined and how decisions are stored are unchanged. The stopping dialog now lists "Continue" first.
- AI タブで Gemini を選んだとき、無料枠では送った内容が Google の改善に使われうることを表示する。フルテキストの AI 判定には、PDF を AI に送るときの著作権の注意を表示する。
  The AI tab now notes, when a Gemini model is selected, that free-tier content may be used to improve Google's products. Full-text AI screening now shows a copyright notice about sending PDFs to AI.

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
