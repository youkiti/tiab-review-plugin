# src/sidepanel/ の仕様

このファイルは ../../AGENTS.md（リポジトリ根）から Issue #195 で切り出した詳細仕様です。
リポジトリ全体の規約・基本ルールは [根の AGENTS.md](../../AGENTS.md) を参照してください。

## 機能要件

### MVP（必須機能）

1. **初期設定**

   - スプレッドシートID入力
   - References/Decisionsシート名設定
   - プロジェクト指定（Google Drive上のスプレッドシートを選択、Drive Picker 使用）
   - スプレッドシートが存在しない場合は新規作成（References/Decisions/Configシート自動生成）
   - RISアップロード機能
2. **文献読み込み**

   - Referencesから文献一覧を取得
   - Decisionsから判定状態を算出
3. **スクリーニング画面**

   - 文献情報表示（title, abstract, year, authors, journal, doi/pmid, url）
   - **キーワードハイライト機能**（include=緑, exclude=赤）
   - 判定ボタン（include / exclude / maybe）
   - 除外理由入力（exclude時必須。選択肢はプロジェクト設定 `fulltext_exclude_reasons`）
   - メモ入力
   - **キーワード編集**（サイドパネルで追加・削除→Configシートへ自動保存）
   - 次の文献へ遷移
4. **判定の記録**

   - Decisionsタブへ判定を保存
   - **human判定・ML手動確認判定**: 既存行を検索せず常に `spreadsheets.values.append` で追記（追記専用）
   - **ML自動判定・LLM判定**: 従来どおり既存行を検索し、あれば `spreadsheets.values.update` で上書き、なければ `append`
   - 読み取り側は同一 `ref_id` + `reviewer_id` + `screening_phase` の行のうち `decided_at` が最新の1行だけを有効な判定として扱う
5. **フィルタ・検索**

   - 未判定（自分が未判定）フィルタ
   - decision別フィルタ
   - maybeは未判定とは別カテゴリとして集計
   - title/abstract検索
6. **進捗表示**

   - 自分の判定件数
   - 全体の対象件数（レビュー対象総数）
   - **チーム進捗パネル**（`src/lib/team-progress.ts` + `src/sidepanel/features/team-progress.ts`）:
     管理者・非管理者を問わず全レビュアーがお互いの進捗を閲覧できる折りたたみパネル。
     TiAbタブ（ツールバー⚙️の右のチップ、クリックでドロップダウン展開・外側クリックで閉じる）と
     フルテキストタブ（候補ルール行の下、インライン展開）の両方に表示。
     - 表示内容は**件数と最終判定日時のみ**（ブラインディング維持のため include/exclude の内訳は表示しない）
     - TiAb の分母: 担当割り振り設定済みならその人の担当セット内文献数、未設定なら全文献数
     - フルテキストの分母: `fulltext_pool_rule` または担当割り振り（`fulltext_assignment_*`）が設定済みの場合に共通候補プール数
       （割り振り済みは `fulltext_set` 非空 ∪ ルール成立の和。ユーザー非依存の `isSharedFulltextPoolMember` で算出）。
       どちらも未設定時は「—」
     - 進捗にカウントする判定: 人間判定＋確定ML判定（LLM判定・ML自動判定・メモのみの pending 行は除外）
     - 3日以上判定がなく残作業があるメンバーに ⚠ を表示
     - データはプロジェクト読み込み時に取得済みの Decisions を受け取り（通信は発生しない）、🔄ボタンで再取得。自分の判定保存は即時反映
       （フルテキストページ＝別タブでの保存も `chrome.runtime.sendMessage`（`team-progress:decision-saved`）で
       サイドパネルへ通知され即時反映。他メンバーの判定の反映は🔄再取得）
     - メンバーが1人だけのプロジェクトでは表示しない
     - **担当セットの絞り込み**: 画面下部の担当セットのチェックボックスで選択中のセットだけに
       分母・分子を限定できる（表の構造はレビュアー1人1行のまま変えない）。パネル内のトグル
       「担当セットの絞り込みを反映」で ON/OFF（**既定 ON**）。TiAb ホスト・フルテキストホストで
       独立（セッション内のみ、永続化しない）
       - **各ホストは自分のフェーズの絞り込みだけを適用する**（TiAbホストは `selectedAssignmentSets`、
         フルテキストホストは `selectedFulltextSets` のみ）。両方を両ホストへ渡すと、そのタブに
         出ていないチェックボックスで反対側の列が絞られ、非管理者の既定選択（自分の担当セットのみ）の
         せいで他メンバーの行が「—」に化ける
       - TiAb 側の発動条件は `selectors.ts` の `getFilteredReferences()` の担当セットフィルターと
         同じ規則（全セット数 > 0 かつ 選択数 < 全セット数。`configured` でないときは絞らない）
       - フルテキスト側は既存の `matchesSelectedFulltextSets()`（`fulltext-assignment.ts`）を再利用
       - 絞り込みが効いていて、そのメンバーが選択中のセットに対象文献を1件も持たない場合は
         `0/0 (0%)` ではなく「—」（対象外）と表示する（`TeamMemberProgress` の `tiabInScope` /
         `fulltextInScope` で判別）
       - 絞り込みが実際に効いているときだけ、パネルに対象セット名（例:「対象: グループ1, グループ3」）を表示
       - 折りたたみ時のヘッダー要約にも絞り込み後の数字を反映する（対象外のメンバーは「—」）
