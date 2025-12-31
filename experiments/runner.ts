import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { screenReference, DEFAULT_MODEL_CONFIG } from '../src/lib/gemini-api';

const DATA_PATH = path.join(__dirname, 'data', 'sample.json');
const RESULTS_DIR = path.join(__dirname, 'results');

async function main() {
    console.log('Starting local experiment...');

    // Ensure results directory exists
    if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    // Load data
    const rawData = fs.readFileSync(DATA_PATH, 'utf-8');
    const references = JSON.parse(rawData);

    console.log(`Loaded ${references.length} references.`);

    // Define screening prompt
    const screeningPrompt = `
    You are a screener for a systematic review.
    Include studies about machine learning in systematic reviews.
    Exclude studies about geology.
    `;

    const results = [];

    for (const ref of references) {
        console.log(`Screening: ${ref.title}`);
        try {
            const result = await screenReference(
                ref.title,
                ref.abstract,
                screeningPrompt,
                {
                    ...DEFAULT_MODEL_CONFIG,
                    temperature: 0, // Experiment with this
                }
            );
            results.push({
                ...ref,
                ...result
            });
        } catch (error) {
            console.error(`Error screening ${ref.id}:`, error);
            results.push({
                ...ref,
                error: (error as Error).message
            });
        }
    }

    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultPath = path.join(RESULTS_DIR, `result_${timestamp}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));

    console.log(`Experiment finished. Results saved to ${resultPath}`);
}

main().catch(console.error);
