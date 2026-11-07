// ヘルプ相談の非ストリーム応答。外部通信をせず、渡された見出しだけを案内する。
export function buildDemoConsultResponse(body: {
    contents?: { parts?: { text?: string }[] }[];
    generationConfig?: { responseSchema?: unknown };
}): { candidates: { finishReason: string; content: { parts: { text: string }[] } }[] } {
    const prompt = body.contents?.flatMap(content => content.parts?.map(part => part.text ?? '') ?? []).join('\n') ?? '';
    let data: { question?: string; sections?: { id?: string; title?: string; when?: string[]; sectionTitle?: string }[] } = {};
    try {
        data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    } catch {
        // 想定外の入力では一致なしとして返す。
    }
    let text: string;
    if (body.generationConfig?.responseSchema) {
        const question = (data.question ?? '').normalize('NFKC').toLowerCase();
        const tokens = [...new Set(question.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu) ?? [])];
        const selected = (data.sections ?? []).map((section, index) => {
            const source = [section.title, section.sectionTitle, ...(section.when ?? [])].join(' ').normalize('NFKC').toLowerCase();
            return { id: section.id, index, score: tokens.filter(token => source.includes(token)).length };
        }).filter(item => item.id && item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 2);
        text = JSON.stringify({ sectionIds: selected.map(item => item.id) });
    } else {
        const titles = (data.sections ?? []).map(section => section.title).filter(Boolean).join(' / ');
        text = prompt.includes('日本語で答えてください')
            ? `「${titles}」のヘルプを開いて手順を確認してください。これはデモの回答です。`
            : `Open the help sections “${titles}” to check the steps. This is a demo answer.`;
    }
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] };
}