7. **LLMスクリーニング支援**

   - **APIキー設定**: 先頭の「使うモデル」で全プロバイダのモデルを選び、1枚の「🔑 APIキー」カード内の Gemini / OpenRouter / OpenAI / TypeSafe 行で確認・保存する。キーは provider 別に独立保管し、端末保存のチェックボックスは4プロバイダ共通。状態チップで設定状況を示し、選択モデルのキーが未設定なら対応行を開く。
   - **Gemini APIキーの無料/有料判定**（`detectTierByBatchProbe()` / `classifyTierProbeResponse()`, `src/lib/gemini-api.ts`）:
     `batchGenerateContent` に requests が空の batch を送るプローブで判定する（1リクエスト・課金ゼロ、バッチジョブは作られない）。
     `400 FAILED_PRECONDITION` → free（課金チェックが body 検証より先に走る）、
     `400 INVALID_ARGUMENT` + message に "inlined requests"/"input file" → paid（body 検証まで進む）。
     一過性の失敗（タイムアウト・想定外レスポンス等）は必ず `unknown`（安全側の free 扱い）に倒し、`paid` と誤断定しない。
     **`models.list` のモデル件数では判定できない**（無料キーでも50件前後返るため実測で無効。旧実装の「5件以下=無料」分岐は
     事実上「常に有料」と誤判定していた）。集合差分・レスポンスヘッダ・`cachedContents.create` 等も実測で否定済み
     （詳細: `experiments/gemini-tier-detection/report.md`）。蒸し返さないこと。
   - **Tier 1/2/3 の自動判定は原理的に不可能**（APIキーだけで Tier を返す公式エンドポイントが無く、
     Cloud Billing 等は OAuth + IAM が必須）。手動選択（`ManualTier` セレクタ）に頼るしかない。
     自動判定（free/paid）は保存済みの手動設定が無い場合の**初期値の提案**にすぎない
   - **429 の `quotaId` に含まれる `FreeTier` を tier のロックに使ってはいけない**。有料 Tier 2/3 の
     プロジェクトが FreeTier バケットへルーティングされて 429 になる報告があり、これで tier を固定すると
     有料ユーザーを無料に縛ってしまう。`isFreeTierQuota`（PR #87 の 429 適応スロットリング）は**減速の根拠にのみ**使う
   - この判定器は公式APIの仕様ではなく entitlement チェックの実行順序という副作用を観測しているため、
     Google が将来 Batch API を無料枠に開放すると「全キーを paid と誤判定する」方向に壊れるリスクがある。
     そのため PR #87 の 429 適応スロットリングを安全網として併設している
   - **Gemini の implicit prompt caching で TiAb のコストは下げられない**（実測で確定、2026-09-01）。
     キャッシュ入力は標準入力の 0.10 倍なので、得になる条件は `N < C0 / m = 10 × C0`
     ＝**共有プレフィックスは10倍までしか伸ばせない**。現行の screeningPrompt は実測109トークンで
     上限1,090トークンだが、implicit caching の実測閾値は `gemini-3.1-flash-lite` で
     `5,852 < 閾値 ≤ 6,111` と約6倍高い（公称は「モデルにより2,048〜4,096」だが flash-lite の行は無い）。
     閾値が仮に2,048でも成立しないため、単価倍率や閾値の細かい値に結論は依存しない。プロンプトを
     水増しして閾値に届かせる方向は**どう転んでも損**（詳細: `experiments/gemini-prompt-cache/report.md`）。
     蒸し返さないこと。なお前置きが別の理由で既に閾値を超えているユーザーには implicit caching が
     既定で効いており、**実装すべきものは無い**
   - **モデル選択**: Gemini 2 種 + OpenRouter 2 種 (Qwen3 235B Instruct, DeepSeek V4 Flash) + OpenAI 2 種 (GPT-5.6 Terra, GPT-5.6 Luna) + TypeSafe (`jev-1.13.0`) から選択
   - **OpenRouter カスタムモデル**: キー設定済みの OpenRouter 行内の「＋ 一覧にないモデルを追加」からフォームを開く（一覧も同じ行内に表示）。任意のモデル ID を手入力 → 実 API テスト成功時のみ `chrome.storage.local` (`openrouter_custom_models`) に永続化し、モデル選択肢に追加。最大 20 件。ベンチマーク未検証であることをUIで明示する。
   - **判定基準設定**: プロンプト・判定基準のカスタマイズ
   - **一括判定**: LLMによる自動判定（バッチ処理）。対象の決定ロジックは `src/lib/llm-batch-target.ts`（純粋関数）に集約
     - **人間の判定状況では絞らない**。AIは独立した判定者なので、人間（自分を含む）が判定済みの文献も対象に含める。
       `status`（＝自分の判定）で絞ると「自分が手動判定した分だけAIの対象件数が減る」（例: 全50件中2件を自分が判定 → AI対象が48件）
       という、ログインユーザーによって判定範囲が変わる非対称な挙動になる
     - **対象の絞り込みは Run 単位**。「これから実行する Run（config_hash で解決）で既に判定済みの文献」だけを除外する
       （`ReferenceWithStatus.llmBatchIds` と Run 配下の Batch ID 集合を突き合わせる）。
       グローバルに「AI判定済みか」で絞ると、最初のRunが全件を判定した時点で2つ目以降のRunが常に0件になり、
       Runの採用選択（`is_active`）が機能しなくなる
     - **中断からの再開**: 設定が同じなら `findRunByConfigHash` が既存Runを再利用し、残りだけを新しいBatchとして処理する。
       再開できる件数がある場合は一括実行カードに「$1件が判定済み」と表示する
     - **新規にやり直す**: 「🔄 新規にやり直す」ボタン（`state.forceNewLlmRun`）をONにすると、既存Runを再利用せず
       新しいRunとして全文献を判定する。**既存の判定・履歴は一切削除しない**（Decisions/LLM_Executions/LLM_Runs はそのまま残り、
       どちらのRunを採用するかは実行履歴のラジオボタンで選ぶ）。新Run作成時にフラグは自動でOFFに戻る
     - これにより同一 config_hash のRunが複数存在しうる。`pickRunByConfigHash` は再開先として
       **最新 created_at** のRunを返す（同時刻のみ active confirmed > confirmed > pending）。
       legacy移行（run_id空のBatch集約）は逆に最古のRunへ寄せる（`pickLegacyRunByConfigHash`）
     - **件数表示（`updateBatchTargetCount`）は Sheets を再読み込みせず** `state.llmRuns` / `state.llmExecutions` のキャッシュで計算する
       （`loadExecutionHistory` が更新）。モデル・プロンプト変更のたびにAPIを叩くと読み取りクォータを超過するため
     - **実行時（`handleStartBatch`）は Run/Batch に加えて、その Run で判定済みの ref_id も Sheets から取り直す**
       （`getJudgedRefIdsForBatches`）。件数表示のキャッシュ（`llmBatchIds`）は画面ロード時のスナップショットなので、
       他レビュアーが直前に判定した分を取りこぼす。取りこぼすと同一Runに同じ文献のLLM票が二重に入り、
       AI同士の偽の不一致（conflict）が画面に出てしまうため、実行直前だけはサーバーの真値で対象を確定する
       （`selectBatchTargetsByJudgedRefIds`）
     - **基準最適化（`handleOptimizeCriteria`）後は `updateBatchTargetCount()` を明示的に呼ぶ**。
       最適化結果はプロンプト・判定基準をプログラムから代入するため `input` イベントが発火せず、
       config_hash が変わって別Runになったのに対象件数・実行モード表示が古いRunのまま残ってしまう
     - **対象の限定**: 既定は従来どおり全件（`state.references`）。人間がお試しスクリーニングした集合と
       同じものをAIに判定させたいという要望（2026-08）に応えるため、担当セット単位＋個別チェックボックスで
       対象 ref_id を限定できる。対象決定の純粋ロジックは `src/lib/llm-target-selection.ts`、
       UIは `src/sidepanel/features/llm/target-picker.ts`
     - **選択は config_hash に含めない**。含めると対象を変えるたびに別Runが生まれ、「中断からの再開」
       「新規にやり直す」が壊れるため。同じ設定なら対象を絞っても同じRunの続きとして扱われる
     - **選択モードでは実行上限（10/50/100/500/すべて）を無視**して選んだ分を全部投げる。
       「100件選んだのに上限50で切られた」という事故を防ぐため。UI側では上限セレクトをdisabledにする
     - **選択は Config シートに保存**（`llm_target_mode` / `llm_target_ref_ids`）。チームで同じ対象集合を
       再現できるようにするため。ref_id は UUID なので1セル5万字上限から約1,350件が物理上限で、
       余裕を見て**1,000件で頭打ち**（`LLM_TARGET_REF_ID_LIMIT`）
     - **`updateLlmConfig` は複数キーを渡しても「1回の書き込み」にはならない**。`tryUpdateLlmConfig`
       （`sheets/config.ts`）は updates を `Object.entries()` で回し、**キー1個につき1回 `updateRange` を
       逐次実行する**。途中で失敗すると中途半端な状態がシートに残るため、`llm_target_mode` と
       `llm_target_ref_ids` のように意味が結びついた2キーは、**失敗しても安全側（＝従来どおり全件対象）へ
       倒れる順序**で1件ずつ書くこと。順序は方向で変わる（絞り込む `selection` 方向は ref_ids → mode、
       全件へ戻す `all` 方向は mode → ref_ids）。順序決定は `buildTargetConfigUpdates`
       （`llm-target-selection.ts`）に集約してテストしている。オブジェクトリテラルのキー順に暗黙で
       依存する書き方はしないこと
     - **保存に失敗したら state を保存前の値へ巻き戻す**。`switchToTab('llm')` は毎回
       `initializeLlmSection()` を呼んでシートから設定を読み直すため、state だけ新しい値のまま残すと
       タブを往復しただけで表示が黙って戻る（トーストは既に消えている）
     - **実行履歴に対象を記録**: `LLM_Executions` の `target_mode` / `target_sets` / `target_selected_count`。
       後から「この Run は calibration の50件を対象にした」と論文に書けるようにするため
     - **非管理者の `state.references` は担当セットで絞られている**ため、他人の担当分の ref_id が選択に
       含まれていても対象から落ちる。件数の内訳（見つからない件数・この Run で判定済みの件数）をUIに出して
       0件表示の理由を追えるようにしている
     - Blind 中は他レビュアーの判定がクライアントに配られないため、モーダルの判定状態表示は自分の判定のみ。
       **判定状態は表示専用で、選択の絞り込み条件には使っていない**
     - **グループ選択は担当セットと取り込みファイル（`source_file`）の2種**。option 値は `set:<id>` /
       `file:<name>` で、デコードは `parseTargetGroupValue`（接頭辞判定。ファイル名にコロンが混じるため）
   - **結果表示**: LLMの判定結果・理由の表示
