/**
 * Gemini implicit caching の最小プレフィックス長（閾値）を実測するスクリプト。
 *
 * 背景: 本ディレクトリの実験（runner.ts / summarize.ts / config.json / prompts/）は
 * 「implicit caching でスクリーニングコストが下がるか」を検証する予定だったが、
 * 実行前の事前計測で「原理的に成立しない」ことが判明したため撤去した
 * （詳細: report.md）。このスクリプトはその報告の中心的な主張である
 * 「キャッシュヒットが現れる閾値は約6,400トークン付近」を再現するための
 * 計測専用スクリプトで、判定精度（Recall等）の評価は行わない。
 *
 * 手法: 共有プレフィックスの長さを --targets で指定した目標トークン数に近づけて
 * 生成し、各長さについて「同一プレフィックス」のリクエストを --repeats 件
 * 逐次送信する。1件目は cache miss になりうるが、2件目以降で
 * usageMetadata.cachedContentTokenCount が立ち上がるかを見ることで、
 * implicit caching が効き始める境界を特定する。
 *
 * 実行例:
 *   npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
 *     experiments/gemini-prompt-cache/measure-cache-threshold.ts
 *   npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json \
 *     experiments/gemini-prompt-cache/measure-cache-threshold.ts --model gemini-3.1-flash-lite --targets 6000,8000 --repeats 3
 */
import dotenv from 'dotenv';
import path from 'path';

// プロジェクトルートから .env を読み込む（GEMINI_API_KEY）
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 1トークンあたりのおおよその文字数。プレフィックスの文字数を狙う長さに切り詰める際の目安。
// 正確な長さは実測の promptTokenCount をそのまま記録するので、多少のズレは問題にならない。
const CHARS_PER_TOKEN_ESTIMATE = 5.2;

// ============================================================
// 共有プレフィックス（スクリーニングガイダンス風の英文）
// ============================================================
// prompts/ ディレクトリは撤去したため、このスクリプト単体で完結するように
// フィラー段落をここに埋め込み、目標長に達するまで繰り返す。
const GUIDANCE_PARAGRAPH = `You are an expert screener for a systematic review, performing title-and-abstract (TiAb) screening. Sensitivity is paramount: missing a relevant study (a false negative) damages the validity of the entire review and cannot be repaired later, whereas including an irrelevant study merely costs a few minutes of full-text reading. If you are unsure whether a record meets the criteria, or if the abstract does not report enough detail to verify a criterion, you must lean toward inclusion. Watch for homonym traps where a keyword from the criteria appears in a different technical sense (for example respiratory depression versus depressive disorder), and read the surrounding context before crediting or discounting such a term. Distinguish primary research from non-primary material such as narrative reviews, editorials, letters without data, and conference announcements, but apply this distinction leniently when the abstract is ambiguous. Structured abstracts usually state the study design and population in the Methods sentence; unstructured abstracts may bury the design mid-paragraph or leave it implicit in verb choices. Numeric details such as group sizes, doses, and durations are strong signals of primary research even when the design is never named explicitly in the text. `;

/**
 * 目標トークン数に近い共有プレフィックスを生成する（文字数ベースの概算）。
 *
 * 注意: 同じ GUIDANCE_PARAGRAPH を繰り返して先頭から targetChars で切り詰めて
 * いるため、短い targetTokens で生成したプレフィックスは、長い targetTokens で
 * 生成したプレフィックスの先頭部分と完全に一致する。つまり --targets に複数の
 * 長さを渡して昇順に流すと、後続（長い方）のターゲットは前方部分がすでに
 * リクエスト済み＝温まった状態でヒット判定を受けることになり、各ターゲットは
 * 独立した試行ではない。閾値付近より短いターゲットを先に流した場合、閾値を
 * 超えるターゲットは1件目からヒットして見えることがある（report.md 3.2 節参照）。
 */
function buildSharedPrefix(targetTokens: number): string {
    const targetChars = Math.round(targetTokens * CHARS_PER_TOKEN_ESTIMATE);
    let text = '';
    while (text.length < targetChars) {
        text += GUIDANCE_PARAGRAPH;
    }
    return text.slice(0, targetChars);
}

// ============================================================
// データセット読み込み
// ============================================================
interface DatasetRecord {
    id?: string;
    ref_id?: string;
    title?: string;
    abstract?: string;
}

function loadReferences(count: number): Array<{ id: string; title: string; abstract: string }> {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const datasetPath = path.join(projectRoot, 'scripts', 'asreview-baseline', 'datasets', 'depression_slim_labeled.json');
    const raw = fs.readFileSync(datasetPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const records: DatasetRecord[] = Array.isArray(parsed) ? parsed : parsed.records;
    return records.slice(0, count).map((r, i) => ({
        id: r.id || r.ref_id || `record-${i}`,
        title: r.title || '',
        abstract: r.abstract || '',
    }));
}

// ============================================================
// プロンプト組み立て（本番 screenReference() の順序に合わせる:
// 共有プレフィックス → 対象文献 → 出力指示）
// ============================================================
function buildPrompt(sharedPrefix: string, ref: { title: string; abstract: string }): string {
    return `${sharedPrefix}

## 対象文献

**タイトル:**
${ref.title}

**抄録:**
${ref.abstract || '(抄録なし)'}

## 出力指示
- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力
- reasons: 判断理由を短文配列で出力`;
}

/** 計測に必要な最小限の出力スキーマ（本番の SCREENING_OUTPUT_SCHEMA を簡略化） */
const MINIMAL_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        include_probability: { type: 'number' },
        reasons: { type: 'array', items: { type: 'string' } },
    },
    required: ['include_probability', 'reasons'],
};

