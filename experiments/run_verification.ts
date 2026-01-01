import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

async function main() {
    const projectRoot = path.resolve(__dirname, '..');

    // Target Datasets: CQ1-CQ5, Wilson
    const targetDatasets = ['cq1', 'cq2', 'cq3', 'cq4', 'cq5', 'wilson'];

    // Target Condition: B4 (Gemini 3.0 Flash, TopP 0.95, Think LOW)
    // as identified in experiments.json and report.md
    const conditions = ['B4'];

    console.log(`Target Datasets: ${targetDatasets.join(', ')}`);
    console.log(`Target Conditions: ${conditions.join(', ')}`);
    console.log(`Total combinations: ${targetDatasets.length * conditions.length}`);

    // Tier setting (tier_max for maximum concurrency)
    const tier = 'tier_max';

    for (const dataset of targetDatasets) {
        for (const condition of conditions) {
            console.log(`\n=== Running: Dataset=${dataset}, Condition=${condition} ===`);

            const cmd = `npx ts-node experiments/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}`;

            try {
                // stdio: 'inherit' to show output
                execSync(cmd, {
                    cwd: projectRoot,
                    stdio: 'inherit'
                });
            } catch (error) {
                console.error(`Error running ${dataset} / ${condition}:`, error);
                // Continue to next
            }
        }
    }
}

main().catch(console.error);