8. **フルテキストAI判定（PDF全文）**

   - **プロバイダ**: Gemini のみ（スキャン画像PDFもネイティブにOCR/読解。`gemini-fulltext.ts`）
   - **UI**: フルテキストタブを3分割（候補リスト / **AI判定** / 判定後レビュー）。AI判定タブは**一括処理専用**
   - **対象**: `fulltext_status='cached'`（Drive保存済み）かつ採用ラウンドで未AI判定の候補。PDFを inline_data で丸ごと送信。
     対象決定ロジックは `src/lib/fulltext-ai-target.ts`（純粋関数）に集約する
     - **対象範囲の既定はプロジェクト全体**（`scope='project'` = `getProjectFulltextCandidateList()`）。
       AIは人間とは独立した判定者なので、人間側の分業（フルテキスト担当割り振り・担当セット絞り込み）では対象を狭めない。
       管理者が自分では読まない文献も含めて一括AI判定できる必要がある（2026-08 の要望）。
       「自分の担当分のみ」（従来の `getVisibleFulltextCandidateList()` 基準）はラジオで選べる
     - **「AI判定済みか」は Decisions タブを読んで判定する**（`collectAiJudgedRefIds`）。
       Blind 中（key_opened=FALSE）は `ReferenceWithStatus.allFulltextDecisions` が空になるため、
       参照側の票から導くと常に「未判定」に見え、同じPDFを何度も課金して判定してしまう
     - 除外に使うのは**採用ラウンド**（Config `fulltext_ai_active_round`）のみ。採用ラウンドが無ければ除外しない
       （別モデルでラウンドをもう1本作れる）。件数表示には「判定済みのため除外: N件」を併記し、0件表示の理由を追えるようにする
     - **実行直前（`handleStartAiBatch`）は Decisions を読み直してサーバーの真値で対象を確定する**。
       TiAb バッチ（`getJudgedRefIdsForBatches`）と同じ理由で、他レビュアーが直前に実行した分を取りこぼさないため
   - **保存**: AIは独立した判定者として確定保存（`reviewer_id='llm:{model}@{timestamp}'`, `screening_phase='fulltext'`）。
     `note` に `FulltextLlmDecisionNote`(JSON: decision根拠 evidence[quote/page/bbox] 等) を格納
   - **実行履歴**（Issue #62）: `handleStartAiBatch` は `LLM_Executions` へ
     `execution_type='fulltext_batch_screening'` の行を2フェーズで書く（開始時に `status='pending'`
     で先書き→終了時に `status='confirmed'` へ確定）。`execution_id` は `reviewer_id`（ラウンドID）と同一。
     全件失敗して Decisions に1行も残らなくても「実行したが0件成功だった」という事実がこの行として残る。
     TiAb 用の列に加え `executed_by`（実行アカウント）・`maybe_count`（フルテキストは3値判定）・
     `failed_count`・`failure_breakdown`（`src/lib/fulltext-ai-failures.ts` の
     `FulltextAiFailureKind` 別内訳をJSON文字列化したもの）・`exclude_reasons_snapshot`
     （判定時点の除外理由リストのJSON文字列 `[{key,label,labelEn}]`。`criteria_snapshot` /
     `screening_prompt` と同列のスナップショットで、後から `fulltext_exclude_reasons` の
     ラベルを変えても過去 Run の区分の意味を復元できるようにする。TiAb の実行では null）を持つ。
     **`is_active` は使わず、採用状態は常に Config の `fulltext_ai_active_round` が正**（常に `false` 固定で保存する）。
     **TiAb の Run/Batch モデルには載せない**: `loadExecutionHistory`（`llm/batch.ts`）は
     `fulltext_batch_screening` 行を TiAb の実行履歴一覧から除外し、`findOrphanedExecutions`
     （`llm/recovery.ts`、孤立判定の復旧）は `screening_phase==='fulltext'` の判定行を対象から除外する
     （reviewer_id の形式が `llm:{model}@{timestamp}` で TiAb と同じため、除外しないと誤検出・混入する）。
     フルテキストの実行履歴自体は AI判定タブのラウンド一覧（`src/lib/fulltext-ai-rounds.ts` の
     `mergeRoundsWithExecutions` が Decisions由来のラウンドと結合する）で表示する
   - **PDFハイライト**（`fulltext.html` + `pdf-renderer.ts`）: cached PDF を PDF.js でテキストレイヤー付き描画し、
     evidence を **経路A: quote文字列マッチ → 経路B: 正規化bbox → ページ送り** の順で段階的にハイライト。
     スキャン画像PDFはテキストレイヤーが無いため bbox（AIの領域推定）を使う旨をUIに明示
   - **依存**: `pdfjs-dist`（worker/cmaps/standard_fonts を dist 直下へ同梱）。
     manifest に `content_security_policy.extension_pages`（`wasm-unsafe-eval`）を追加
   - **TiAbのAIラウンドとは別枠**: 全文閲覧ウィンドウのハイライトは `screening_phase='fulltext'` の
     `llm:` 判定のうち**採用ラウンド**（Config `fulltext_ai_active_round`）のものだけを使う。
     TiAb のAIラウンドは evidence が抄録の文字オフセットでPDF座標に落とせないため、
     `note.type === 'llm_fulltext'` でも弾かれる。「AI判定なら2つある」と混同されやすいので、
     UI文言では必ず「フルテキストAI判定」と書き分けること
   - **evidence が0件のときの文言**（`src/lib/ai-evidence-empty-reason.ts`）: 未実行 / 未採用 /
     採用ラウンド消失 / この文献に根拠なし を切り分け、UIから辿れる導線を案内する。
     Config の生キー名をユーザー向け文言に出さないこと（UIから編集できないため誤誘導になる。2026-08 実事故）。
     ただし表示レベル `none`（AI evidence 非表示の実験条件）では、理由で文言を変えると
     「この文献にAI判定があるか」が漏れるため、必ず既定文言に固定する