// ============================================================
// Gemini API 呼び出し（generateContent, 非ストリーミング）
// ============================================================
interface CallResult {
    promptTokenCount: number;
    cachedContentTokenCount: number;
    totalTokenCount: number;
}

/**
 * APIキーは x-goog-api-key ヘッダで渡す（?key= クエリは使わない）。
 * エラー時のスタックトレース・ログに URL がそのまま出るとキーが漏れるため
 * （AGENTS.md CRITICAL PROTOCOL 9）、この関数は例外発生時も URL を一切ログ出力しない。
 */
async function callGenerateContent(model: string, apiKey: string, prompt: string): Promise<CallResult> {
    const url = `${GEMINI_API_BASE}/${model}:generateContent`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: MINIMAL_OUTPUT_SCHEMA,
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
    });

    const json: any = await response.json().catch(() => undefined);

    if (!response.ok) {
        // エラーメッセージのみ使用し、URL・キーはログに含めない
        const message = json?.error?.message || response.statusText;
        throw new Error(`HTTP ${response.status}: ${message}`);
    }

    const usage = json?.usageMetadata || {};
    return {
        promptTokenCount: usage.promptTokenCount || 0,
        cachedContentTokenCount: usage.cachedContentTokenCount || 0,
        totalTokenCount: usage.totalTokenCount || 0,
    };
}

// ============================================================
// CLI引数
// ============================================================
interface Args {
    model: string;
    targets: number[];
    repeats: number;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const raw: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const value = argv[i + 1];
            if (value && !value.startsWith('--')) {
                raw[key] = value;
                i++;
            }
        }
    }
    return {
        model: raw.model || 'gemini-3.1-flash-lite',
        targets: (raw.targets || '3000,3600,4000,4300,5000,6000,8000').split(',').map(s => parseInt(s.trim(), 10)),
        repeats: raw.repeats ? parseInt(raw.repeats, 10) : 3,
    };
}

// ============================================================
// 結果の型
// ============================================================
interface AttemptResult {
    index: number;
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    error?: string;
}

interface TargetResult {
    targetTokens: number;
    sharedPrefixChars: number;
    attempts: AttemptResult[];
}

interface RunResult {
    model: string;
    repeats: number;
    startedAt: string;
    finishedAt: string;
    targets: TargetResult[];
}

// ============================================================
// メイン処理
// ============================================================
async function main(): Promise<void> {
    const args = parseArgs();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('GEMINI_API_KEY が .env に見つかりません。プロジェクトルートの .env を確認してください。');
        process.exit(1);
    }

    const references = loadReferences(args.repeats);
    if (references.length < args.repeats) {
        console.error(`データセットの件数 (${references.length}) が --repeats (${args.repeats}) に足りません。`);
        process.exit(1);
    }

    console.log(`=== Gemini implicit caching 閾値計測: model=${args.model}, targets=${args.targets.join(',')}, repeats=${args.repeats} ===`);

    const runResult: RunResult = {
        model: args.model,
        repeats: args.repeats,
        startedAt: new Date().toISOString(),
        finishedAt: '',
        targets: [],
    };

    for (const targetTokens of args.targets) {
        const sharedPrefix = buildSharedPrefix(targetTokens);
        const attempts: AttemptResult[] = [];

        console.log(`\n--- 目標プレフィックス長: ${targetTokens} トークン (${sharedPrefix.length} chars) ---`);

        for (let i = 0; i < args.repeats; i++) {
            const ref = references[i];
            const prompt = buildPrompt(sharedPrefix, ref);
            try {
                const result = await callGenerateContent(args.model, apiKey, prompt);
                attempts.push({
                    index: i,
                    promptTokenCount: result.promptTokenCount,
                    cachedContentTokenCount: result.cachedContentTokenCount,
                });
                console.log(`  #${i + 1}: promptTokenCount=${result.promptTokenCount}, cachedContentTokenCount=${result.cachedContentTokenCount}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                attempts.push({ index: i, error: message });
                console.log(`  #${i + 1}: ERROR - ${message}`);
                // 1件失敗しても残りは続行する（総リクエスト数が少ないため再開機構は設けない）
            }
        }

        runResult.targets.push({
            targetTokens,
            sharedPrefixChars: sharedPrefix.length,
            attempts,
        });
    }

    runResult.finishedAt = new Date().toISOString();

    // 結果表示（表形式）
    console.log('\n=== 結果サマリー ===');
    console.log('目標トークン数 | promptTokenCount | cachedContentTokenCount');
    for (const t of runResult.targets) {
        const prompts = t.attempts.map(a => a.promptTokenCount ?? 'ERR').join(' / ');
        const cached = t.attempts.map(a => a.cachedContentTokenCount ?? 'ERR').join(' / ');
        console.log(`${t.targetTokens} | ${prompts} | ${cached}`);
    }

    // 結果保存
    const resultsDir = path.join(__dirname, 'results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }
    const outPath = path.join(resultsDir, `cache-threshold_${runResult.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outPath, JSON.stringify(runResult, null, 2));
    console.log(`\n結果を保存しました: ${outPath}`);
}

main().catch(error => {
    // エラーメッセージのみ出力し、リクエストURLは出力しない
    console.error('計測失敗:', error instanceof Error ? error.message : error);
    process.exit(1);
});
