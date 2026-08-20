// gemini-fulltext.ts - フルテキスト(PDF)を Gemini に渡して組み入れ/除外を判定するクライアント
//
// TiAb の screenReference（タイトル・抄録のテキスト判定）に対し、こちらは PDF バイト列を
// inline_data として丸ごと Gemini に渡す。Gemini はテキストPDF・スキャン(画像only)PDFの
// 双方をネイティブに読めるため、OCR を別途用意せずに本文判定ができる。
//
// 出力は FulltextJudgeOutput（decision / include_probability / reason / evidence[]）。
// evidence には quote（テキストマッチ用）と page、可能なら bbox（画像PDFのハイライト用）を含める。

import type {
    FulltextJudgeOutput,
    UsageMetadata,
    LlmModelResponseMetadata,
} from './types';
import {
    callGeminiApiWithParts,
    DEFAULT_MODEL_CONFIG,
    type GeminiModelConfig,
    type GeminiPart,
} from './gemini-api';
import { PROMPT_VERSION } from './prompt-templates';
import { DEFAULT_EXCLUDE_REASON_ITEMS } from './exclude-reasons';
import type { ExcludeReasonItem } from './exclude-reasons';
import { PdfTooLargeError } from './fulltext-ai-failures';

// inline_data でPDFを送る場合のサイズ上限（リクエスト全体が約20MB制限のため余裕を見て18MB）。
// これを超えるPDFは Files API 経由が必要だが、まずは inline で運用しガードする。
const MAX_INLINE_PDF_BYTES = 18 * 1024 * 1024;

/**
 * フルテキスト判定出力のJSONスキーマを組み立てる。
 *
 * exclude_reason_category の enum はプロジェクトの除外理由リスト（Config タブ
 * fulltext_exclude_reasons）から動的に作る。人が選ぶ選択肢とAIが返す区分を同じ土俵に
 * 乗せないと、PRISMA内訳や理由の不一致検出が食い違うため。
 */
function buildFulltextJudgeSchema(reasonItems: readonly ExcludeReasonItem[]) {
    return {
        type: 'object',
        properties: {
            decision: {
                type: 'string',
                enum: ['include', 'exclude', 'maybe'],
                description: 'フルテキストに基づく最終判定',
            },
            include_probability: {
                type: 'number',
                description: '組み入れになる確率（0-1）',
            },
            reason: {
                type: 'string',
                description: '判定理由。除外の場合はどの基準にどう外れたかを具体的に。',
            },
            exclude_reason_category: {
                type: 'string',
                enum: reasonItems.map(i => i.key),
                description: '除外時の区分（除外でない場合は省略可）。列挙順が優先順位（先頭ほど上位）。'
                    + '複数当てはまる場合は最も上位（番号の小さい）区分を1つだけ選ぶこと。',
            },
            evidence: {
                type: 'array',
                description: '判定根拠。本文から正確に抜粋し、ページ番号を必ず付ける。',
                items: {
                    type: 'object',
                    properties: {
                        quote: {
                            type: 'string',
                            description: '本文からの正確な抜粋（1〜2文）。原文の表記をそのまま。',
                        },
                        page: {
                            type: 'integer',
                            description: 'この抜粋が現れるPDFのページ番号（1始まり）',
                        },
                        bbox: {
                            type: 'array',
                            description: '抜粋箇所の正規化バウンディングボックス [left, top, right, bottom]（各0-1, ページ左上原点）。スキャン画像PDFでは必ず付ける。',
                            items: { type: 'number' },
                        },
                        polarity: {
                            type: 'string',
                            enum: ['include', 'exclude'],
                            description: '組み入れ寄りの根拠か除外寄りの根拠か',
                        },
                    },
                    required: ['quote', 'page'],
                },
            },
        },
        required: ['decision', 'include_probability', 'reason', 'evidence'],
    };
}

/**
 * フルテキスト判定用プロンプトを組み立てる。
 * screeningPrompt は TiAb と共通の組み入れ基準（PICO等）。ここにフルテキスト固有の指示を足す。
 *
 * @param reasonItems プロジェクトの除外理由リスト（並び＝優先順位）。人が選ぶ選択肢と
 *   同じものをAIにも提示する。省略時は既定のPICO7区分。
 */