9. **論文用テキスト生成**（`manuscript.ts`）

   - TiAb エクスポートメニューとフルテキスト結果ビューから、Methods / Results / PRISMA 2020 フロー数値の英語下書きをモーダル表示し、セクションごとにコピー可能
   - 数値は `import_stats`・判定データ・判定者選択から自動挿入。ツールが持たない情報（不一致の解消方法など）は `[ ]` で残す
   - 未判定・保留・不一致が残る場合や、インポート統計のないファイル（重複除去後の件数に `*` 付与）は警告を表示
   - PRISMA の数値・論文用テキスト・CSV/RIS エクスポートはログインユーザーに依存させず `getProjectFulltextCandidateList()`（`state.allReferences` 基準）でプロジェクト全体を集計する。候補一覧・入手状況・一括OA検索は「自分が読む対象」なので担当割り振り込みの `getVisibleFulltextCandidateList()` / 割り振りのみの `getFulltextCandidateList()` を使い分けてよいが、非管理者の `state.references` はTiAb担当セットで絞られているため論文用集計には使わない。**フルテキストAI一括判定は「人間が読む対象」ではないので既定でプロジェクト全体**（機能要件8参照）
   - `state.allReferences` を見る画面を足したら、判定後に references を再読込する処理（`features/fulltext/ai.ts` の `reloadReferences` など）でも `state.setAllReferences()` を呼ぶこと。`syncSetReferences()` だけだと絞り込み前の全文献が古いままになる
   - **PRISMA の腕別集計（Issue #120）**: Registry linkage 由来の取り込み行（`related_ref_id` 非空）は PRISMA 2020 の「Identification of studies via other methods」腕として database 腕から分離集計する。判定と分割は `src/lib/identification-route.ts`（純関数）の `identificationRouteOf()` / `splitByIdentificationRoute()`。**判定条件は `related_ref_id` 非空のみにそろえること。** `src/lib/fulltext-candidates.ts` の `isProjectFulltextCandidateRef()` が候補プールへ無条件投入する条件と一致させないと、腕別集計の合計が候補総数と合わなくなる。`source` の `Registry linkage` 接頭辞は使わない。`getFulltextResultsSummary()` は**database 腕だけ**を返す。両腕が要るときは `getFulltextResultsSummaryByRoute()` を使う。other methods 腕の PRISMA 行組み立ては `buildOtherMethodsPrismaLines()`。該当0件なら**空配列**を返す（0件時に現行出力と1文字も変わらないことをこの性質で担保している）。全文結果CSVでは `identification_route` 列（`database` / `registry_linkage`）の後ろに `adjudication_memo` 列が続く。追加列は既存の固定列・判定者列のインデックスをずらさないよう末尾側に足す
   - **同じ原因（取り込み行が `state.allReferences` に混ざっている）で database 腕の数字が汚れる箇所が複数ある**ので、`state.allReferences` や候補一覧をそのまま数える処理を足すときは腕別に分けるかを必ず確認すること。`collectIdentification()`: 取り込み行は `source_file` を設定していないので、除外しないと `(unknown source)` として `Records identified from databases` と `Records screened` を水増しし、「* Import statistics were not recorded」の脚注まで出る。`countUnscreenedTiab()`: 取り込み行は**設計上TiAb票を一切持たない**ので、除外しないと全件「TiAb未判定」として数えられ実態のない警告が出る。論文用テキストの `sought`: 両腕の合算のままだと registry 行が同じフロー図内で**二重に数えられる**（`Reports sought for retrieval` と `Records excluded` の両方）。ただし**未決着の警告は逆に両腕の合算で出す**こと。database 腕だけを見ると registry 腕に pending / maybe / 未解消が残っていても「数値は最終値」と誤読させるため
   - **`identified − duplicates = screened` の縦の辻褄（Issue #145 チャンク2）**: `collectIdentification()` は state 依存でテストできなかったため、集計の核を `src/lib/prisma-identification.ts` の `computeIdentification()`（純関数）へ切り出した。書誌重複のうち取り込み時に自動スキップされなかった分（正規化タイトル一致など）は References に行として残り `duplicate_of` で論理削除されるため、`import_stats.duplicates`（自動スキップ分のみ、上記Configタブの節参照）だけでは重複除去数が過少になる。`computeIdentification()` は database 腕（`splitByIdentificationRoute()` で絞り込み後）の論理削除件数を `duplicatesTotal` へ合算することでこれを補う。判定（Decisions）が付いていたかどうかでは区別しない — 書誌重複はそもそもスクリーニング前に除くべきものだった、という整理。渡す `refs` は論理削除済みの行も含む全件（`getReferences()` 由来）が前提で、そうでない一覧（`getReferencesWithStatus()` 等）しか手元に無い呼び出し元は `refsMayOmitLogicallyDeleted: true` を渡すこと（渡さないと `duplicatesTotal` が論理削除件数の分だけ黙って過少になる）。`showManuscriptModal()` は集計のためだけに `getReferences()` を取り直しており、取得に失敗した場合は `duplicatesTotal: null` / `statsComplete: false` にして既存の「統計未記録ファイルがある」経路（`[n]` 表示・`manuscript_warnNoStats` 警告）へ合流させる（数字が黙って狂わないようにするため）

### 個人の表示設定（Issue #154）

