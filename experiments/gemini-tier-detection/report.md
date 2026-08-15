# Gemini APIキーの無料/有料判定 — 実験結果

- 対象 issue: [#88](https://github.com/youkiti/tiab-review-plugin/issues/88)
- 実施日: 2026-08-15
- 実験コード: [probe.mjs](probe.mjs) / [probe2-validate.mjs](probe2-validate.mjs) / [probe3-detector.mjs](probe3-detector.mjs)
- 生データ: [results/](results/)（APIキーは `redact()` 済み）
- 先行調査（codex, web検索）: [prior-art-raw.md](prior-art-raw.md)

## 結論

**無料/有料は、1リクエスト・課金ゼロ・約0.1〜0.5秒で判定できる。** ただし **Tier 1/2/3 の区別は不可能**なので、有料内の Tier は手動選択のままにする。

判定器（拡張機能にそのまま移植できる形）:

```
POST /v1beta/models/{model}:batchGenerateContent
Header: x-goog-api-key: <APIキー>
Body:   {"batch": {"display_name": "tier-probe"}}   ← requests を意図的に空にする

400 FAILED_PRECONDITION                       → free
400 INVALID_ARGUMENT "...inlined requests"    → paid
400 INVALID_ARGUMENT "API key not valid"      → invalid_key
それ以外・通信失敗                              → unknown（既定=free に落とす）
```

**なぜ requests を空にするのか**: 無料キーでは**課金チェックが body 検証より先に走る**ため、空 body でも `FAILED_PRECONDITION` が返る。一方、有料キーは body 検証まで進んで `INVALID_ARGUMENT` で止まる。つまり**どちらのキーでもバッチジョブは1件も作られない** — 課金ゼロ、後片付け不要、副作用なし。（有効な batch を送る版でも判定はできるが、有料側でジョブが実際に作られてしまい cancel/delete が必要になる。実測では cancel/delete とも 200 で成功したが、空 body 版のほうが安全。）

## 測定結果

### 判定器の再現性（[probe3-detector.mjs](probe3-detector.mjs)）

| キー | 5回の結果 | 期待 | 判定 | 応答時間（中央値） |
|---|---|---|---|---|
| free | free ×5 | free | ✓ | 104 ms |
| paid (Tier 3) | paid ×5 | paid | ✓ | 518 ms |

モデル非依存の確認: `gemini-2.5-flash` / `gemini-3.1-flash-lite` / `gemini-2.5-flash-lite` すべてで free→free, paid→paid（✓）

異常系:

| 入力 | 結果 | 備考 |
|---|---|---|
| 不正なAPIキー | `invalid_key` | `INVALID_ARGUMENT` + "API key not valid" |
| 空文字キー | `unknown` | `PERMISSION_DENIED`。free/paid と誤断定しない |

### 合格基準への当否

| 基準 | 目標 | 実測 | 判定 |
|---|---|---|---|
| 正確性 | 6/6 一致 | 16/16 一致（5回×2キー + 3モデル×2キー） | ✓ |
| コスト | 1円未満 | **0円**（ジョブが作られない） | ✓ |
| 速度 | 10秒以内 | 104 ms / 518 ms | ✓ |
| 副作用 | 枠消費 1/3 以下 | **なし**（generateContent を呼ばない） | ✓ |
| 権限 | APIキーのみ | APIキーのみ | ✓ |
| 一過性障害に強い | free と誤判定しない | 通信失敗・想定外はすべて `unknown` | ✓ |

### 否定された仮説（今後やり直さないこと）

| プローブ | 結果 | 結論 |
|---|---|---|
| P1 `models.list` の**集合**差分 | free 54件 / paid 54件、**集合が完全一致**。`supportedGenerationMethods` の差も 0 件（`batchGenerateContent` は両方 27 件で申告） | 件数だけでなく**集合でも判定不可**。issue #88 の F1 を強い形で確定 |
| P2 レスポンスヘッダ | tier を示すヘッダなし（先行調査でも Google 公式が「提供していない」と回答） | 判定不可 |
| P3 `batches` / `cachedContents` / `files` の **list** | 両キーとも HTTP 200 | list は課金チェックを通らない。判定不可 |
| P3 `tunedModels` list | 両キーとも 501 UNIMPLEMENTED | tuning は現在提供されていない。tier と無関係 |
| P5 `cachedContents.create` | 両キーとも `INVALID_ARGUMENT: Cached content is too small. min_total_token_count=1024` | **同一エラー**。最小トークン下限に阻まれ判定に使えない |
| 存在しないモデル名 | 両キーとも 404 NOT_FOUND | モデル存在チェックは課金チェックより先。誤判定源にならない |

## 先行調査（codex）から得た重要な知見

全文は [prior-art-raw.md](prior-art-raw.md)。設計に効くものだけ:

1. **APIキーだけで tier を返す公式エンドポイントは存在しない。** Cloud Billing / Cloud Quotas / Service Usage はいずれも OAuth + IAM 必須で、ユーザーが貼り付けた APIキーしか持たない拡張機能からは使えない。→ 今回の判定器は「entitlement の副作用を観測する」方式であり、公式APIではない。**Google が Batch API を無料枠に開放したら壊れる**（しかも「全キーを paid と誤判定する」危険な方向に壊れる）。実行時の安全網（下記4）は必ず併設する。

2. **`quotaId` の `FreeTier` は「無料契約の証拠」ではない。** 有料 Tier 2 / Tier 3 のプロジェクトが FreeTier バケットにルーティングされて 429 になる報告が複数ある（[Tier 2 の報告](https://discuss.ai.google.dev/t/paid-tier-2-project-still-routed-to-free-tier-quota-bucket-429-resource-exhausted-limit-0-on-gemini-api/140414) / [Tier 3 の報告](https://support.google.com/gemini/thread/437924388/i-have-a-tier-3-gemini-account-but-getting-free-tier-429-exceptions?hl=en)）。
   → **issue #88 の案A「429 で FreeTier を検出したら自動的に無料へ固定」はそのまま実装してはいけない。** 有料ユーザーを無料に固定してしまう。減速の根拠にはしてよいが、**tier のロックには使わない**。

3. **429 に `QuotaFailure` が付かないことがある**（[python-genai #1446](https://github.com/googleapis/python-genai/issues/1446)）。「429 なのに FreeTier が無い＝有料」も成り立たない。

4. **quota は APIキー単位ではなくプロジェクト単位。** 同じプロジェクトの別キーの消費も効く。

5. 無料枠にも RPD が存在し、太平洋時間の午前0時にリセット。モデル別の具体値は公開されておらず、AI Studio の画面が一次情報。

## 限界（この実験で確認できていないこと）

- **Tier 1 / Tier 2 の有料キーで未検証。** 手元の有料キーは Tier 3 のみ。判定の分かれ目は「課金が有効か」なので Tier 1/2 でも `paid` になるはずだが、実測はしていない。
- **地域差を未検証。** Batch API が使えない地域の有料キーは `free` と誤判定される可能性がある。ただし誤る方向は「遅くなるだけ」で安全側。
- 時間帯を変えた再測定（合格基準の「2時間帯」）は未実施。entitlement チェックは負荷依存ではないため優先度は低いが、実装前に1回追試する価値はある。
- 無料枠の RPM/RPD の実値は未測定（[plan.md](plan.md) の RQ4/RQ5 として残置）。

## 推奨する実装

1. `testApiKeyWithTier()` のモデル数分岐を**削除**し、上記の batch プローブに置き換える。戻り値は `'free' | 'paid' | 'invalid_key' | 'unknown'` の4値。
2. `unknown` は **`free` として扱う**（安全側）。
3. Tier 1/2/3 は自動判定せず、**`paid` 検出時にユーザーへ選ばせる**。AI Studio の Rate limit 画面へのリンクを添える。
4. `#tier-select` に **「無料」を追加**し、自動判定を常に手動で上書きできるようにする。
5. [batch.ts:70](../../src/sidepanel/features/llm/batch.ts#L70) の既定 `getManualTier() || 'tier1'` を **`'free'`** に変更。
6. 実行時の安全網として **PR #87（429適応スロットリング）をマージ**する。判定器が将来壊れても、429 を見て減速すれば全件 pending の事故は防げる。ただし上記2の理由により、`isFreeTierQuota` で **tier を書き換えてはいけない**（減速のみ）。
7. APIキーを URL クエリ（`?key=`）から `x-goog-api-key` ヘッダへ移す。本実験のコードは全てヘッダ方式で書いてある。