export function buildFulltextPrompt(
    screeningPrompt: string,
    outputLanguage: string = 'ja',
    reasonItems: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): string {
    const lang = outputLanguage === 'ja' ? '日本語' : outputLanguage;
    // key（保存値）とラベルを併記する。key だけだとカスタム理由（r1 等）の意味が伝わらない。
    const reasonList = reasonItems.map(i => `${i.key}（${i.label}）`).join(' / ');
    return `${screeningPrompt}

## フルテキスト・スクリーニングの指示

あなたはシステマティックレビューのフルテキスト（全文）スクリーニングを行う専門家です。
添付されたPDFは1件の論文の全文です。タイトル・抄録だけでなく本文・方法・結果まで読み、
上記の組み入れ基準に照らして最終判定（include / exclude / maybe）を行ってください。

- **decision**: include（組み入れ）/ exclude（除外）/ maybe（判断保留）のいずれか
- **include_probability**: 組み入れになる確率（0.0〜1.0）
- **reason**: 判定の理由を${lang}で簡潔に。除外の場合は「どの基準（P/I/C/O/研究デザイン等）に、本文のどの記述で外れたか」を具体的に書く。
- **exclude_reason_category**: 除外の場合のみ、次の区分から1つ選ぶ（この順が優先順位）: ${reasonList}
  複数の区分に当てはまる場合は、最も上位（先に並んでいる）区分を1つだけ選ぶこと。値は括弧の前の英数字キーで返すこと。
- **evidence**: 判定の決め手になった本文の抜粋を2〜5件挙げる。
  - **quote**: 本文の原文をそのまま正確に抜粋する（改変・要約しない）。1〜2文程度。
  - **page**: その抜粋があるPDFのページ番号（1始まり）を必ず付ける。
  - **bbox**: 抜粋箇所の位置を正規化座標 [left, top, right, bottom]（各0〜1、ページ左上が原点）で示す。
    特にスキャンされた画像PDF（本文テキストを選択できない論文）では、ハイライト描画に必須なので必ず付ける。
  - **polarity**: その根拠が組み入れ方向(include)か除外方向(exclude)かを示す。

注意:
- quote は必ずPDF本文に実在する正確な文字列にする（ハイライト照合に使う）。
- 見出し・図表キャプション中の根拠も有効。その場合もページと位置を付ける。`;
}

/**
 * PDFバイト列を Gemini に渡してフルテキスト判定を得る。
 * @param pdfBytes PDFのバイト列
 * @param screeningPrompt 組み入れ基準を含むスクリーニングプロンプト
 * @param reasonItems プロジェクトの除外理由リスト（exclude_reason_category の候補）
 */
export async function judgeFulltext(
    pdfBytes: ArrayBuffer | Uint8Array,
    screeningPrompt: string,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    outputLanguage: string = 'ja',
    timeoutMs: number = 180000,
    reasonItems: readonly ExcludeReasonItem[] = DEFAULT_EXCLUDE_REASON_ITEMS
): Promise<{ output: FulltextJudgeOutput; usageMetadata: UsageMetadata; responseMetadata: LlmModelResponseMetadata }> {
    const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    if (bytes.byteLength > MAX_INLINE_PDF_BYTES) {
        // Gemini呼び出し（fetch）に至る前の、PDF側の検証失敗。GeminiApiError と見分けが付くように
        // 専用のエラークラスを投げる（分類は fulltext-ai-failures.ts の classifyFulltextAiFailure）。
        // UI表示に使うメッセージなので文言は変更しないこと。
        throw new PdfTooLargeError(`PDFが大きすぎます（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）。inline送信の上限は約18MBです。`);
    }

    const base64 = bytesToBase64(bytes);
    const parts: GeminiPart[] = [
        { text: buildFulltextPrompt(screeningPrompt, outputLanguage, reasonItems) },
        { inline_data: { mime_type: 'application/pdf', data: base64 } },
    ];

    const { result, usageMetadata, responseMetadata } = await callGeminiApiWithParts<FulltextJudgeOutput>(
        parts,
        buildFulltextJudgeSchema(reasonItems),
        config,
        timeoutMs
    );

    return { output: normalizeJudgeOutput(result), usageMetadata, responseMetadata };
}

/** 出力を軽く正規化する（範囲外確率のクランプ、evidence の page を整数化等） */
function normalizeJudgeOutput(raw: FulltextJudgeOutput): FulltextJudgeOutput {
    const prob = typeof raw.include_probability === 'number'
        ? Math.min(1, Math.max(0, raw.include_probability))
        : 0.5;
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter(e => e && typeof e.quote === 'string').map(e => ({
        quote: e.quote,
        page: Math.max(1, Math.round(Number(e.page) || 1)),
        bbox: normalizeBbox(e.bbox),
        polarity: e.polarity === 'exclude' ? 'exclude' as const : (e.polarity === 'include' ? 'include' as const : undefined),
    })) : [];
    const decision: FulltextJudgeOutput['decision'] =
        raw.decision === 'include' || raw.decision === 'exclude' || raw.decision === 'maybe'
            ? raw.decision
            : (prob >= 0.5 ? 'include' : 'exclude');
    return {
        decision,
        include_probability: prob,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        exclude_reason_category: raw.exclude_reason_category,
        evidence,
    };
}

/** bbox を [l,t,r,b] の4要素（0-1）に正規化。妥当でなければ undefined。 */
function normalizeBbox(bbox: unknown): [number, number, number, number] | undefined {
    if (!Array.isArray(bbox) || bbox.length < 4) return undefined;
    const nums = bbox.slice(0, 4).map(Number);
    if (nums.some(n => !Number.isFinite(n))) return undefined;
    // Gemini が 0-1000 スケールで返すことがあるため、1 を超える値があれば 1000 で割って正規化する。
    const maxV = Math.max(...nums);
    const scaled = maxV > 1.5 ? nums.map(n => n / 1000) : nums;
    if (scaled.some(n => n < 0 || n > 1)) return undefined;
    return [scaled[0], scaled[1], scaled[2], scaled[3]];
}

/** Uint8Array を base64 文字列へ（大きいPDF向けにチャンク処理） */
function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000; // 32KB ずつ（apply の引数上限回避）
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const sub = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, sub as unknown as number[]);
    }
    return btoa(binary);
}

export const FULLTEXT_PROMPT_VERSION = PROMPT_VERSION;