- `src/lib/user-settings.ts` が `UserSettings` の定義・既定値・ストレージ値の検証の唯一の場所。設定を追加するときは **型 → `DEFAULT_USER_SETTINGS` → `USER_SETTINGS_STORAGE_KEYS` → `parseUserSettings` → 画面の対応付け** の順に更新し、パースと保存の往復テストを追加する。既定値を `state.ts`・reducer・設定画面へコピーしない。
- 保存対象は従来の6キー（自動遷移、件数、検索AND/OR、MLの手動扱い、抄録見出しの有効化・見出し配列）。既存キー・保存形式を維持し、未知のキーは読み飛ばし、保存時は部分更新する。抄録見出しは文字列配列を検証して空行を除き、空配列は有効とする。`DEFAULT_ABSTRACT_SUBSECTION_HEADINGS` は同モジュールで定義し、`features/settings.ts` から再exportする。
- `UserSettings` は既存の `ui.settings` の表示状態も包含する。`showAiHighlights` とレビュアー別の `aiDecisionFilter` はセッション内だけの表示状態で、従来どおり永続化しない。保存・読み込みの対象は `USER_SETTINGS_STORAGE_KEYS` のみであり、この2項目の変更はストレージの往復では復元しない。
- 所有者・更新先は `Store.ui.settings` のみ。`state.ts` の設定プロパティはStoreを読むgetterだけとし、setterやcompatの双方向同期を追加しない。更新は `settings/patch`（または既存の設定アクション）で行い、画面イベントはStore更新 → 保存 → 関連描画の順を維持する。
- 共通の `bootstrapCommon()` は依存注入・イベント配線より先にStoreを初期化する。`store/index.ts`・reducer・selectorは旧 `state.ts` に依存しないため、読み取りアダプタはStoreを直接参照する。新しい依存を追加するときもこの方向を守る。

### スクリーニングの絞り込み状態と現在文献（Issue #154）

- `ui.screening` の表示位置・ステータス・検索文字列・ターム・キー開封状態と、`data` の文献一覧・ソースファイル選択・担当設定・担当セット選択（TiAb / フルテキスト）は Store が唯一の更新先。`state.ts` の該当プロパティは getter のみで、更新は `store/compat.ts` の dispatch 専用ラッパーを通す。これらは互換レイヤーの双方向同期対象に戻さない。
- 絞り込みの実装は `store/selectors.ts` の `getFilteredReferences(state)` に集約する。ステータス → ソースファイル → 担当セット → 検索・ターム → キー開封時の判定フィルターの順に適用する。`features/screening/filters.ts` は既存の計測を残した薄い窓口。
- 担当設定の既定値と、空の `screening_set` を設定済みの場合だけ `unassigned` とみなす判定は `lib/assignment-set.ts` に置く。selector から features を import しない。
- `getScreeningCounts(refs)` は呼び出し側の対象配列、`getFilterCounts(state)` はソースファイル絞り込み後の配列を数える。対象範囲の違いを維持し、手動判定・全文候補・判定票収集のヘルパーのみ共有する。
- 検索入力は `screening/setSearch` で更新し表示位置を0へ戻す。描画から dispatch しない。同じ表示位置、または既に位置0で同じ検索・ステータスを設定する場合は reducer が元の state を返す。

### state.ts の残り領域をStore所有に一本化（Issue #154 工程3）

- `spreadsheetId`・`userEmail`・`highlightKeywords`（キーワード追加/削除含む）・`isAdmin`・`fulltextPoolRule`・`fulltextAssignment`・`availableReviewers`・`enabledReviewers`（追加/削除含む）・`currentTab` の9領域もStoreが唯一の更新先になった。`state.ts` は getter のみで、更新は `store/compat.ts` の dispatch 専用ラッパー（キーワードは `addIncludeKeyword`/`removeIncludeKeyword`/`addExcludeKeyword`/`removeExcludeKeyword`、レビュアーは `addEnabledReviewer`/`removeEnabledReviewer`）を通す。
- レビュアーの追加/削除は既存の `data/toggleReviewer` ではなく新設の `data/addReviewer`/`data/removeReviewer` を使う。混在レビュアー（人手＋ML）のチェックボックス切替は本体キーと `::ml` キーへ同じ enabled 値を独立に適用するため、現在の集合への反転（toggle）だと意図せず反転する。
- `state.ts` の `resetForLogout()`/`resetForBack()` からはこれら9領域の再初期化を外し、初期化経路は Store の `reset/logout`・`reset/back`（`store/reducer.ts`）だけになった。`highlightKeywords`・`availableReviewers`・`enabledReviewers` は `reset/logout` で initialState に戻る一方、legacyの `resetForLogout()` は保持していたが、`loadDataAndShowScreening()`（`features/project.ts`）がプロジェクト読み込み時に必ず `syncSetKeywords`/`syncSetAvailableReviewers`/`syncSetEnabledReviewers` で再設定するため実害はない。
- 呼び出し元が0件だった `src/sidepanel/render/index.ts`（`renderApp()` と再export のみ）は削除した。Store購読の実入口は `bootstrap.ts`（`renderLayout`/`renderTemporaryUI` を直接購読）。
- LLM/ML バッチ領域（`llmConfig`・`mlState`・`activeLlmExecutionIds`・`currentBatchDecisions`・`failedRefIds`）も同じやり方でStore所有に一本化した。`state.ts` は getter のみで、`store/compat.ts` の `setLlmConfig`/`setMlState`/`setActiveLlmExecutionIds` は dispatch専用に変わり、`features/llm/batch/`（`run.ts`・`threshold.ts`）が直接呼んでいた `state.setCurrentBatchDecisions`/`setFailedRefIds`/`clearFailedRefIds` 用に同名の compat ラッパーを新設した。`clearFailedRefIds` は `activeLlmExecutionIds` の `data/clearActiveLlmExecutionIds` と違い1件ずつ追加するAPIが無く常に配列全体を差し替える領域なので、専用アクションを新設せず `data/setFailedRefIds` に空配列を渡す。これで **compat.ts に残る `legacyState.` 呼び出しは `resetForLogout`/`resetForBack` の2つだけ**になった。Store未移行のまま `state.ts` に残る legacy 専有領域は `batchAbortController`・`currentExecutionId`・`llmRuns`/`llmExecutions`・`forceNewLlmRun`・`llmTargetMode`/`llmTargetRefIds`・`consensusMode`（Issue #154 工程3 の対象外）。

### TiAb 表示位置の記憶と復元（Issue #140）

