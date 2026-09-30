import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { BenchError, DatasetRecord } from '../ledger';
import { atomicWrite, directory, fail, loadConfig, validateData } from './common';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) throw new BenchError('--input <JSONLのパス> を指定してください。');
    const config = loadConfig();
    const reviews = new Map<string, { criteria: string; records: DatasetRecord[] }>();
    const hash = createHash('sha256');
    const input = fs.createReadStream(args[1]);
    input.on('data', chunk => hash.update(chunk));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let previous: string | undefined;
    for await (const line of lines) {
        const row = JSON.parse(line);
        const id = row.cochrane_id;
        if (!Object.prototype.hasOwnProperty.call(config.reviews, id)
            || typeof row.selection_criteria !== 'string' || typeof row.title !== 'string'
            || (row.abstract != null && typeof row.abstract !== 'string')
            || !['included', 'excluded'].includes(row.label)) throw new BenchError('入力の形式またはレビューIDが不正です。');
        if (previous !== id && reviews.has(id)) throw new BenchError('レビューの行が連続していません。');
        previous = id;
        if (!reviews.has(id)) reviews.set(id, { criteria: row.selection_criteria, records: [] });
        const data = reviews.get(id)!;
        if (data.criteria !== row.selection_criteria) throw new BenchError(`基準がレビュー内で一致しません: ${id}`);
        data.records.push({ id: `${id}:${data.records.length}`, title: row.title,
            abstract: row.abstract ?? '', label_included: row.label === 'included' ? 1 : 0 });
    }
    if (hash.digest('hex') !== config.inputSha256) throw new BenchError('入力の SHA-256 が一致しません。書き込みません。');
    for (const id of Object.keys(config.reviews)) {
        const data = reviews.get(id);
        if (!data) throw new BenchError(`レビューがありません: ${id}`);
        validateData(config, id, data);
    }
    // 全レビューとハッシュの照合が終わるまで、データを出力しない。
    for (const [id, data] of reviews) atomicWrite(path.join(directory, 'data', `${id}.json`), JSON.stringify(data) + '\n');
    console.log(`照合完了: ${reviews.size} レビュー、${[...reviews.values()].reduce((n, d) => n + d.records.length, 0)} 件を書き出しました。`);
}
if (require.main === module) main().catch(fail);
