# Gemini Experiments & Implementation Report

## 1. Executive Summary

This project aimed to optimize the TiAb Review Plugin for high-accuracy systematic review screening using the latest Gemini models.
Extensive experiments compared **Gemini 2.5 Flash Lite** (Model A) and **Gemini 3.0 Flash Preview** (Model B: Thinking Model).

**Final Decision:**
- **Default Model**: `gemini-3-flash-preview` (Thinking LOW, TopP 0.95)
- **Fallback**: `gemini-2.5-flash-lite` (Cost-optimized)

The new default configuration achieves **96% Recall** (sensitivity), significantly minimizing the risk of missing relevant studies.

## 2. Experiment Results

We compared multiple conditions using the `depression` dataset (1993 records).

### Performance Metrics (Dataset: Depression)

| Model | Config | Recall | Precision | Fβ(7) | Evaluation |
|---|---|---|---|---|---|
| **Gemini 3.0 Flash** | **TopP 0.95, Think LOW** | **0.96** | **0.53** | **0.95** | **Optimal** |
| Gemini 3.0 Flash | TopP 0.65, Think MIN | 0.95 | 0.51 | 0.93 | Good stability |
| Gemini 3.0 Flash | TopP 0.95, Think HIGH| 0.95 | 0.53 | 0.94 | Slightly overkill |
| Gemini 2.5 Flash Lite | (Baseline) | 0.93 | 0.48 | 0.92 | Cost-efficient |

**Key Findings:**
1.  **Thinking Model Superiority**: Model B consistently outperformed Model A in both Recall (+3%) and Precision (+5%).
2.  **Sensitivity Instruction**: Adding a "When in doubt, Include" instruction to the prompt was crucial for achieving >95% recall.
3.  **Optimal Thinking Level**: `LOW` provided the best balance.

## 3. Technical Challenges & Lessons Learned (Failed Settings)

Several configurations were tested and failed before achieving the optimal setup.

### 3.1. API Timeouts with Thinking Models
- **Failed Setting**: Standard HTTP request with 60s timeout.
- **Outcome**: ~100% Failure rate for Thinking models, which take 10-60s to generate "thought" tokens before the final answer.
- **Solution**: **Streaming API** with chunk-based timeout reset. The connection acts as "alive" as long as tokens are being generated.

### 3.2. Sequential vs. Parallel Processing
- **Failed Setting**: Sequential processing (`thinking_serial`).
- **Outcome**: Extremely slow output (1 record every 10-20 seconds), making full dataset processing impractical (>6 hours).
- **Solution**: High concurrency (c=1000) allowed processing 1993 records in <10 minutes.

### 3.3. Concurrency Pitfalls
- **Failed Setting**: Concurrency 1000 *without* dynamic batching.
- **Issue**: The runner had a hardcoded `batchSize: 50`. Even if concurrency was 1000, it processed in chunks of 50, limiting throughput.
- **Issue**: `Promise.all` buffering. Progress logs only appeared after *all* 1000 requests in a batch finished, leading to "silence" for minutes and perceived hang.
- **Solution**: Dynamic batch size (`Math.max(50, concurrency)`) and per-item progress logging.

## 4. Recommendations for App Implementation

### Configuration
Update `src/lib/gemini-api.ts` to reflect the best settings:
```typescript
export const DEFAULT_MODEL_CONFIG = {
    model: 'gemini-3-flash-preview',
    temperature: 1.0,
    topP: 0.95,
    thinkingLevel: 'LOW',
};
```

### Browser Limitations
While the experiment ran at `concurrency: 1000` (Node.js), browser environments differ.
- **Recommended Browsers Settings**: Concurrency `20` - `50`.
- **Streaming**: Essential for preventing timeouts in the UI.

## 5. Result Files & Evidence

### Logs
- **Full Run Log (B1-B8)**: [experiments_B1_B8_full.log.txt](logs/experiments_B1_B8_full.log.txt)
- **B1 Experiment Log**: [experiment_2026-01-01T09-08-40.log.json](results/experiment_2026-01-01T09-08-40.log.json)

### Decision Data
- **B1 Decisions**: [decisions_2026-01-01T09-08-40.json](results/decisions_2026-01-01T09-08-40.json)
