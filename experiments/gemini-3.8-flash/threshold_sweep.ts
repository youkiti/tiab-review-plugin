/**
 * threshold スイープ（API 追加コストなし）
 *
 * results/depression_<条件ID>_items.jsonl（runner.ts が1件ごとに追記する JsonlRow 形式:
 * { ref_id, decision?, error? }）を読み、decision.note を JSON パースして得た
 * include_probability を再計算し、複数の threshold で Recall / Specificity / Precision /
 * Fβ(β=7) を算出する。ラベルは scripts/asreview-baseline/datasets/depression_slim_labeled.json
 * から ref_id で引く。読み込み規則は runner.ts と同一にしている
 * （ref_id: `r.ref_id || r.id`、label: `r.label_included ?? r.label_tiab ?? r.label ?? 0`、
 *  include_probability: `JSON.parse(decision.note).include_probability` — calculateMetrics 参照）。
 *
 * decision の無い行（error 行 = 判定できなかった件）は集計から除外し、件数を明記する。
 *
 * 使い方:
 *   npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
 *     experiments/gemini-3.8-flash/threshold_sweep.ts
 */
import fs from 'fs';
import path from 'path';

interface DecisionLike {
    ref_id: string;
    note?: string;
}

interface JsonlRow {
    ref_id: string;
    decision?: DecisionLike;
    error?: string;
}

interface LabeledItem {
    ref_id: string;
    include_probability: number;
    label_included: number;
}

interface ExperimentConfig {
    datasets: Record<string, string>;
    conditions: Array<{ id: string }>;
}

const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];

function metrics(items: LabeledItem[], threshold: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const it of items) {
        const predicted = it.include_probability >= threshold ? 1 : 0;
        const actual = it.label_included === 1 ? 1 : 0;
        if (predicted === 1 && actual === 1) tp++;
        else if (predicted === 1 && actual === 0) fp++;
        else if (predicted === 0 && actual === 0) tn++;
        else fn++;
    }
    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const beta = 7;
    const betaSquared = beta * beta;
    const fBeta = sensitivity + precision > 0
        ? (1 + betaSquared) * (precision * sensitivity) / (betaSquared * precision + sensitivity)
        : 0;
    return { threshold, tp, fp, tn, fn, sensitivity, specificity, precision, fBeta };
}

function pct(v: number): string { return (v * 100).toFixed(1) + '%'; }

/**
 * runner.ts の main() 内のデータセット読み込みと同じ規則で ref_id -> label_included の
 * Map を作る（ref_id: r.ref_id || r.id、label: label_included ?? label_tiab ?? label ?? 0）。
 */
function loadLabels(datasetPath: string): Map<string, number> {
    const raw = fs.readFileSync(datasetPath, 'utf-8');
    const parsed = JSON.parse(raw);
    let records: Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
        records = parsed;
    } else if (parsed.records && Array.isArray(parsed.records)) {
        records = parsed.records;
    } else {
        throw new Error(`不正なデータセット形式: 配列またはrecordsプロパティが必要 (${datasetPath})`);
    }
    const labels = new Map<string, number>();
    for (const r of records) {
        const refId = (r.ref_id || r.id) as string | undefined;
        if (!refId) continue;
        const label = (r.label_included ?? r.label_tiab ?? r.label ?? 0) as number;
        labels.set(refId, label);
    }
    return labels;
}

/**
 * results/depression_<condId>_items.jsonl を読み、ラベルと突き合わせて LabeledItem[] を作る。
 * - decision の無い行（error 行）は errorCount としてカウントし、集計から除外する
 * - ラベル未一致の ref_id（データセットに存在しない）は unlabeledCount としてカウントし除外する
 * - 同じ ref_id が複数回書かれている場合は最後の行を採用する（runner.ts の再開ロジックと同じ規則）
 */
