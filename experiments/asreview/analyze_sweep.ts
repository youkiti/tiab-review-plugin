/**
 * パラメータスイープ結果の分析スクリプト
 */

import fs from "fs";
import path from "path";

interface ExperimentConfig {
  alpha: number;
  ratio: number;
}

interface ExperimentResult {
  config: ExperimentConfig;
  dataset: string;
  summary: {
    mean_wss_95: number;
    mean_wss_100: number;
    mean_ap: number;
    mean_auc_roc: number;
    mean_recall_at_10: number;
    mean_recall_at_50: number;
    mean_recall_at_100: number;
    mean_top100_match: number;
    std_wss_95: number;
    std_wss_100: number;
    std_ap: number;
    std_auc_roc: number;
    std_recall_at_10: number;
    std_recall_at_50: number;
    std_recall_at_100: number;
    std_top100_match: number;
  };
}

interface SweepOutput {
  dataset: string;
  datasetPath: string;
  top: number;
  alphaValues: number[];
  ratioValues: number[];
  experiments: ExperimentResult[];
  timestamp: string;
}

function findLatestSweepFile(dataset: string): string {
  const dir = "experiments/asreview/outputs/parameter_sweep";
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`sweep_${dataset}_`) && f.endsWith('.json'))
    .sort()
    .reverse();
  
  if (files.length === 0) {
    throw new Error(`${dataset}のスイープ結果が見つかりません`);
  }
  
  return path.join(dir, files[0]);
}

function loadSweepOutput(filePath: string): SweepOutput {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SweepOutput;
}

