/**
 * Model B テスト用スクリプト
 * 単一のAPI呼び出しで生のレスポンスを確認する
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('GEMINI_API_KEY not set');
        process.exit(1);
    }

    const model = 'gemini-3-flash-preview';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const testTitle = 'Effects of antidepressant drugs on depression in rats';
    const testAbstract = 'This study investigated the effects of fluoxetine on depression-like behavior in a rat model of depression. Sprague-Dawley rats were subjected to chronic mild stress (CMS) for 4 weeks. Animals were treated with fluoxetine (10 mg/kg) or vehicle for 3 weeks. Depression-like behavior was assessed using the forced swim test and sucrose preference test. Results showed that fluoxetine significantly reduced immobility time and increased sucrose preference compared to vehicle-treated CMS rats.';

    const screeningPrompt = `You are a screener for a systematic review.

## Inclusion Criteria
Include studies on in vivo models of depression (Animal studies).
Exclude human studies.
Exclude studies where 'depression' refers to respiratory depression, cardiac depression, etc.

Include studies that meet the inclusion criteria.
Exclude studies that do not meet the criteria or are clearly irrelevant.`;

    const prompt = `${screeningPrompt}

## 対象文献

**タイトル:**
${testTitle}

**抄録:**
${testAbstract}

## 出力指示
- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力
- reasons: 判断理由を日本語で短文配列で出力
- evidence: タイトルまたは抄録から判断根拠となる部分を正確に抜粋（quote）し、その開始位置（start_char）と終了位置（end_char）を指定

注意: quoteはtitleまたはabstract内の正確な部分文字列でなければなりません。`;

    const requestBody = {
        contents: [
            {
                parts: [{ text: prompt }],
            },
        ],
        generationConfig: {
            temperature: 0.7,
            topP: 0.65,
            // thinkingConfig を試す
            thinkingConfig: { includeThoughts: true },
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'object',
                properties: {
                    include_probability: { type: 'number' },
                    reasons: { type: 'array', items: { type: 'string' } },
                    evidence: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                quote: { type: 'string' },
                                start_char: { type: 'integer' },
                                end_char: { type: 'integer' },
                            },
                        },
                    },
                },
                required: ['include_probability', 'reasons', 'evidence'],
            },
        },
    };

    console.log('=== Request ===');
    console.log('Model:', model);
    console.log('URL:', url.replace(apiKey, '***'));

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        console.log('\n=== Response Status ===');
        console.log('Status:', response.status, response.statusText);

        const data = await response.json();

        console.log('\n=== Raw Response ===');
        console.log(JSON.stringify(data, null, 2));

        // Extract ALL parts from response
        const parts = data.candidates?.[0]?.content?.parts;
        if (parts && Array.isArray(parts)) {
            console.log(`\n=== Found ${parts.length} parts ===`);
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                console.log(`\n--- Part ${i} ---`);
                if (part.thought) {
                    console.log('Type: THOUGHT');
                    console.log(part.thought.substring(0, 200) + '...');
                }
                if (part.text) {
                    console.log('Type: TEXT');
                    console.log(part.text.substring(0, 500));

                    // Try to parse as JSON
                    try {
                        const parsed = JSON.parse(part.text);
                        console.log('\n=== Parsed JSON from Part ===');
                        console.log(JSON.stringify(parsed, null, 2));
                    } catch (e) {
                        console.log('Not valid JSON, trying regex...');
                        const jsonMatch = part.text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const extracted = JSON.parse(jsonMatch[0]);
                                console.log('\n=== Extracted JSON ===');
                                console.log(JSON.stringify(extracted, null, 2));
                            } catch (e2) {
                                console.log('Regex extraction also failed');
                            }
                        }
                    }
                }
            }
        } else {
            // Fallback to old logic
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                console.log('\n=== Extracted Text ===');
                console.log(text);

                // Try to parse as JSON
                try {
                    const parsed = JSON.parse(text);
                    console.log('\n=== Parsed JSON ===');
                    console.log(JSON.stringify(parsed, null, 2));
                } catch (e) {
                    console.log('\n=== JSON Parse Error ===');
                    console.log('Direct parse failed. Trying to extract JSON...');

                    // Try regex extraction
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            const extracted = JSON.parse(jsonMatch[0]);
                            console.log('\n=== Extracted JSON ===');
                            console.log(JSON.stringify(extracted, null, 2));
                        } catch (e2) {
                            console.log('Regex extraction also failed');
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Request failed:', error);
    }
}

main();
