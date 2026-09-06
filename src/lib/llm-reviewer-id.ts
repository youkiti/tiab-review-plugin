/**
 * LLM判定用のreviewer_idを生成
 * 形式: llm:{model}@{timestamp}
 */
export function generateLlmReviewerId(model: string, timestamp: Date): string {
    return `llm:${model}@${timestamp.toISOString()}`;
}

