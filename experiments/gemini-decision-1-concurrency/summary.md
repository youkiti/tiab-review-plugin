| stage | 並列 | 件数 | 成功 | 空 | 失敗 | 不明 | 秒 | 件/秒 | 定常 件/秒 | 要求/分 | p50 ms | p95 ms | p95 全体 ms | 429 | 5xx | 400 | 他4xx | timeout | 通信 | 不正本文 | 再試行 | 入力トークン | 費用 $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c128 | 128 | 18000 | 18000 | 0 | 0 | 0 | 82.8 | 217.5 | 204.9 | 13318 | 350 | 579 | 581 | 370 | 0 | 0 | 0 | 0 | 0 | 0 | 370 | 13016919 | 1.3017 |
| c16 | 16 | 1200 | 1200 | 0 | 0 | 0 | 27.0 | 44.4 | 44.7 | 2667 | 340 | 519 | 519 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1066468 | 0.1066 |
| c256 | 256 | 20000 | 20000 | 0 | 0 | 0 | 57.5 | 347.9 | 328.5 | 21413 | 401 | 779 | 790 | 518 | 0 | 0 | 0 | 0 | 0 | 0 | 518 | 14410253 | 1.4410 |
| c32 | 32 | 2400 | 2400 | 0 | 0 | 0 | 25.7 | 93.2 | 96.5 | 5595 | 331 | 485 | 485 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1942249 | 0.1942 |
| c64 | 64 | 5000 | 5000 | 0 | 0 | 0 | 30.2 | 165.4 | 170.1 | 9922 | 359 | 581 | 581 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3628175 | 0.3628 |
| c8 | 8 | 800 | 800 | 0 | 0 | 0 | 31.8 | 25.1 | 25.2 | 1507 | 325 | 413 | 413 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 720813 | 0.0721 |
| smoke | 3 | 3 | 3 | 0 | 0 | 0 | 0.7 | 4.3 | 125.0 | 260 | 645 | 661 | 664 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1888 | 0.0002 |

実 API の合計: 47403 件（要求 48291 回）、入力 34786765 トークン、費用 $3.4787

429 の内訳（段ごと、本文の例は各段5件まで）:
- c128: 370 回 status=null (QuotaFailure なし)
  - seq 14985: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 45s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 14985: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 42s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 14985: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 34s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 15087: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 45s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 15087: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 42s or upgrade your tier at https://ai.dev/rate-limit."
- c256: 518 回 status=null (QuotaFailure なし)
  - seq 16222: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 15000 requests per minute on Tier 3). Please retry in 31s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 16222: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 27s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 16302: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 10000000 input tokens per minute on Tier 3). Please retry in 31s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 16302: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 15000 requests per minute on Tier 3). Please retry in 27s or upgrade your tier at https://ai.dev/rate-limit."
  - seq 16145: retryDelay=null / "Rate limit exceeded for model gemini-decision-1 (limit: 15000 requests per minute on Tier 3). Please retry in 31s or upgrade your tier at https://ai.dev/rate-limit."
