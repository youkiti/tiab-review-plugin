import { appendLedger, BenchError, readLedger, screeningPrompt } from '../ledger';
import { fakeScreen, runRecords, Screen } from '../runner';
import { benchConfig, configHash, fail, ledgerPath, loadConfig, loadData } from './common';

async function main(): Promise<number> {
    const config = loadConfig();
    const bench = benchConfig(config);
    let fake = false, concurrency = config.concurrency;
    const requested: string[] = [];
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') fake = true;
        else if (args[i] === '--concurrency') concurrency = Number(args[++i]);
        else if (args[i] === '--review') requested.push(args[++i]);
        else throw new BenchError('引数は --fake / --review CDxxxx / --concurrency N です。');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(config.retry.maxAttempts)
        || config.retry.maxAttempts < 1 || ![config.retry.baseDelayMs, config.retry.maxDelayMs].every(n => Number.isFinite(n) && n > 0)) {
        throw new BenchError('並列数または再試行設定が不正です。');
    }
    if (requested.some(id => !Object.prototype.hasOwnProperty.call(config.reviews, id))) throw new BenchError('指定レビューが設定にありません。');
    if (!fake && !process.env.TYPE_SAFE_API_KEY?.trim()) throw new BenchError('TYPE_SAFE_API_KEY を設定してください。');
    const reviews = Object.keys(config.reviews).filter(id => !requested.length || requested.includes(id));
    let exitCode = 0;
    for (const review of reviews) {
        const records = loadData(config, review);
        const hash = configHash(bench, review);
        const file = ledgerPath(config, fake, review);
        const { rows, brokenLines } = readLedger(file, hash, review);
        if (brokenLines) console.warn(`警告: ${review} の読めないレジャ行 ${brokenLines} 件を読み飛ばしました。`);
        let screen: Screen = fakeScreen;
        if (!fake) {
            const { screenViaTypeSafe } = await import('../../../src/lib/providers/typesafe');
            const prompt = screeningPrompt(bench, review);
            screen = record => screenViaTypeSafe({ title: record.title, abstract: record.abstract,
                screeningPrompt: prompt, model: config.model, outputLanguage: config.outputLanguage });
        }
        console.log(`レビュー開始: ${review}、対象 ${records.length} 件`);
        const code = await runRecords({ dataset: review, records, existing: rows, config: bench, hash,
            concurrency, fake, screen, append: row => appendLedger(file, row) });
        console.log(`レビュー終了: ${review}、終了コード ${code}`);
        if (code === 1 || code === 3) return code;
        if (code === 2) exitCode = 2;
    }
    return exitCode;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(fail);
