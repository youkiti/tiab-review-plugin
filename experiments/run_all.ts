import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface ExperimentConfig {
    datasets: Record<string, string>;
    conditions: Array<{ id: string }>;
    tierConfigs: Record<string, unknown>;
}

async function main() {
    const projectRoot = path.resolve(__dirname, '..');
    const experimentsDir = path.join(projectRoot, 'experiments');
    const logsDir = path.join(experimentsDir, 'logs');
    const experimentParamsPath = path.join(experimentsDir, 'experiments.json');

    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const config: ExperimentConfig = JSON.parse(fs.readFileSync(experimentParamsPath, 'utf-8'));

    // データセット: 本番用 (CQ1, Depression) + テスト用 (CQ3) - EXPERIMENT_PLAN.mdに基づく
    // ただし、実験計画では「一括して処理する」とあるため、experiments.jsonにある全てのデータセットを回すか、プランにあるものに絞るか。
    // EXPERIMENT_PLAN.mdには「CQ1, Depression, CQ3」などが明記されているが、
    // experiments.jsonの全てのdataset × 全てのconditionを実行すると膨大になる可能性がある。
    // ユーザーは「最後の実験を...一括して処理する」と言っているため、
    // EXPERIMENT_PLAN.mdの "評価データセット" 表にある ★つきのもの、または全てを対象にする。
    // ここでは安全のため、experiments.jsonのdatasetsキーにあるもの全てを対象とするが、
    // wilsonはラベル異常のため除外できるなら除外したい。
    // しかしRunnerはエラー時に落ちずに次へ行くべき。

    // ユーザー指定: depression データセットのみを使用
    const targetDatasets = ['depression'];

    // 条件 (A1-A8 -> B1-B8)
    const conditions = config.conditions
        .map(c => c.id)
        .filter(id => id.startsWith('B'));

    console.log(`Target Datasets: ${targetDatasets.join(', ')}`);
    console.log(`Target Conditions: ${conditions.join(', ')}`);
    console.log(`Total combinations: ${targetDatasets.length * conditions.length}`);

    // Tier setting (tier1 for thinking model stability)
    const tier = 'tier1';

    for (const dataset of targetDatasets) {
        for (const condition of conditions) {
            console.log(`\n=== Running: Dataset=${dataset}, Condition=${condition} ===`);

            const cmd = `npx ts-node experiments/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}`;

            try {
                // stdio: 'inherit' で出力を表示
                execSync(cmd, {
                    cwd: projectRoot,
                    stdio: 'inherit'
                });
            } catch (error) {
                console.error(`Error running ${dataset} / ${condition}:`, error);
                // 続行する
            }
        }
    }
}

main().catch(console.error);
