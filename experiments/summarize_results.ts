import fs from 'fs';
import path from 'path';

function main() {
    const resultsDir = path.join(__dirname, 'results');
    const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('experiment_2025-12-31') && f.endsWith('.log.json'))
        .sort();

    // 最新の8件を取得 (09-51-54以降)
    const recentFiles = files.filter(f => f >= 'experiment_2025-12-31T09-51-54.log.json');

    console.log('| Dataset | Condition | Model | Temp | TopP | Sensitivity | Specificity | Precision | F7 Score | Time(s) | Source File |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');

    for (const file of recentFiles) {
        const content = fs.readFileSync(path.join(resultsDir, file), 'utf-8');
        try {
            const data = JSON.parse(content);
            const params = data.parameters;
            const evalResult = data.evaluation;
            const results = data.results;

            const dataset = params.dataset;
            // 短く表示するためにファイル名のみ抽出、またはパス全体を表示
            const datasetPath = params.datasetPath ? path.basename(params.datasetPath) : 'N/A';
            const conditionId = params.condition.id;
            const model = params.condition.model;
            const temp = params.condition.temperature;
            const topP = params.condition.topP;

            if (evalResult) {
                const sens = (evalResult.sensitivity * 100).toFixed(2) + '%';
                const spec = (evalResult.specificity * 100).toFixed(2) + '%';
                const prec = (evalResult.precision * 100).toFixed(2) + '%';
                const f7 = (evalResult.fBetaScore * 100).toFixed(2) + '%';
                const time = (results.durationMs / 1000).toFixed(0);

                console.log(`| ${dataset} | ${conditionId} | ${model} | ${temp} | ${topP} | **${sens}** | ${spec} | ${prec} | **${f7}** | ${time} | ${datasetPath} |`);
            } else {
                console.log(`| ${dataset} | ${conditionId} | ${model} | ${temp} | ${topP} | N/A | N/A | N/A | N/A | N/A | ${datasetPath} |`);
            }
        } catch (e) {
            console.error(`Error parsing ${file}:`, e);
        }
    }
}

main();