function loadJsonlItems(
    jsonlPath: string,
    labels: Map<string, number>
): { items: LabeledItem[]; errorCount: number; unlabeledCount: number } {
    const items: LabeledItem[] = [];
    let errorCount = 0;
    let unlabeledCount = 0;
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);

    const latestByRefId = new Map<string, JsonlRow>();
    for (const line of lines) {
        try {
            const row: JsonlRow = JSON.parse(line);
            latestByRefId.set(row.ref_id, row);
        } catch {
            // 破損行はスキップ（クラッシュ時の書きかけ行を想定）
        }
    }

    for (const row of latestByRefId.values()) {
        if (!row.decision) {
            errorCount++;
            continue;
        }
        const label = labels.get(row.ref_id);
        if (label === undefined) {
            unlabeledCount++;
            continue;
        }
        let probability: number | null = null;
        if (row.decision.note) {
            try {
                const noteData = JSON.parse(row.decision.note);
                probability = typeof noteData.include_probability === 'number' ? noteData.include_probability : null;
            } catch {
                probability = null;
            }
        }
        if (probability === null) {
            errorCount++;
            continue;
        }
        items.push({ ref_id: row.ref_id, include_probability: probability, label_included: label });
    }
    return { items, errorCount, unlabeledCount };
}

function main(): void {
    const configPath = path.join(__dirname, 'config.json');
    const config: ExperimentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const projectRoot = path.resolve(__dirname, '..', '..');
    const datasetPath = path.join(projectRoot, config.datasets.depression);
    const resultsDir = path.join(__dirname, 'results');

    const lines: string[] = [];
    lines.push('# gemini-3.8-flash threshold スイープ (depression)');
    lines.push('');
    lines.push('保存済み JSONL (results/depression_<条件ID>_items.jsonl) から再計算（API 追加コストなし）。既定 threshold=0.5。採用基準 Recall≥95%。');
    lines.push('');

    let labels: Map<string, number>;
    try {
        labels = loadLabels(datasetPath);
    } catch (e) {
        console.error(`データセットの読み込みに失敗しました: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
    }
    const positiveCount = [...labels.values()].filter(v => v === 1).length;
    lines.push(`データセット: ${config.datasets.depression} (n=${labels.size}, 陽性=${positiveCount})`);
    lines.push('');

    let anyData = false;
    for (const cond of config.conditions) {
        const jsonlPath = path.join(resultsDir, `depression_${cond.id}_items.jsonl`);
        lines.push(`## ${cond.id}`);
        lines.push('');
        if (!fs.existsSync(jsonlPath)) {
            lines.push(`対象データが無い（${jsonlPath} が未生成）。runner.ts の実行後に再度実行してください。`);
            lines.push('');
            continue;
        }
        anyData = true;
        const { items, errorCount, unlabeledCount } = loadJsonlItems(jsonlPath, labels);
        lines.push(`集計対象: ${items.length}件 (JSONL全体からエラー/未判定 ${errorCount}件、ラベル不一致 ${unlabeledCount}件を除外)`);
        lines.push('');
        if (items.length === 0) {
            lines.push('集計対象が0件のため threshold スイープを実施できません。');
            lines.push('');
            continue;
        }

        const buckets = { '<0.1': 0, '0.1-0.5': 0, '0.5-0.9': 0, '>=0.9': 0 };
        for (const it of items) {
            const p = it.include_probability;
            if (p < 0.1) buckets['<0.1']++;
            else if (p < 0.5) buckets['0.1-0.5']++;
            else if (p < 0.9) buckets['0.5-0.9']++;
            else buckets['>=0.9']++;
        }
        lines.push(`確率分布: <0.1=${buckets['<0.1']} / 0.1-0.5=${buckets['0.1-0.5']} / 0.5-0.9=${buckets['0.5-0.9']} / ≥0.9=${buckets['>=0.9']}`);
        lines.push('');
        lines.push('| threshold | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |');
        lines.push('|---|---|---|---|---|---|---|---|---|');
        for (const t of THRESHOLDS) {
            const m = metrics(items, t);
            const recallMark = m.sensitivity >= 0.95 ? ' ✅' : '';
            lines.push(`| ${t.toFixed(2)} | **${pct(m.sensitivity)}**${recallMark} | ${pct(m.specificity)} | ${pct(m.precision)} | ${pct(m.fBeta)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} |`);
        }
        lines.push('');
    }

    if (!anyData) {
        lines.push('対象データが見つかりませんでした。先に runner.ts (または run_phase1.ts) を実行して results/ に JSONL を生成してください。');
        lines.push('');
    }

    const out = lines.join('\n') + '\n';
    const outPath = path.join(__dirname, 'threshold_sweep.md');
    fs.writeFileSync(outPath, out);
    console.log(out);
    console.log(`\n出力: ${outPath}`);
}

main();
