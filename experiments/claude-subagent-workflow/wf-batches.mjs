// Workflow のサブエージェントに渡すバッチの作成（prepare）と、エージェントが書いた判定の取り込み・集計（ingest）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sweep } from '../claude-code-headless/lib/metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const RESULTS = path.join(HERE, 'results');
const batchName = (index) => `batch_${String(index).padStart(3, '0')}.json`;

function loadDataset() {
    const dataset = JSON.parse(fs.readFileSync(path.resolve(REPO, CONFIG.dataset.path), 'utf8'));
    const positives = dataset.filter((record) => record[CONFIG.dataset.labelField] === 1).length;
    if (dataset.length !== CONFIG.dataset.expected.n || positives !== CONFIG.dataset.expected.positives) {
        throw new Error(`データ件数不一致: ${dataset.length} 件・陽性 ${positives}`);
    }
    if (new Set(dataset.map((record) => record.id)).size !== dataset.length) {
        throw new Error('データの ID が重複しています');
    }
    return dataset;
}

/** データの並び順のまま batchSize 件ずつに切る。割り当ては決定的で、乱数を使わない。 */
function splitBatches(dataset) {
    const batches = [];
    for (let start = 0; start < dataset.length; start += CONFIG.batchSize) {
        batches.push(dataset.slice(start, start + CONFIG.batchSize));
    }
    return batches;
}

function prepare(workDir) {
    const batches = splitBatches(loadDataset());
    fs.mkdirSync(path.join(workDir, 'in'), { recursive: true });
    for (const condition of CONFIG.conditions) {
        fs.mkdirSync(path.join(workDir, 'out', condition.id), { recursive: true });
    }
    const manifest = batches.map((batch, offset) => {
        // ラベルを渡さない。エージェントが読むのは id・title・abstract だけ。
        const text = JSON.stringify(batch.map(({ id, title, abstract }) => ({ id, title, abstract: abstract || '' })), null, 1);
        fs.writeFileSync(path.join(workDir, 'in', batchName(offset + 1)), text + '\n', 'utf8');
        return {
            batch: offset + 1, n: batch.length, first_id: batch[0].id, last_id: batch[batch.length - 1].id,
            sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        };
    });
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, 'batch_manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8');
    const total = manifest.reduce((sum, entry) => sum + entry.n, 0);
    console.log(`バッチ ${manifest.length} 個・文献 ${total} 件を ${workDir} に書き出しました`);
}

/** 1 バッチの出力を検証する。返り値は { rows } か { problem }。問題のあるバッチは 1 件も採用しない。 */
function readBatchOutput(file, batch) {
    if (!fs.existsSync(file)) {
        return { problem: '出力なし' };
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (error) {
        return { problem: `JSON として読めない: ${error.message}` };
    }
    if (!Array.isArray(parsed)) {
        return { problem: '配列ではない' };
    }
    const expected = batch.map((record) => record.id);
    const got = parsed.map((row) => row?.ref_id);
    if (got.length !== expected.length || new Set(got).size !== got.length || expected.some((id) => !got.includes(id))) {
        return { problem: `ID が入力と一致しない（入力 ${expected.length} 件・出力 ${got.length} 件）` };
    }
    for (const row of parsed) {
        const p = row.include_probability;
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            return { problem: `確率が不正: ${row.ref_id}` };
        }
    }
    return { rows: parsed, mtime: fs.statSync(file).mtime.toISOString() };
}

function ingest(workDir, allowPartial) {
    const dataset = loadDataset();
    const batches = splitBatches(dataset);
    const labels = new Map(dataset.map((record) => [record.id, record[CONFIG.dataset.labelField]]));
    const summary = { work_dir: workDir, batch_size: CONFIG.batchSize, conditions: [] };
    let incomplete = false;
    for (const condition of CONFIG.conditions) {
        const rows = [];
        const problems = [];
        batches.forEach((batch, offset) => {
            const file = path.join(workDir, 'out', condition.id, batchName(offset + 1));
            const result = readBatchOutput(file, batch);
            if (result.problem) {
                problems.push({ batch: offset + 1, problem: result.problem });
                return;
            }
            for (const row of result.rows) {
                rows.push({
                    ref_id: row.ref_id, condition: condition.id, model: condition.model, effort: condition.effort,
                    batch: offset + 1, include_probability: row.include_probability,
                    reasons: Array.isArray(row.reasons) ? row.reasons : [], output_written_at: result.mtime,
                });
            }
        });
        const complete = rows.length === dataset.length;
        incomplete ||= !complete;
        console.log(`${condition.id} ${condition.model}: ${rows.length}/${dataset.length} 件・問題のあるバッチ ${problems.length} 個`
            + (problems.length ? ` → ${problems.map((entry) => entry.batch).join(',')}` : ''));
        // 取り込みのたびに作り直す（追記ではない）。出どころはエージェントの出力ファイル。
        const ledger = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
        fs.writeFileSync(path.join(RESULTS, `depression_${condition.id}_items.jsonl`), ledger, 'utf8');
        const entry = { condition: condition.id, model: condition.model, effort: condition.effort, n: rows.length,
            target: dataset.length, complete, problems };
        if (complete || allowPartial) {
            entry.sweep = sweep(rows, labels, CONFIG.thresholds);
            for (const point of entry.sweep) {
                const pct = (value) => value === null ? '—' : (100 * value).toFixed(2);
                console.log(`  閾値 ${point.threshold}: TP ${point.tp} FP ${point.fp} TN ${point.tn} FN ${point.fn} / 再現率 ${pct(point.recall)}`
                    + ` 特異度 ${pct(point.specificity)} 適合率 ${pct(point.precision)} Fβ7 ${pct(point.fBeta7)}${complete ? '' : '（途中集計）'}`);
            }
        }
        summary.conditions.push(entry);
    }
    fs.writeFileSync(path.join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 1) + '\n', 'utf8');
    return incomplete ? 1 : 0;
}

const [command, workDir, flag] = process.argv.slice(2);
if (!['prepare', 'ingest'].includes(command) || !workDir) {
    console.error('使い方: node wf-batches.mjs prepare <作業フォルダ> | ingest <作業フォルダ> [--allow-partial]');
    process.exitCode = 2;
} else if (command === 'prepare') {
    prepare(path.resolve(workDir));
} else {
    process.exitCode = ingest(path.resolve(workDir), flag === '--allow-partial');
}
