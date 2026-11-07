# ヘルプ相談の土台

画面やブラウザ API に依存しない、一問一答の相談用部品です。
画面からの呼び出しや文言の表示は、この部品を利用する側で組み立てます。

- `load.ts` は動的 import で読み込んでから `loadHelpSections('ja' | 'en')` を呼びます。
  データは `docs/help.html` からビルド時に生成され、言語別のチャンクになります。
- `searchHelpSections(sections, question, limit)` はキー不要で動作し、小節を関連度順に返します。
- `chooseConsultProvider(configuredProviders, currentModelId)` は設定済みの社の集合を受け取ります。
  現在のモデルの社を優先し、使えなければ Gemini、OpenAI、Anthropic、OpenRouter の順で選びます。
  モデルは `CONSULT_MODELS` に固定し、TypeSafe とローカル LLM は相談には使いません。
- `consultHelp({ question, lang, sections, providerId, signal })` は選択と回答を一回ずつ呼びます。
  本文を送るのは二回目だけで、最大三小節に限定します。履歴の保存と自動再試行は行いません。
  `status` は `success`、`no_match`、`failure` です。失敗時には `kind` で原因を区別します。
- `createIssueDraft({ question, answer?, environment })` は公開前の確認文と環境情報を含む下書きを返します。
  戻り値の `body` をコピーでき、`url` はエンコード後も8,000文字以内です。
  メール、外部 URL、長いキー断片を伏せますが、公開前には利用者による内容の確認が必要です。

自由問い合わせは `llm-provider.ts` の `askWithProvider(providerId, params)` を使います。
`jsonSchema` を渡すとパース済みの値、渡さないと文字列を返します。
外部の `signal` による中止と `timeoutMs` によるタイムアウトは区別されます。

抽出・検索・送信形式・失敗分類は `tests/help-sections.test.ts`、`tests/help-consult-*.test.ts`、
`tests/ask-with-provider.test.ts` で検証します。テストは外部 API に接続しません。
HTML の実体参照は表示文字に戻すため、本文中の `&lt;name&gt;` は `<name>` として残ります。