- 保存: `renderReferenceDetails`（`src/sidepanel/features/screening/render.ts`）がキー開封中かつ履歴ビューでないときに `{filter, refId, index}` を `tiab_last_position`（`Record<spreadsheetId, ScreeningPosition>`、`chrome.storage` ローカル）へ保存する。同一内容の連続保存は書き込みをスキップする
- 復元: `loadDataAndShowScreening`（`src/sidepanel/features/project.ts`）がキー開封中のみ読み、ステータスフィルターを切り替えてから ref_id で位置を探し、見つからなければ index にフォールバックする（`resolveRestoredIndex`）。Blind中は復元しない（未判定フィルターでは判定済みが抜けるので実質先頭に等しく、初回体験を変えないため）
- 純関数は `src/lib/screening-position.ts`、テストは `tests/screening-position.test.ts`

### キーボードショートカット

- `i` : Include
- `e` : Exclude
- `m` : Maybe
- `n` / `→` : 次へ
- `p` / `←` : 前へ
- `c` : レビュー基準（組入・除外基準）の表示/非表示

**入力欄の Enter と日本語入力（IME）**

- フルテキストの補足メモ欄（`ft-reason-note`）は `Enter` で「保存して次の候補へ」、`Shift+Enter` で改行、`Escape` でフォーカス解除
- 日本語入力では**変換の確定にも `Enter` を使う**ため、Enter にアクションを割り当てた入力欄では
  `src/lib/ime-composition.ts` の `isImeComposing()` で変換中のキーを必ず読み飛ばすこと。
  これを忘れると、メモを書いている途中の変換確定で次の文献へ飛ぶ（キーワード入力欄なら半端な語が登録される）
  - `isComposing` / `keyCode === 229` に加え、`compositionstart` / `compositionend` で追跡した状態も渡せる
    （`isComposing` を立てない IME への保険。補足メモ欄はこの追跡込みで実装している）


### アプリ内ヘルプ（?ボタン）

- 各カード・画面の見出しの横に置く「?」ボタン（`<button class="guide-help-btn" data-help="<トピックID>">`）は、押すと吹き出しを開き、ヘルプページ（`docs/help.html`）の該当する見出しへ UI の言語で飛ぶ。ヘルプページが唯一の正本で、アプリ側に説明文は持たない
- トピックと見出し id の対応表の正本は `src/lib/guide/topics.ts`（`GUIDE_TOPICS`）。トピックごとの短い見出しは `guide_topic_<ID のハイフンをアンダースコアにしたもの>`（ja/en の両方）
- **`docs/help.html` の見出しの `id` は変えない**（アプリ・招待文・外部から参照されている）。変えるときは対応表とテストも一緒に直す。見出しを足すときは `<section>` の id を接頭辞にした id を付ける
- 新しいカード・画面を足したら、見出しの横に `data-help` を付ける。ヘルプに該当する節が無ければ、先にヘルプへ節と id を足す。実行時に生成する「?」は `dataset.help = '<トピックID>'` で指定する（テストが拾う）
- 拡張版でしか表示されないトピック（Web 版では `capabilities` で該当セクションごと隠れる）は、`topics.ts` で `extensionOnly: true` を付け、見出しのキーを `guideExt_topic_*` にする。`guideExt_` は Web 版ビルドの messages.json から落とされる（`scripts/webpack/strip-locale-keys.cjs`）。それ以外は `guide_topic_*`。どちらを使うかは `guideTopicTitleKey()` が決め、`tests/guide-topics.test.ts` が検査する
- 実行時に描画する領域（チーム進捗パネル・重複の確認・セットアップチェックリスト）の「?」は `features/guide/button.ts` の `createGuideHelpButton('<ID>')` で作る。既存の `.help-icon`（ツールチップ付き）に `data-help` を付けて、クリックで吹き出しも開くようにしてもよい
- 構成: 初期バンドルには `features/guide/lazy.ts`（document へのクリック委譲と本体の遅延読み込みだけ）。吹き出し本体は `features/guide/index.ts`（チャンク `guide-feature`）で、`topics.ts` もここに入る。`lazy.ts` から `topics.ts` を静的 import しない（初期バンドルの予算のため）
- 吹き出しのボタン列は `buildActions()` が配列から描画する。後続のツアー開始ボタンなどはここへ足す
- 吹き出しの「▶ 動画で見る」は `src/lib/guide/topics.ts` の `video` があるトピックだけに出る。長編の ID と章の開始秒の正本は `GUIDE_VIDEO_ID`・`GUIDE_VIDEO_CHAPTERS`。長編で扱っていない画面には付けない。`tests/guide-topics.test.ts` がサイトの埋め込みとの一致を検査する
- フルテキスト判定ページ（`fulltext.html`）は別バンドルのため吹き出しを持たず、ヘッダーの「?」リンクがヘルプの該当節（`#fulltext-decisions`）を直接開く
- 照合は `tests/guide-topics.test.ts`（対応表のアンカー実在・`data-help` の過不足・`help.html#id` リンクの実在・見出しの日英 span・ja/en のキーとプレースホルダ一致）

### ツアー（操作に連動する案内）

