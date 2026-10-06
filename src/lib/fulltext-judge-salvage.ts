import type { FulltextJudgeOutput } from './types';

/**
 * evidence 配列の途中で打ち切られたフルテキスト判定の JSON から、完結している部分を取り出す。
 * 取り出せなければ null。
 */
export function salvageTruncatedFulltextJudge(partialText: string): FulltextJudgeOutput | null {
    let pos = 0;
    let evidenceOpen = false;
    let cut = -1;
    const incomplete = Symbol('incomplete');
    const invalid = Symbol('invalid');
    const whitespace = () => {
        while (/[\t\n\r ]/.test(partialText[pos] ?? '\0')) pos++;
    };
    const peek = (): string => {
        whitespace();
        if (pos === partialText.length) throw incomplete;
        return partialText[pos];
    };
    const expect = (char: string) => {
        if (peek() !== char) throw invalid;
        pos++;
    };
    const string = (): string => {
        expect('"');
        const start = pos - 1;
        while (pos < partialText.length) {
            const char = partialText[pos++];
            if (char === '"') return JSON.parse(partialText.slice(start, pos)) as string;
            if (char.charCodeAt(0) < 32) throw invalid;
            if (char !== '\\') continue;
            if (pos === partialText.length) throw incomplete;
            const escaped = partialText[pos++];
            if (escaped === 'u') {
                for (let i = 0; i < 4; i++) {
                    if (pos === partialText.length) throw incomplete;
                    if (!/[0-9a-fA-F]/.test(partialText[pos++])) throw invalid;
                }
            } else if (!'"\\/bfnrt'.includes(escaped)) throw invalid;
        }
        throw incomplete;
    };
    const value = (depth: number, isEvidence = false): void => {
        // 異常な深さの入力は、呼び出しスタックを消費せず不採用にする。
        if (depth > 100) throw invalid;
        const char = peek();
        if (char === '"') { string(); return; }
        if (char === '{') {
            pos++;
            const keys = new Set<string>();
            if (peek() === '}') { pos++; return; }
            while (true) {
                const key = string();
                if (keys.has(key)) throw invalid;
                keys.add(key);
                expect(':');
                value(depth + 1, depth === 0 && key === 'evidence');
                if (peek() === '}') { pos++; return; }
                expect(',');
            }
        }
        if (char === '[') {
            pos++;
            if (isEvidence) { evidenceOpen = true; cut = pos; }
            if (peek() === ']') {
                pos++;
                if (isEvidence) evidenceOpen = false;
                return;
            }
            while (true) {
                value(depth + 1);
                if (isEvidence) cut = pos;
                if (peek() === ']') {
                    pos++;
                    if (isEvidence) evidenceOpen = false;
                    return;
                }
                expect(',');
            }
        }
        const start = pos;
        while (pos < partialText.length && !/[\t\r\n ,\]}]/.test(partialText[pos])) pos++;
        const token = partialText.slice(start, pos);
        if (pos === partialText.length) {
            // 数字やリテラルの途中かを確認し、不正な末尾を打ち切りと誤認しない。
            if (['true', 'false', 'null'].some(literal => literal.startsWith(token))
                || token === '-' || /^-?(?:0|[1-9]\d*)(?:\.\d*)?$/.test(token)
                || /^-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?\d*$/.test(token)) throw incomplete;
            throw invalid;
        }
        if (!token) throw invalid;
        JSON.parse(token);
    };

    try {
        if (peek() !== '{') return null;
        value(0);
        return null;
    } catch (err) {
        if (err !== incomplete || !evidenceOpen || cut < 0) return null;
    }
    try {
        const parsed: unknown = JSON.parse(partialText.slice(0, cut) + ']}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const output = parsed as Record<string, unknown>;
        if (!['include', 'exclude', 'maybe'].includes(String(output.decision))
            || typeof output.decision !== 'string'
            || typeof output.include_probability !== 'number' || !Number.isFinite(output.include_probability)
            || typeof output.reason !== 'string' || !Array.isArray(output.evidence)) return null;
        return output as unknown as FulltextJudgeOutput;
    } catch {
        return null;
    }
}
