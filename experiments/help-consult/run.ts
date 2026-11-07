import dotenv from 'dotenv';
import path from 'path';
import { consultHelp } from '../../src/lib/help-consult/consult';
import { CONSULT_MODELS } from '../../src/lib/help-consult/model';
import { setSessionApiKey, setSessionOpenAiApiKey, setSessionOpenRouterApiKey } from '../../src/lib/storage';
import type { ConsultResult } from '../../src/lib/help-consult/types';
import { appendLedger, configHash, EvaluationError, isLedgerRow, loadConfig, loadQuestions,
    loadSections, readJsonLines, resultPath, rowKey } from './ledger';
import type { Provider } from './ledger';

function installFake(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const prompt = body.contents?.[0]?.parts?.[0]?.text ?? body.input?.[0]?.content
            ?? body.messages?.find((message: { role: string }) => message.role === 'user')?.content;
        if (typeof prompt !== 'string') throw new EvaluationError('偽リクエストの形式が不正です。');
        // 出力例と OpenRouter の末尾スキーマを避け、質問データの行を読む。
        const payload = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"question":')) ?? 'null');
        if (!payload?.sections?.length) throw new EvaluationError('偽リクエストに小節がありません。');
        const selection = Boolean(body.generationConfig?.responseSchema || body.text?.format)
            || payload.sections?.[0]?.id !== undefined;
        const text = selection ? JSON.stringify({ sectionIds: [payload.sections[0].id] }) : 'ヘルプの本文を確認してください。';
        if (body.contents) return new Response(JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        }));
        if (body.input) return new Response(JSON.stringify({
            status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        }));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
    };
    return () => { globalThis.fetch = original; };
}
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let selected: Provider | undefined;
    let fake = false, smoke = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fake') fake = true;
        else if (args[i] === '--smoke') smoke = true;
        else if (args[i] === '--provider' && ['gemini', 'openai', 'openrouter'].includes(args[i + 1])) {
            selected = args[++i] as Provider;
        } else throw new EvaluationError('引数が不正です。--provider <id>、--smoke、--fake を指定してください。');
    }
    const config = loadConfig(), allQuestions = loadQuestions(), sections = loadSections();
    const questions = smoke ? ['ja', 'en'].flatMap(lang =>
        allQuestions.filter(question => question.lang === lang).slice(0, config.smokeCount)) : allQuestions;
    if (!fake) dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
    const variables = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
    const setters = { gemini: setSessionApiKey, openai: setSessionOpenAiApiKey, openrouter: setSessionOpenRouterApiKey };
    const restoreFetch = fake ? installFake() : () => {};
    const stop = new AbortController();
    const onInterrupt = () => stop.abort();
    process.on('SIGINT', onInterrupt);
    let unsaved = 0;
    try {
        // どの社も送信する前に既存台帳の条件を照合する。
        const providers = config.providers.filter(provider => !selected || selected === provider);
        const ledgers = providers.map(provider => {
            const hash = configHash(provider), file = resultPath(config, provider, fake);
            return { provider, hash, file, rows: readJsonLines(file, isLedgerRow, hash) };
        });
        for (const { provider, hash, file, rows } of ledgers) {
            if (stop.signal.aborted) break;
            const key = fake ? 'fake-evaluation-key' : process.env[variables[provider]]?.trim();
            if (!key) { console.log(`${provider}: キーが無いためスキップ`); continue; }
            setters[provider](key);
            const pending = questions.filter(question => !rows.has(rowKey(question, provider, config.ledgerVersion)));
            console.log(`${provider}: 既存 ${questions.length - pending.length} 件をスキップ、未処理 ${pending.length} 件`);
            let processed = 0, success = 0, noMatch = 0, invalid = 0, failed = 0, auth = false;
            const progress = () => console.log(`${provider}: 処理 ${processed}/${pending.length} 件、success ${success}、no_match ${noMatch}、invalid_response ${invalid}、未保存 ${failed}`);
            for (const question of pending) {
                if (stop.signal.aborted || auth) break;
                const started = Date.now();
                let result: ConsultResult = { status: 'failure', kind: 'unknown' };
                for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt++) {
                    const controller = new AbortController();
                    let timedOut = false;
                    const onStop = () => controller.abort();
                    stop.signal.addEventListener('abort', onStop, { once: true });
                    if (stop.signal.aborted) controller.abort();
                    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
                    try {
                        result = await consultHelp({ question: question.question, lang: question.lang,
                            sections: sections[question.lang], providerId: provider, signal: controller.signal });
                        if (timedOut) result = { status: 'failure', kind: 'timeout' };
                    } finally {
                        clearTimeout(timer);
                        stop.signal.removeEventListener('abort', onStop);
                    }
                    if (result.status !== 'failure' || !['rate_limited', 'timeout', 'network', 'unknown'].includes(result.kind)
                        || attempt === config.retry.maxAttempts || stop.signal.aborted) break;
                    const delay = Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (attempt - 1));
                    console.log(`${provider}: ${result.kind}、${delay}ms 後に再試行（${attempt + 1}/${config.retry.maxAttempts}）`);
                    await new Promise<void>(resolve => {
                        const done = () => { clearTimeout(wait); stop.signal.removeEventListener('abort', done); resolve(); };
                        const wait = setTimeout(done, delay);
                        stop.signal.addEventListener('abort', done, { once: true });
                        if (stop.signal.aborted) done();
                    });
                }
                processed++;
                if (result.status === 'failure' && result.kind !== 'invalid_response') {
                    unsaved++; failed++;
                    if (result.kind === 'auth' || result.kind === 'no_key' || result.kind === 'unsupported_provider') {
                        auth = true;
                        console.log(`${provider}: ${result.kind} のため、この社の処理を停止`);
                    }
                } else {
                    if (result.status === 'success') {
                        // 応答に実キーが含まれた場合も、永続化しない。
                        for (const variable of Object.values(variables)) {
                            const secret = process.env[variable]?.trim();
                            if (secret) result.answer = result.answer.split(secret).join('[キーを伏せました]');
                        }
                        success++;
                    } else if (result.status === 'no_match') noMatch++;
                    else invalid++;
                    appendLedger(file, { key: rowKey(question, provider, config.ledgerVersion),
                        questionId: question.id, lang: question.lang, provider, model: CONSULT_MODELS[provider],
                        ...result, latencyMs: Date.now() - started, configHash: hash, at: new Date().toISOString() });
                }
                if (processed % 10 === 0) progress();
            }
            progress();
        }
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        restoreFetch();
        console.log(`保存しなかった失敗 ${unsaved} 件`);
    }
    if (stop.signal.aborted) process.exitCode = 130;
    else if (unsaved) process.exitCode = 2;
}
main().catch(error => {
    console.error(error instanceof EvaluationError ? error.message : '評価を停止しました。設定・入出力を確認してください。');
    process.exitCode = 1;
});