- 構成: 定義は `src/lib/guide/tours/`（ツアー1本につき1ファイル `<ツアーID>.ts`。純粋なデータ。手順・進む条件・対象の `data-tour` 値）、集約と型は `tours/index.ts`・`tours/types.ts`、進行状態の純関数は `src/lib/guide/tour-progress.ts`、画面は `src/sidepanel/features/guide/`。ツアー本体は遅延チャンク `guide-feature` に入れる。初期バンドルに置くのは、イベントを投げる小さな関数（`emitGuideEvent`）と、本体を読むかどうかの判定だけ。初期 JS の予算（`scripts/bundle-budget.json`）に余裕が少ないため、初期側から `tours/` の本体を静的 import しない（型は `import type`）
- ランナー・進行状態の保存・カード配置・提案の帯の見た目は、サイドパネルと全文の判定ページの共有部品として `src/guide-ui/` に置く（`tour-runner.ts` の `createTourRunner(host)`、`tour-store.ts`、`placement.ts`、`suggest-band.ts`）。**`guide-ui/` は `sidepanel/`・`fulltext/` を import しない**（画面ごとに違う部分＝条件の計算・プラットフォームの判定・ダイアログの場所は `host` の引数で受け取る）。`lib/` からも import しない（`scripts/check-structure.mjs` の `UI` と `.eslintrc.cjs` が検出する）。サイドパネル側の `features/guide/tour-runner.ts` は host を渡して組み立てるだけの薄い入口で、`startGuideTour`・`resumeGuideTour`・`handleTourEvent` の形は変えない
- 全文の判定ページ（`page: 'fulltext'`）のツアーは、`src/fulltext/` が別に組み立てる。入口 `guide.ts`（初期バンドル。保存値を粗く見て、再開か初回の提案が要りそうなときと「ツアー」ボタン（`#ft-tour-btn`、`data-guide-action="start-tour"`）を押したときだけ本体を読む。`tours/`・`tour-progress.ts`・`guide-ui/` を静的 import しない）、本体 `guide-feature.ts`（遅延チャンク `fulltext-guide`。サイドパネルの `guide-feature` とは別のエントリなので別名）、条件 `guide-conditions.ts`。始め方は、初めて開いたときの帯（`#guide-page-suggest`。`data-guide-action` は `start` / `dismiss` でサイドパネルのタブの提案と同じ。判定は `tourToSuggestOnPage`。`suggestOn` はサイドパネルのツアーだけの項目なので使わない）と、ヘッダーの「ツアー」ボタン。画面側のイベントは `src/fulltext/guide.ts` の `emitGuideEvent`（文字列リテラルで呼ぶ。次の候補への移動など同じ処理の続きが終わってから届くよう、タイマーで1拍遅らせて投げる）
- 進行状態（`guide_progress`）はサイドパネルと全文の判定ページで共有する。それぞれが保持値を持つので、保存したら `platform().emitMessage({ type: 'guide:progress-changed' })` で知らせ、受けた側は保存値を読み直す。保存値を正として、全画面が同じ手順を表示する（純関数 `decideProgressSync`）。実行中のツアーが別の画面で終わった・別のツアーに置き換えられたら、カードは消える（同時に走るのは1本だけで、あとから始めた方が置き換える）。同じツアーが複数の画面（全文の判定ページを別の文献で2タブ開く、サイドパネルを2ウィンドウで開く、など）で動いているときは、手順が違う画面が保存値の手順へ切り替わる。追従では保存しない（通知が往復しない）。追従先が、その画面の条件で飛ばされる手順でも、自分では先へ進めず、対象が見えなければ待機表示になる
- ツアーを足す手順（枠は `draft: true` で作成済み。**自分のツアーのファイル・条件ファイル・文言の自分の区画・シナリオだけを触る**）:
  1. `src/lib/guide/tours/<ID>.ts` に手順（`steps`）を書く。このツアーだけが使うイベント名・条件名は、同じファイルの `<Pascal>Event`・`<Pascal>Condition`（枠では `never`）の型を広げて足す（`GuideEventName`・`GuideCondition` は `index.ts` が各ファイルの型の合併で組み立てるので、`index.ts` は触らない）。文言のキーは `tours/keys.ts` の `tourKeyBase`・`stepKey` で組み立てる
  2. 手順の `skipIf` に固有の条件を使うなら、`src/sidepanel/features/guide/conditions/<ID>.ts` の `compute<Pascal>Conditions()` に真偽の計算を書く（返す型が `Record<<Pascal>Condition, boolean>` なので、条件名を足したら返し忘れがコンパイルで落ちる）。共通の条件（`tours/types.ts` の `CommonGuideCondition`）は `tour-conditions.ts` が計算する
  3. 対象の要素に `data-tour="<対象>"` を付ける。見た目用の class や構造に依存させない（デザイン変更で黙って壊れるため）。`page: 'fulltext'` のツアーの対象は `src/fulltext/fulltext.html`（動的な対象は `src/fulltext/` の TypeScript）に付ける
  4. 進む条件・提案に新しいイベントが要るなら、自分のツアーの `<Pascal>Event` に足し、該当する操作の完了箇所に `emitGuideEvent` の呼び出しを足す。共通のイベント（`types.ts` の `CommonGuideEventName`）は複数のツアーで使うものだけ
  5. 文言を ja/en の `messages.json` の**自分のツアーの区画**に同じキーで入れる（下の「文言の置き場所」）。拡張版だけのツアーの文言は `guideExt_` 接頭辞にする（Web 版ビルドの messages.json から落とすため。`scripts/webpack/strip-locale-keys.cjs`）
  6. `scripts/guide-tour-check/scenarios/<ID>.mjs` にシナリオを1本足す（書き方は `scripts/guide-tour-check/lib/scenario.mjs` のコメント）
  7. `draft: true` を外す。外すと、一覧・提案・開始・テストの照合の対象になる（`draft` のツアーは手順が空、`draft` でないツアーは手順が1つ以上、とテストが検査する）
  8. `npm test`（定義と HTML・文言の照合）と、`npm run build:demo && npm run check:tours`（デモビルドでの通し検証）を回す。`check:tours` はブラウザが要るので CI には入っていない。UI やツアーを変えたら手元で回すこと
  9. 解説動画が要るツアーなら `npm run video:tours -- <ID>` で作れる（映像も原稿もツアーから作る。手順は `video/README.md` の「操作ツアーの解説動画」）。文言に新しい英字を入れたら、読み上げ用の読み替え（`video/scripts/tour-videos.mjs` の `READINGS`）にも足す
- 並列で足すときに触ってよいファイル: 自分の `tours/<ID>.ts`、自分の `features/guide/conditions/<ID>.ts`、自分の `scenarios/<ID>.mjs`、`messages.json`（ja/en）の自分の区画、`data-tour` を付ける画面（HTML・TypeScript）と `emitGuideEvent` を足す操作の完了箇所。**`tours/index.ts`・`tours/types.ts`・`topics.ts`（「?」とツアーの対応 `tourId` は入力済みなので触らない。吹き出しの開始ボタンは draft を外すと自動で出る）・`tour-conditions.ts`・`tour-progress.ts`・ランナー・`lib/` の検証道具は共有部分なので、触るなら別の変更として分ける**（共通のイベント・条件・ランナーの挙動を足すとき）
- 文言の置き場所: `messages.json` は**ツアーごとに title → desc → 手順の本文の順の1つの区画**で、区画と区画の間は必ず次のツアーの `_title`・`_desc` の2キーで区切られる。自分のツアーの `_desc` の直後に手順のキーを足す（区画が離れているので、並列の変更が git のマージで衝突しない）。テストがこの並び（連続・title 始まり・区画の非重複）を検査する
- `TourDefinition` の項目:
  - `page`: `'sidepanel'`（サイドパネル）か `'fulltext'`（全文の判定ページ `src/fulltext/`）。`'fulltext'` のツアーの対象はサイドパネルの HTML ではなく `fulltext.html` で照合される。サイドパネルのランナーは `'fulltext'` のツアーを始めも再開もしない（全文の判定ページ側のランナーが扱う）。ツアー一覧には出すが、開始ボタンの代わりに「全文タブで文献を開くと始められます」（`guideExt_tourOpenFulltextHint`）を出す
  - `draft`: 真なら中身の無い枠。`GUIDE_TOURS` には入るが、`availableTours()` が除外するので、一覧・提案・開始・テストの照合の対象外（見出し・説明のキーの実在だけは検査する）
  - `unavailableIf`: 条件名。真のとき、今の状態ではこのツアーを使えないので、ツアー一覧・「?」の吹き出し・タブとページの提案・開始から外す（実行中のツアーの再開は止めない）。`availableTours`・`tourToSuggestOnEvent`・`tourToSuggestOnPage` は、条件の値を末尾の任意の引数で渡されたときだけ見る（渡さなければ従来どおり。初回のバナー `shouldSuggest` は渡さない）
  - `suggestOn`: （足す・変えるときは、初期バンドル `features/guide/lazy.ts` の `SUGGEST_TOUR_BY_EVENT` の対応表も合わせる。テストが照合する。対応表に無いイベントでは本体チャンクを読まない）このイベント（今のところ `tab-opened-screening`・`tab-opened-ml`・`tab-opened-llm`・`tab-opened-fulltext`）が起きたとき、そのツアーをまだ `done`・`dismissed` にしておらず、ほかのツアーが実行中でなく、全体の「今後表示しない」でもなければ、そのタブの section の上部に提案の帯（`#guide-tab-suggest`、`data-guide-tour="<ID>"`）を出す。「ツアーで進める」（`data-guide-action="start"`）と「表示しない」（`data-guide-action="dismiss"`。そのツアーを `dismissed` に記録）の2つ。帯は1つだけで、別のタブへ移ると消える。判定は純関数 `tourToSuggestOnEvent`（`tour-progress.ts`）。サイドパネルのツアーにだけ付ける
  - `TourStep.advance` の `{ type: 'events'; events: [...]; optional?: true }`: `optional` の手順は、イベントが起きれば進むのに加えて、カードに「押さずに次へ」（`guide_tourSkip`、属性は `data-guide-action="next"` のまま）も出す。AI の一括実行・共有の追加・担当セットの作成など、慎重に扱う操作を、押させずに説明だけ済ませて先へ進める手順に使う。最後の手順は `{ type: 'next' }` にする
