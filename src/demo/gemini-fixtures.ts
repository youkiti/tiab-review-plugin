// デモモード用 Gemini API 応答生成
//
// src/lib/gemini-api.ts の streamGenerateContent 呼び出し（screenReference）に対して、
// タイトル・抄録の内容から決定論的に include/exclude を判定した結果を返す。
// Config シートにシード済みの include_keywords（randomized, meta-analysis）/
// exclude_keywords（case report, protocol）と同じ語で判定することで、
// AIタブのデモが「もっともらしい」判定になるようにしている（Math.random は使わない）。

import type { LlmEvidence } from '../lib/types';

/** モデル一覧（testApiKeyWithTier が「5件超 = 有料枠」と判定できるよう6件以上返す） */
const DEMO_MODEL_NAMES = [
    'models/gemini-3.1-flash-lite',
    'models/gemini-3-flash-preview',
    'models/gemini-3.5-flash',
    'models/gemini-2.5-flash',
    'models/gemini-2.5-flash-lite',
    'models/gemini-2.5-pro',
    'models/gemini-1.5-pro',
    'models/gemini-1.5-flash',
];

export function buildDemoModelsListBody(): { models: { name: string }[] } {
    return { models: DEMO_MODEL_NAMES.map((name) => ({ name })) };
}

const INCLUDE_KEYWORDS = ['randomized', 'meta-analysis'];
const EXCLUDE_KEYWORDS = ['case report', 'protocol'];

/** 文字列から安定した非負整数を得るだけの単純ハッシュ（Math.random の代替、確率の微調整用） */
function stableHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
}

/**
 * screenReference() が組み立てるプロンプト本文からタイトル・抄録部分だけを抜き出す。
 * 抽出に失敗した場合は空文字を返す（呼び出し側は中立判定にフォールバックする）。
 */
function extractTitleAndAbstract(promptText: string): { title: string; abstract: string } {
    const titleMatch = /\*\*タイトル:\*\*\n([\s\S]*?)\n\n\*\*抄録:\*\*/.exec(promptText);
    const abstractMatch = /\*\*抄録:\*\*\n([\s\S]*?)\n\n## 出力指示/.exec(promptText);
    return {
        title: titleMatch ? titleMatch[1].trim() : '',
        abstract: abstractMatch ? abstractMatch[1].trim() : '',
    };
}

/** キーワードが実際に見つかった field（title/abstract）内の正確な部分文字列を証拠として返す */
function buildEvidence(keyword: string, title: string, abstract: string): LlmEvidence[] {
    const idxInTitle = title.toLowerCase().indexOf(keyword);
    if (idxInTitle !== -1) {
        return [{
            field: 'title',
            quote: title.slice(idxInTitle, idxInTitle + keyword.length),
            start_char: idxInTitle,
            end_char: idxInTitle + keyword.length,
        }];
    }
    const idxInAbstract = abstract.toLowerCase().indexOf(keyword);
    if (idxInAbstract !== -1) {
        return [{
            field: 'abstract',
            quote: abstract.slice(idxInAbstract, idxInAbstract + keyword.length),
            start_char: idxInAbstract,
            end_char: idxInAbstract + keyword.length,
        }];
    }
    return [];
}

interface ScreeningJudgement {
    include_probability: number;
    reasons: string[];
    evidence: LlmEvidence[];
}

/** タイトル・抄録の内容から判定結果を決定論的に組み立てる */
function judgeReference(title: string, abstract: string): ScreeningJudgement {
    const combined = `${title} ${abstract}`.toLowerCase();
    // 0.00-0.05 の範囲でわずかにばらつかせる（同じ入力なら常に同じ値になる決定論的ジッター）
    const jitter = (stableHash(title || abstract || 'demo') % 6) / 100;

    const includeHit = INCLUDE_KEYWORDS.find((k) => combined.includes(k));
    if (includeHit) {
        return {
            include_probability: Math.min(0.97, 0.88 + jitter),
            reasons: ['タイトルまたは抄録に無作為化比較試験やメタアナリシスを示す語が含まれており、組み入れ基準に合致する可能性が高いと判断しました。'],
            evidence: buildEvidence(includeHit, title, abstract),
        };
    }

    const excludeHit = EXCLUDE_KEYWORDS.find((k) => combined.includes(k));
    if (excludeHit) {
        return {
            include_probability: Math.max(0.02, 0.1 - jitter),
            reasons: ['症例報告または研究プロトコルであり、効果を検証する比較研究ではないため除外候補と判断しました。'],
            evidence: buildEvidence(excludeHit, title, abstract),
        };
    }

    return {
        include_probability: 0.45 + jitter,
        reasons: ['タイトル・抄録から組み入れ・除外いずれの基準にも明確には合致しないため、中間的な確率としました。'],
        evidence: [],
    };
}

/**
 * streamGenerateContent のレスポンスボディ（JSON配列を文字列化したもの）を組み立てる。
 * callGeminiApiWithParts はこの文字列全体を1つの ReadableStream として読み取り、
 * JSON.parse() で配列にパースしたうえで各要素の candidates[0].content.parts[].text を連結する。
 * ここでは要素1件のみの配列で完結させている（実際のチャンク分割を模す必要はないため）。
 */
export function buildStreamGenerateContentResponseText(requestBody: any, modelId: string): string {
    const parts = requestBody?.contents?.[0]?.parts;
    const promptText: string = Array.isArray(parts)
        ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
        : '';
    const { title, abstract } = extractTitleAndAbstract(promptText);
    const judgement = judgeReference(title, abstract);

    const responseId = `demo-resp-${stableHash(promptText).toString(16)}`;
    const chunk = {
        candidates: [{
            content: { parts: [{ text: JSON.stringify(judgement) }] },
            finishReason: 'STOP',
        }],
        usageMetadata: {
            promptTokenCount: Math.max(1, Math.round(promptText.length / 4)),
            candidatesTokenCount: 64,
            thoughtsTokenCount: 0,
            totalTokenCount: Math.max(1, Math.round(promptText.length / 4)) + 64,
        },
        modelVersion: modelId,
        responseId,
    };
    return JSON.stringify([chunk]);
}
