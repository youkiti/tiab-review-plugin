## 結論（一言で）

**2026-08-15現在、通常の Google AI Studio API キーだけから、Free / Tier 1 / Tier 2 / Tier 3 を確実・無課金・初回リクエストで判定する公開 API はありません。**

判定できるのは次のいずれかです。

- Google AI Studio にログインして Projects / Rate Limit 画面を見る。
- OAuth またはサービスアカウントで Cloud Billing / Cloud Quotas / Service Usage API を読む。
- 実際に 429 を発生させ、`QuotaFailure.quotaId` の `FreeTier` を観測する。ただしこれは**診断信号であって、信頼できる tier API ではありません**。
- paid-only モデルを呼ぶ方法は Free/Paid の推測には使えますが、Paid 側では課金され、エラー原因も一意でなく、Tier 1/2/3 は区別できません。

`GET /v1beta/models` が Free key でも多数のモデルを返すという既知事項は、公式 `Model` schemaにも tier / price / entitlement フィールドがないため、その理解で正しいです。[Models API](https://ai.google.dev/api/models)（最終確認 2026-08-15）

---

## 各手段の評価表

| 手段 | 判定可能か | APIキーだけで可能か | 評価・一次ソース | 日付 |
|---|---:|---:|---|---|
| `models.list` / `models.get` | いいえ | はい | 返るのはモデル名、token limits、supported methods等。tier/billing/quotaフィールドなし。[Models API](https://ai.google.dev/api/models) | 調査日 2026-08-15 |
| Gemini REST の全公開メソッド | いいえ | はい | `models`, `cachedContents`, `batches`, `files/media`, `tunedModels` 等はあるが、billing/tier/quota/remaining-usage resource はない。[All methods](https://ai.google.dev/api/all-methods) | 更新 2026-07-21 |
| `usageMetadata` | いいえ | はい | 個別応答の token usage であり、契約 tier・残 quota ではない。 | 調査日 2026-08-15 |
| Google AI Studio Projects / Rate Limit | はい | **APIキーだけでは不可** | 公式が tier と active limits の確認先として案内。UIログインとプロジェクト権限が必要。[Billing](https://ai.google.dev/gemini-api/docs/billing)、[Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) | Rate limits更新 2026-07-21 |
| Cloud Billing `projects.getBillingInfo` | Billing有無は判定可能。ただしTier 1/2/3そのものではない | **不可** | OAuth scopeと `resourcemanager.projects.get` が必須。[getBillingInfo](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo) | 更新 2025-09-04 |
| Cloud Quotas `quotaInfos.list/get` | 有効quota値は取得可能 | **不可** | `cloud-platform` OAuth scope + `cloudquotas.quotas.get` IAM permission必須。[quotaInfos.list](https://docs.cloud.google.com/docs/quotas/reference/rest/v1/projects.locations.services.quotaInfos/list) | 更新 2025-05-14 |
| Service Usage `consumerQuotaMetrics.list` | quota limit / overridesは取得可能 | **不可** | OAuth scope + `serviceusage.quotas.get` 必須。[consumerQuotaMetrics.list](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1beta1/services.consumerQuotaMetrics/list) | 更新 2025-11-11 |
| 200応答のrate-limit header | いいえ | はい | Free/Paid両方で `x-ratelimit-*` がないとの実測。Google forum staffも「提供していない」と回答。[Google forum](https://discuss.ai.google.dev/t/where-how-do-i-find-remaining-tokens-requests-count-after-making-a-request/41117)、[Hermes issue](https://github.com/NousResearch/hermes-agent/issues/21399) | 2024-10-01 / 2026-05-07 |
| 429 `quotaId` の `FreeTier` | 条件付きでFree bucketを識別 | はい | 429発生時のみ。Paid projectが誤ってFree bucketへroutingされた報告あり。Tier 1/2/3は区別不能。 | 後述 |
| paid-only model / feature probe | Free/Paidの推測のみ | はい | Freeはしばしば quota=0 の429または403。Paidでは成功時に課金。地域・allowlist・account flag等でも失敗する。 | 後述 |
| `countTokens` / GetTokens | **根拠なし** | はい | 無課金かつinference quotaにも数えないことは公式記載あり。ただしpaid-only entitlementを確実に検査するとの資料・実装は見つからない。[Billing FAQ](https://ai.google.dev/gemini-api/docs/billing) | 調査日 2026-08-15 |

### APIキーとOAuthの違い

Google API共通の `?key=` / `X-Goog-Api-Key` は、API利用プロジェクトの識別に使える場合があります。しかし IAM で保護されたプロジェクト固有情報を読むための**認証主体**にはなりません。

上記3 APIはいずれもメソッド仕様に OAuth scope と IAM permission を明記しています。したがって、ユーザーが貼り付けた Gemini API key しか持たないブラウザ拡張からは利用できません。

加えて、APIキーから project ID / project number を返す公開 Gemini endpoint も確認できませんでした。

---

## 公式 Gemini API に tier endpoint はあるか

公開 REST reference のリソースは、2026-07-21時点で概ね以下です。

`auth_tokens`, `batches`, `cachedContents`, `corpora`, `fileSearchStores`, `files`, `generatedFiles`, `media`, `models`, `tunedModels` と関連 operations/permissionsです。[全メソッド一覧](https://ai.google.dev/api/all-methods)

ここには次のいずれもありません。

- `projects.getTier`
- `billingInfo`
- `quota`
- `usageLimits`
- `remainingQuota`
- `rateLimitStatus`
- API key → project/billing mapping

公式文書は一貫して「active rate limits と tier は AI Studio で見る」と案内しています。AI Studio側も tier表示、usage dashboard、rate-limit dashboardに IAM permissionを要求します。[AI Studio troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshoot-ai-studio)（調査日 2026-08-15）

---

## 429 quotaId 方式についての評判・既知の落とし穴

### 確認できたロジック

実装するなら概念上は次です。

```text
HTTP 429
  → error.details[] から google.rpc.QuotaFailure を探す
  → violations[].quotaId または quotaMetric を調べる
  → quotaId が "-FreeTier" で終わる、
     または quotaMetric が "*_free_tier_*"
  → 「この失敗は FreeTier quota bucket で評価された」
```

実際の例：

```text
quotaId:
GenerateRequestsPerMinutePerProjectPerModel-FreeTier

quotaMetric:
generativelanguage.googleapis.com/generate_content_free_tier_requests
```

OSS/blogでは、これをtier検出よりも「minute limitなら待つ、day limitなら別モデルへ切替える」というエラー処理に利用しています。例えば次のロジックです。

```text
if message includes "GenerateRequestsPerDayPerProjectPerModel-FreeTier":
    switch to next model

if message includes "GenerateRequestsPerMinutePerProjectPerModel-FreeTier":
    sleep and retry
```

出典：[Failing Over Between Gemini Models](https://jasonstcyr.com/2025/04/15/failing-over-between-gemini-models/)（2025-04-15）

### 落とし穴

1. **429を起こすまで情報が出ない**

   正常な200応答には tier や remaining quota header がありません。意図的に RPM/RPD/TPM を使い切る必要があり、破壊的で遅く、サービス利用にも影響します。

2. **`FreeTier` は「契約状態」ではなく、失敗時に評価された quota bucket**

   Paid Tier 2 projectが `FreeTier` quotaIdで拒否された報告があります。[Paid Tier 2 routed to free-tier bucket](https://discuss.ai.google.dev/t/paid-tier-2-project-still-routed-to-free-tier-quota-bucket-429-resource-exhausted-limit-0-on-gemini-api/140414)（2026年4月）

   Tier 3でも同様の報告があります。[Tier 3 but FreeTier 429](https://support.google.com/gemini/thread/437924388/i-have-a-tier-3-gemini-account-but-getting-free-tier-429-exceptions?hl=en)（2026-05-31）

3. **billing反映遅延・誤routingがある**

   公式は tier upgrade が通常10分以内、billing processingにも遅延があり得ると記載しています。[Billing](https://ai.google.dev/gemini-api/docs/billing)（調査日 2026-08-15）

4. **`limit: 0` はFree tierの一般的な残量0と同義ではない**

   paid-only model、利用地域、account flag、モデル停止、billing未反映などで、そのモデルのFree quotaが0になっている可能性があります。

5. **429 bodyが常に完全とは限らない**

   GitHubには `QuotaFailure` がない簡略化された429も報告されています。[python-genai #1446](https://github.com/googleapis/python-genai/issues/1446)（2025-09-30）。したがって「429なのに `FreeTier` がない＝Paid」とは言えません。

6. **project単位**

   公式に quota は API key単位ではなく project単位です。同じprojectの別keyで消費されたquotaも影響します。

したがって返せる分類はせいぜい次です。

```text
FreeTier quotaIdを観測 → probably_free_bucket
それ以外             → unknown
```

`paid` と断定してはいけません。

---

## GitHub・OSSでの先行例

指定された `google-gemini/cookbook`, deprecated SDK群、`googleapis/python-genai`, `googleapis/js-genai` を検索しましたが、**Google staffが「API keyだけでtierを取得できる」と回答したissueは見つかりませんでした**。

むしろ `python-genai` の429 issueではGoogle側担当者がユーザーに次のように質問しています。

> “Could you also let us know if you are on free tier or paid tier.”

出典：[googleapis/python-genai #1446](https://github.com/googleapis/python-genai/issues/1446)（2025-09-30）

SDKがkeyからtierを自己判定しているなら不要な質問なので、少なくとも同SDKには信頼できるtier introspectionがないことを補強します。ただし、これは間接証拠です。

最も直接的なOSS先行例は Hermes Agent です。同ツールは当初：

```python
if 200 <= resp.status_code < 300:
    return "paid"
```

としていましたが、既知のFree keyとPaid keyを同じendpointで試すと、両方とも：

```text
status=200
rate_limit_headers=(none)
```

だったため誤判定と報告されました。提案修正は：

```python
if 200 <= resp.status_code < 300:
    return "unknown"
```

です。[NousResearch/hermes-agent #21399](https://github.com/NousResearch/hermes-agent/issues/21399)（2026-05-07）

LiteLLM、LangChain、aider、Cline、Roo Codeについて、provider認証、モデルcatalog、429 retry/fallbackは確認できましたが、Gemini API keyのFree/Tier 1/2/3を確実に自動検出する実装は見つかりませんでした。通常はユーザーにbackend/keyを指定させるか、設定されたRPMを使います。**「全OSSがそうしている」とまでは証明できないため、検索範囲内では根拠なし**とするのが適切です。

---

## paid-onlyモデル／機能をプローブにできるか

| 候補 | Free key | Paid key | Paid側の費用 | tier probeとして |
|---|---|---|---:|---|
| Imagen 4 | 公式価格表ではFree unavailable。ユーザー報告では初回から429/quota=0が多い | 成功すれば画像生成 | $0.02–$0.06/画像 | Free/Paid推測のみ。2026-08-17停止予定で不安定 |
| Veo 3.1 | 公式にPaid tier only | 成功すれば動画生成 | $0.05–$0.60/秒。生成成功時のみ課金 | 高額・非同期。probeには不適 |
| Gemini Pro / advanced variants | モデルごとにFree unavailableの場合あり | 推論成功 | token課金 | availabilityが頻繁に変わり、Tier 1/2/3は区別不能 |
| `cachedContents.create` | モデル・世代依存。Free unavailableの価格行が多い | cache生成・保存 | cached tokens + storage | 成功自体が課金対象。普遍的でない |
| Batch API | 多くの価格行でFree unavailable | job受付・処理 | 通常価格の約50% | jobが開始され得るためprobeに不適 |
| File/media upload/list | Free/Paid双方で利用可能 | 同左 | upload自体はtier信号でない | 不可 |
| tunedModels | 現在Gemini Developer APIで対応モデルなし | 同じ | — | tierと無関係 |
| Google Search grounding | Flash系ではFree枠のあるモデルが存在 | Paid枠・超過課金あり | モデル・検索数依存 | paid-onlyではない |
| `gemini-embedding-*` | 明示的にFree/Paid双方 | 同左 | Paidではtoken課金 | 不可 |

公式価格：[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)（調査日 2026-08-15）  
Veoは「paid tierのみ」、かつ「動画が正常生成された場合のみ課金」と明記されています。  
Tuning：[Fine-tuning](https://ai.google.dev/gemini-api/docs/model-tuning)（更新 2026-04-28）

重要なのは、**「Freeなら確実に失敗し、Paidなら費用もquotaも消費せず確実に成功する」候補は見つからなかった**ことです。

`countTokens` は無課金ですが、paid-only modelのentitlementを本推論と同じように検査するという根拠がありません。現時点では実験候補にすぎず、確立した手段ではありません。

---

## quota関連HTTP header

### 文書化・Google staff回答

Google AI Developers ForumでGoogle側回答：

> “Currently, Gemini does not provide response headers for rate limit information.”

[Forum thread](https://discuss.ai.google.dev/t/where-how-do-i-find-remaining-tokens-requests-count-after-making-a-request/41117)（2024-10-01）

### 実測報告

Hermes issueではFree/Paid双方について：

```text
status=200
rate_limit_headers=(none)
```

[Hermes #21399](https://github.com/NousResearch/hermes-agent/issues/21399)（2026-05-07）

観測され得る一般的なヘッダーは `content-type`, `date`, Google frontend/request tracing等ですが、Free/Tier 1/2/3を示す安定した `x-ratelimit-*` / `x-goog-quota-*` は確認できません。

Web上には `x-goog-quota-remaining-rpm` や `x-goog-quota-priority` が返ると主張する記事がありますが、公式回答と公開実測に反し、再現可能な一次証拠がありません。**根拠なし**です。

なお `x-gemini-service-tier: flex|priority` の報告はありますが、これはリクエストのinference service classであり、billing usage tier（Free/Tier 1/2/3）ではありません。

---

## 2026年のRPM / TPM / RPD

### 公式に確定できること

- RPM、input TPM、RPDという3軸は存在する。
- RPDはfree tierにも存在する。
- project単位で適用される。
- RPDはPacific timeの午前0時にreset。
- experimental/previewは厳しいことがある。
- active limitsはAI Studioで確認する。
- 「Specified rate limits are not guaranteed and actual capacity may vary」。
- 2026-07-21版の公開ページは、通常推論のモデル別RPM/TPM/RPD表を公開せず、AI Studioへ誘導している。

[公式 Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)（更新 2026-07-21）

### Free/Tier 1/2/3の現在値

**公開された普遍的なモデル別数値としては確認不能です。** アカウント・projectごとのAI Studio表示が一次情報です。

2026-05-07のGoogle forum staff回答も：

> “You can find your tier’s specific model rate limits by going to Google AI Studio…”

[Forum](https://discuss.ai.google.dev/t/regarding-gemini-models-rate-limit-in-paid-tier/143557)（2026-05-07）

ユーザー実測には例えば Gemini 2.5 Flash Tier 1で `1K RPM / 1M TPM / 10K RPD`、Freeで `20 RPD`、過去には `15 RPM / 1,500 RPD` 等がありますが、時期・projectで食い違います。したがって2026-08-15の保証値として転載するのは不適切です。

公式に固定して確認できるtier条件・金額制限は次です。

| Tier | 条件 | 月間billing cap | 10分spend-rate limit |
|---|---|---:|---:|
| Free | active project / free trial | N/A | N/A |
| Tier 1 | active billing accountをlink | $250 | $10 |
| Tier 2 | 累計$100支払 + 初回成功支払から3日 | $2,000 | $200 |
| Tier 3 | 累計$1,000支払 + 初回成功支払から30日 | $20,000–$100,000+ | $200 |

これはRPM/TPM/RPDではなく、billing/spend capsです。[Billing](https://ai.google.dev/gemini-api/docs/billing)、[Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)（2026-07-21版）

---

## 追試不要と言えるもの／実測しないと分からないもの

### 追試不要と言えるもの

- Gemini REST referenceにtier/billing/quota-status取得endpointはない。
- `models.list/get` schemaにtier情報はない。
- Cloud Billing、Cloud Quotas、Service Usageのproject固有情報はOAuth + IAM必須。
- 通常のAI Studio API keyだけではこれらCloud APIを代用認証できない。
- 成功応答に文書化されたremaining-quota/tier headerはない。
- Imagen/Veoは公式価格上paid-onlyだが、成功すれば課金される。
- embeddingはFree/Paid双方で使える。
- tuningは現在Gemini Developer APIでは利用不能。
- RPDは存在し、project単位、Pacific midnight reset。

### 実測しないと分からないもの

- ある時点・あるproject・あるモデルの正確なRPM/TPM/RPD。
- paid-onlyモデルにFree keyを送った際の厳密なHTTP code/body。
- `countTokens` がpaid-only entitlement判定に使えるか。
- billing upgrade直後にFree/Paid routingが反映済みか。
- 429の `FreeTier` が真の契約状態か、誤routingか。
- 地域、account flag、Prepay残高、allowlistによる失敗との区別。

---

## 実装判断

ブラウザ拡張で安全に扱うなら、状態は二値ではなく次の三値が妥当です。

```text
free_observed
  429 QuotaFailureにFreeTierを観測した
  ※「Free契約確定」ではなく「Free bucket観測」

paid_user_declared
  ユーザーがAI Studio表示を確認してPaidと申告した

unknown
  正常応答、429詳細なし、その他すべて
```

Tier 1/2/3の自動判定は行わず、AI Studio Projects / Rate Limitへのリンクを表示するのが、現在得られる証拠に最も整合します。

---

## 参考URL一覧

- [Gemini API All methods](https://ai.google.dev/api/all-methods) — 更新 2026-07-21
- [Models API](https://ai.google.dev/api/models) — 調査日 2026-08-15
- [Gemini API Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) — 更新 2026-07-21
- [Gemini API Billing](https://ai.google.dev/gemini-api/docs/billing) — 調査日 2026-08-15
- [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing) — 調査日 2026-08-15
- [Cloud Billing projects.getBillingInfo](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo) — 更新 2025-09-04
- [Cloud Quotas quotaInfos.list](https://docs.cloud.google.com/docs/quotas/reference/rest/v1/projects.locations.services.quotaInfos/list) — 更新 2025-05-14
- [Service Usage consumerQuotaMetrics.list](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1beta1/services.consumerQuotaMetrics/list) — 更新 2025-11-11
- [AI Studio IAM requirements](https://ai.google.dev/gemini-api/docs/troubleshoot-ai-studio) — 調査日 2026-08-15
- [Hermes: unreliable Gemini tier probe](https://github.com/NousResearch/hermes-agent/issues/21399) — 2026-05-07
- [python-genai #1446](https://github.com/googleapis/python-genai/issues/1446) — 2025-09-30
- [Paid Tier 2 routed to FreeTier quota](https://discuss.ai.google.dev/t/paid-tier-2-project-still-routed-to-free-tier-quota-bucket-429-resource-exhausted-limit-0-on-gemini-api/140414) — 2026年4月
- [Tier 1 still using FreeTier quotas](https://discuss.ai.google.dev/t/tier-1-billing-enabled-but-api-still-uses-free-tier-quotas-429-error/114343) — 2026-01
- [No rate-limit response headers](https://discuss.ai.google.dev/t/where-how-do-i-find-remaining-tokens-requests-count-after-making-a-request/41117) — 2024-10-01
- [Paid-tier rate-limit numbers are in AI Studio](https://discuss.ai.google.dev/t/regarding-gemini-models-rate-limit-in-paid-tier/143557) — 2026-05-07
- [Embedding free-tier limits staff report](https://discuss.ai.google.dev/t/gemini-embedding-free-tier-documentation/112553) — 2025-12-19
- [Batch embedding unavailable on Free tier](https://discuss.ai.google.dev/t/constant-429-resource-exhausted-error-after-switching-to-the-more-recent-text-embedding-model-gemini-embedding-001-on-free-tier/107614/3) — 2025-10-17
- [429 quotaId handling example](https://jasonstcyr.com/2025/04/15/failing-over-between-gemini-models/) — 2025-04-15