- タブを開いたイベント（`tab-opened-*`）は、`src/sidepanel/bootstrap.ts` のストア購読が、スクリーニング画面でタブが切り替わるたびに `emitGuideEvent` で1回投げる。初期バンドル側の `lazy.ts` は、全体の「今後表示しない」でなければ、このイベントでも本体チャンクを読む（初期 JS の予算が小さいので、初期側に足す量は数百バイトに収める）。全文の判定ページのイベントは `src/fulltext/guide.ts` の `emitGuideEvent` で投げる
- UI を変えるときの注意: `data-tour` / `data-help` の付いた要素を消す・id を変えると照合テストが落ちる。落ちたらテストを緩めず、ツアーの定義か属性のほうを直す（テストを緩めると、利用者の画面でツアーが黙って止まる）
- ツアーの一覧は画面上部の専用ボタンではなく、`topics.ts` で `tourList: true` を付けたトピック（プロジェクト選択画面右上の ❓ = `overview`、スクリーニング画面ツールバーの ❓ = `screening-toolbar`、全文タブ上部の「?」= `fulltext-views`、AI タブのモデルカード見出しの「?」= `ai-model`、ML タブ上部の「?」= `ml`）の吹き出しにある「操作ツアーの一覧」ボタン（`data-guide-action="tour-list"`）から開く。この5つの「?」には `data-tour="tour-list"` も付いており、最後の手順 `finish` が指す対象になる（各タブの上部の「?」に付いているので、どのタブで終わるツアーでも指す先がある。ランナーは同じ値の要素のうち表示中のものを選ぶ）（テストが「`data-tour="tour-list"` は `data-help` も持つ」ことを検査する）。一覧は使えるツアー（`draft` を除く）を全部出し、パネルは縦にスクロールできる（`max-height` で画面内に収める）
- カードの手順番号「n / m」は、今の条件で `skipIf` により飛ばされない手順だけで数える（`visibleStepPosition`、`tour-progress.ts`。手順を描画するたびに数え直す。保存値の `stepId`・`stepIndex` は全手順の添字のまま）
- 手順に入ったときのスクロールは `TourStep.scroll` で指定する。`'start'`（文献カードの先頭＝タイトルを見せる。`read`）、`'if-hidden'`（対象が画面内に全部見えているならスクロールしない。`decide` で、直前まで読んでいた抄録を画面に残す）。省略時は対象が高ければ上端、そうでなければ中央へ寄せる
- ダイアログ（`#modal-backdrop`）の中の要素を対象にしてよい。そのとき枠・覆い・カードはダイアログより前面に出る（`guide-tour-*--over-modal`）。カードは本文が全部読める通常表示を保ち、対象の下→上→画面の上端・下端の順に、対象とフッターのボタンに重ならない場所へ置く（見出しや別の入力欄には重なってよい。対象の半分以上を覆うしかないときだけ小さい表示に落ちる。`guide-ui/placement.ts` の `computeInDialogCardPosition`）
- 取り消せない操作・プロジェクト全体に効く操作（Blind の切り替え、再シャッフルなど）をツアーの手順にするときは、`blockTarget: true` で押せないようにし、進む条件は「次へ」（`advance: { type: 'next' }`）にする。実際に押させると、練習のつもりが本番のデータを変えてしまうため
- デモビルドでの再現: 新規作成は `POST /v4/spreadsheets` のモックがデモのシートストアを空に初期化する（`src/demo/fetch-mock.ts`）。共有シートの初回許可（Picker）は URL に `?demoPickerRequired=1` を付けると再現できる（`src/demo/fetch-mock.ts` と `src/platform/demo/index.ts`）
- 実行中のツアーは手順の ID（`active.stepId`）で保存しているので、手順を足す・並べ替えても再開位置はずれない。手順の ID を改名・削除すると、その手順で止まっていた人のツアーは再開されない（`active` は捨てる。済み・却下の記録は残る）。`stepId` の無い旧版の保存値だけは添字で読む
- 保存: 進行状態は `platform().storageGet/storageSet` のキー `guide_progress`（`GUIDE_PROGRESS_STORAGE_KEY`）。壊れた値は既定値に戻して読み、保存形式の検証は `tour-progress.ts` に置く。「あとで」はそのセッションの中だけで保存しない（次回また提案するため）。「今後表示しない」と、ツアーごとの完了・中止は保存する
- アプリのダイアログ（`#modal-backdrop`）が開いていて、今の手順の対象がその中に無い間は、カードは「ダイアログ待ち」の表示（`data-guide-waiting-reason="modal"`、枠・覆い・「次へ」なし、ダイアログの前面）になり、閉じると元の表示に戻る（ウィザード専用ではなく、ランナーの一般規則）
- 照合: `tests/guide-tours.test.ts`（定義と画面・文言の照合: 対象の `data-tour` の実在・動的対象の付与コードの実在・文言キーの実在と並び・Web 版で隠れる要素への非依存・`tourId` の実在・イベント送出元の実在・draft の扱い）、`tests/guide-tours-definition.test.ts`（定義そのもの）、`tests/guide-tour-progress.test.ts`（進行状態の純関数。提案の判定を含む）。`emitGuideEvent` は `src/sidepanel/features/guide/lazy.ts`。デモビルドでの通し検証は `scripts/guide-tour-check/run.mjs`（`npm run check:tours`。`--only <シナリオ名>` で1本、`--lang`・`--size` も使える。共通の道具は `lib/`、シナリオは `scenarios/<ID>.mjs`）
