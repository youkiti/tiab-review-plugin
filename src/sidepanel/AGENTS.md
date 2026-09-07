# src/sidepanel/ の仕様

このファイルは ../../AGENTS.md（リポジトリ根）から Issue #195 で切り出した詳細仕様です。
リポジトリ全体の規約・CRITICAL PROTOCOLS は [根の AGENTS.md](../../AGENTS.md) を参照してください。

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
7. **LLMスクリーニング支援**

   - **APIキー設定**: Gemini / OpenRouter APIキーの保存・管理 (provider 別に独立保管)
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
   - **モデル選択**: Gemini 2 種 + OpenRouter 2 種 (Qwen3 235B Instruct, DeepSeek V4 Flash) から選択
   - **OpenRouter カスタムモデル**: ユーザーが任意のモデル ID（例: `anthropic/claude-3.7-sonnet`）を手入力 → 実 API テスト成功時のみ `chrome.storage.local` (`openrouter_custom_models`) に永続化し、モデル選択肢に追加。最大 20 件。ベンチマーク未検証であることをUIで明示する。
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
   - **PRISMA の腕別集計（Issue #120）**: Registry linkage 由来の取り込み行（`related_ref_id` 非空）は PRISMA 2020 の「Identification of studies via other methods」腕として database 腕から分離集計する。判定と分割は `src/lib/identification-route.ts`（純関数）の `identificationRouteOf()` / `splitByIdentificationRoute()`。**判定条件は `related_ref_id` 非空のみにそろえること。** `src/lib/fulltext-candidates.ts` の `isProjectFulltextCandidateRef()` が候補プールへ無条件投入する条件と一致させないと、腕別集計の合計が候補総数と合わなくなる。`source` の `Registry linkage` 接頭辞は使わない。`getFulltextResultsSummary()` は**database 腕だけ**を返す。両腕が要るときは `getFulltextResultsSummaryByRoute()` を使う。other methods 腕の PRISMA 行組み立ては `buildOtherMethodsPrismaLines()`。該当0件なら**空配列**を返す（0件時に現行出力と1文字も変わらないことをこの性質で担保している）。全文結果CSVには `identification_route` 列（`database` / `registry_linkage`）が**ヘッダ配列の一番最後**に入る（既存の固定列・判定者列のインデックスをずらさないため）
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