function generateMarkdownReport(data: SweepOutput): string {
  const lines: string[] = [];
  
  lines.push(`# パラメータスイープ分析レポート`);
  lines.push(``);
  lines.push(`**データセット**: ${data.dataset}`);
  lines.push(`**実行日時**: ${data.timestamp}`);
  lines.push(`**実験数**: ${data.experiments.length}通り（alpha: ${data.alphaValues.length}種類 × ratio: ${data.ratioValues.length}種類）`);
  lines.push(``);
  
  // 評価指標の説明
  lines.push(`## 評価指標の説明`);
  lines.push(``);
  lines.push(`### 主要指標（ランキング性能）`);
  lines.push(``);
  lines.push(`- **WSS@95** (Work Saved over Sampling at 95% recall)`);
  lines.push(`  - 95%の関連文献を発見するまでにスキップできた文献の割合`);
  lines.push(`  - レビュワーの労力削減を直接示す最重要指標`);
  lines.push(`  - 高いほど効率的（理想値: 1.0、ランダム: 0.05）`);
  lines.push(``);
  lines.push(`- **AP** (Average Precision)`);
  lines.push(`  - ランキング全体の品質を評価する情報検索の標準指標`);
  lines.push(`  - すべての順位での精度を平均化`);
  lines.push(`  - 高いほど良いランキング（理想値: 1.0、ランダム: 0.02程度）`);
  lines.push(``);
  lines.push(`- **Recall@10/100** (Recall at k)`);
  lines.push(`  - 上位k件に含まれる関連文献の割合`);
  lines.push(`  - Recall@10: 初期精度（最初の10件でどれだけ発見できるか）`);
  lines.push(`  - Recall@100: 中期精度（100件時点での発見率）`);
  lines.push(``);
  lines.push(`### 補助指標`);
  lines.push(``);
  lines.push(`- **AUC-ROC** (Area Under the ROC Curve)`);
  lines.push(`  - 閾値に依存しない分類性能の指標`);
  lines.push(`  - include/excludeの分離能力を評価`);
  lines.push(`  - 0.5がランダム、1.0が完全分離`);
  lines.push(``);
  lines.push(`- **Top100 Match vs Python**`);
  lines.push(`  - Python実装との上位100件のID一致率`);
  lines.push(`  - 実装の正確性を検証する指標（性能評価ではない）`);
  lines.push(`  - デフォルト設定で1.0000なら実装が完全一致`);
  lines.push(``);
  
  // ベスト設定
  const sorted = [...data.experiments].sort(
    (a, b) => b.summary.mean_wss_95 - a.summary.mean_wss_95
  );
  
  lines.push(`## ベスト設定 (WSS@95 降順)`);
  lines.push(``);
  lines.push(`| 順位 | alpha | ratio | WSS@95 | AP | AUC | Recall@10 | Recall@100 | Top100 Match |`);
  lines.push(`|------|-------|-------|---------|-----|-----|-----------|------------|--------------|`);
  
  sorted.slice(0, 10).forEach((exp, idx) => {
    lines.push(
      `| ${idx + 1} | ${exp.config.alpha} | ${exp.config.ratio} | ` +
      `${exp.summary.mean_wss_95.toFixed(4)} | ` +
      `${exp.summary.mean_ap.toFixed(4)} | ` +
      `${exp.summary.mean_auc_roc.toFixed(4)} | ` +
      `${exp.summary.mean_recall_at_10.toFixed(4)} | ` +
      `${exp.summary.mean_recall_at_100.toFixed(4)} | ` +
      `${exp.summary.mean_top100_match.toFixed(4)} |`
    );
  });
  
  lines.push(``);
  
  // Alpha別の分析
  lines.push(`## Alpha値の影響`);
  lines.push(``);
  
  const alphaGroups = new Map<number, ExperimentResult[]>();
  data.experiments.forEach(exp => {
    if (!alphaGroups.has(exp.config.alpha)) {
      alphaGroups.set(exp.config.alpha, []);
    }
    alphaGroups.get(exp.config.alpha)!.push(exp);
  });
  
  lines.push(`| alpha | 平均 WSS@95 | 最大 WSS@95 | 最小 WSS@95 |`);
  lines.push(`|-------|-------------|-------------|-------------|`);
  
  Array.from(alphaGroups.entries())
    .sort((a, b) => a[0] - b[0])
    .forEach(([alpha, exps]) => {
      const wssValues = exps.map(e => e.summary.mean_wss_95);
      const mean = wssValues.reduce((a, b) => a + b, 0) / wssValues.length;
      const max = Math.max(...wssValues);
      const min = Math.min(...wssValues);
      
      lines.push(`| ${alpha} | ${mean.toFixed(4)} | ${max.toFixed(4)} | ${min.toFixed(4)} |`);
    });
  
  lines.push(``);
  
  // Ratio別の分析
  lines.push(`## Ratio値の影響`);
  lines.push(``);
  
  const ratioGroups = new Map<number, ExperimentResult[]>();
  data.experiments.forEach(exp => {
    if (!ratioGroups.has(exp.config.ratio)) {
      ratioGroups.set(exp.config.ratio, []);
    }
    ratioGroups.get(exp.config.ratio)!.push(exp);
  });
  
  lines.push(`| ratio | 平均 WSS@95 | 最大 WSS@95 | 最小 WSS@95 |`);
  lines.push(`|-------|-------------|-------------|-------------|`);
  
  Array.from(ratioGroups.entries())
    .sort((a, b) => a[0] - b[0])
    .forEach(([ratio, exps]) => {
      const wssValues = exps.map(e => e.summary.mean_wss_95);
      const mean = wssValues.reduce((a, b) => a + b, 0) / wssValues.length;
      const max = Math.max(...wssValues);
      const min = Math.min(...wssValues);
      
      lines.push(`| ${ratio} | ${mean.toFixed(4)} | ${max.toFixed(4)} | ${min.toFixed(4)} |`);
    });
  
  lines.push(``);
  
  // ヒートマップデータ
  lines.push(`## ヒートマップデータ (WSS@95)`);
  lines.push(``);
  lines.push(`| alpha \\ ratio | ${data.ratioValues.join(' | ')} |`);
  lines.push(`|---------------|${data.ratioValues.map(() => '------').join('|')}|`);
  
  data.alphaValues.forEach(alpha => {
    const row = [String(alpha)];
    data.ratioValues.forEach(ratio => {
      const exp = data.experiments.find(
        e => e.config.alpha === alpha && e.config.ratio === ratio
      );
      row.push(exp ? exp.summary.mean_wss_95.toFixed(4) : '-');
    });
    lines.push(`| ${row.join(' | ')} |`);
  });
  
  lines.push(``);
  
  // 結論
  lines.push(`## 結論と推奨事項`);
  lines.push(``);
  
  const best = sorted[0];
  const defaultExp = data.experiments.find(
    e => e.config.alpha === 3.822 && e.config.ratio === 1.2
  );
  
  const improvement = defaultExp 
    ? ((best.summary.mean_wss_95 - defaultExp.summary.mean_wss_95) / 
       defaultExp.summary.mean_wss_95 * 100).toFixed(2)
    : '0.00';
  
  if (defaultExp) {
    lines.push(`### パフォーマンス比較`);
    lines.push(``);
    lines.push(`| 設定 | alpha | ratio | WSS@95 | AP | AUC | Recall@10 | 改善率 |`);
    lines.push(`|------|-------|-------|---------|-----|-----|-----------|---------|`);
    lines.push(`| デフォルト | ${defaultExp.config.alpha} | ${defaultExp.config.ratio} | ${defaultExp.summary.mean_wss_95.toFixed(4)} | ${defaultExp.summary.mean_ap.toFixed(4)} | ${defaultExp.summary.mean_auc_roc.toFixed(4)} | ${defaultExp.summary.mean_recall_at_10.toFixed(4)} | - |`);
    lines.push(`| ベスト | ${best.config.alpha} | ${best.config.ratio} | ${best.summary.mean_wss_95.toFixed(4)} | ${best.summary.mean_ap.toFixed(4)} | ${best.summary.mean_auc_roc.toFixed(4)} | ${best.summary.mean_recall_at_10.toFixed(4)} | +${improvement}% |`);
    lines.push(``);
    
    // 実装検証
    if (defaultExp.summary.mean_top100_match === 1.0) {
      lines.push(`### ✅ 実装検証`);
      lines.push(``);
      lines.push(`デフォルト設定でPython実装との一致率が **1.0000 (100%)** となり、TypeScript実装の正確性が確認されました。`);
      lines.push(``);
    }
  }
  
  lines.push(`### 観察された傾向`);
  lines.push(``);
  
  // Alpha傾向
  const alphaWss = Array.from(alphaGroups.entries())
    .map(([alpha, exps]) => ({
      alpha,
      mean: exps.map(e => e.summary.mean_wss_95).reduce((a, b) => a + b, 0) / exps.length
    }))
    .sort((a, b) => b.mean - a.mean);
  
  const alphaRecall = Array.from(alphaGroups.entries())
    .map(([alpha, exps]) => ({
      alpha,
      mean: exps.map(e => e.summary.mean_recall_at_10).reduce((a, b) => a + b, 0) / exps.length
    }))
    .sort((a, b) => b.mean - a.mean);
  
  lines.push(`#### 1. Alpha値の影響`);
  lines.push(``);
  lines.push(`- **WSS@95**: alpha=${alphaWss[0].alpha} が最も効率的（平均 ${alphaWss[0].mean.toFixed(4)}）`);
  lines.push(`- **Recall@10**: alpha=${alphaRecall[0].alpha} が初期精度最高（平均 ${alphaRecall[0].mean.toFixed(4)}）`);
  lines.push(`- **解釈**: Multinomial NBのスムージングパラメータ。高い値は低頻度語の影響を抑制`);
  lines.push(``);
  
  // Ratio傾向
  const ratioWss = Array.from(ratioGroups.entries())
    .map(([ratio, exps]) => ({
      ratio,
      mean: exps.map(e => e.summary.mean_wss_95).reduce((a, b) => a + b, 0) / exps.length
    }))
    .sort((a, b) => b.mean - a.mean);
  
  const ratioRecall = Array.from(ratioGroups.entries())
    .map(([ratio, exps]) => ({
      ratio,
      mean: exps.map(e => e.summary.mean_recall_at_10).reduce((a, b) => a + b, 0) / exps.length
    }))
    .sort((a, b) => b.mean - a.mean);
  
  lines.push(`#### 2. Ratio値の影響`);
  lines.push(``);
  lines.push(`- **WSS@95**: ratio=${ratioWss[0].ratio} が最も効率的（平均 ${ratioWss[0].mean.toFixed(4)}）`);
  lines.push(`- **Recall@10**: ratio=${ratioRecall[0].ratio} が初期精度最高（平均 ${ratioRecall[0].mean.toFixed(4)}）`);
  lines.push(`- **解釈**: クラス重み付けのバランス。1.0がバランス、2.0はincludeを2倍重視`);
  lines.push(``);
  
  // 推奨事項
  lines.push(`### 推奨事項`);
  lines.push(``);
  
  const improvementNum = parseFloat(improvement);
  if (improvementNum > 1.0) {
    lines.push(`1. **パラメータ変更を推奨**: ベスト設定 (alpha=${best.config.alpha}, ratio=${best.config.ratio}) により **${improvement}%** の効率改善が期待できます`);
  } else if (improvementNum > 0) {
    lines.push(`1. **パラメータ変更は任意**: わずか ${improvement}% の改善のため、デフォルト設定のままでも十分です`);
  } else {
    lines.push(`1. **デフォルト設定を維持**: 現在の設定が最適です`);
  }
  
  if (defaultExp) {
    // 他の指標での比較
    const apImprovement = ((best.summary.mean_ap - defaultExp.summary.mean_ap) / defaultExp.summary.mean_ap * 100).toFixed(2);
    lines.push(`2. **AP (ランキング品質)**: ベスト設定で ${apImprovement}% の変化`);
  }
  
  lines.push(`3. **トレードオフ**: WSS@95とRecall@10は必ずしも一致しない。目的に応じて選択`);
  lines.push(`   - 早期発見重視 → Recall@10が高い設定`);
  lines.push(`   - 全体効率重視 → WSS@95が高い設定`);
  
  lines.push(``);
  
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const datasetIndex = args.indexOf("--dataset");
  const dataset = datasetIndex >= 0 ? args[datasetIndex + 1] : "cq1";
  
  console.log(`分析対象データセット: ${dataset}`);
  
  const sweepFile = findLatestSweepFile(dataset);
  console.log(`読み込み: ${sweepFile}`);
  
  const data = loadSweepOutput(sweepFile);
  console.log(`実験数: ${data.experiments.length}`);
  
  const report = generateMarkdownReport(data);
  
  const outputPath = `experiments/asreview/outputs/parameter_sweep/analysis_${dataset}.md`;
  fs.writeFileSync(outputPath, report, 'utf-8');
  
  console.log(`\nレポート作成: ${outputPath}`);
  console.log(`\n${report}`);
}

main();
