# Local LLM Experiments

This directory contains scripts for running LLM screening experiments locally, without the Chrome extension context.

## Setup

1.  Ensure dependencies are installed:
    ```bash
    npm install
    # or just install dev dependencies
    npm install --save-dev dotenv ts-node
    ```

2.  Create `.env` file in the project root (if not exists) and add your Gemini API key:
    ```
    GEMINI_API_KEY=your_actual_api_key_here
    ```

## Running Experiments

Run the experiment runner using `ts-node` with the provided configuration:

```bash
npx ts-node --project experiments/tsconfig.json experiments/runner.ts
```

## Configuration

- **Data**: Modify `experiments/data/sample.json` to change the input references.
- **Parameters**: Edit `experiments/runner.ts` to adjust:
    - Model (default: `gemini-2.5-flash-lite`)
    - Temperature
    - Prompt
    - Output language

## Results

Results are saved to `experiments/results/` as JSON files with timestamps.
