// 判定 CSV の検査は認証と通信より先に完了させる。
import type { Decision, Reference } from '../lib/types';

export class InputError extends Error {}
export interface DecisionInput {
    pmid: string;
    doi: string;
    reviewer_id: string;
    decision: 'include' | 'exclude' | 'maybe';
    note: string;
    decided_at: string;
}

/** 引用符内の改行・カンマ・二重引用符を保持する。 */
function csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let closed = false;
    const source = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (quoted) {
            if (c === '"') {
                if (source[i + 1] === '"') { field += '"'; i++; }
                else { quoted = false; closed = true; }
            } else field += c;
        } else if (c === ',' || c === '\n' || c === '\r') {
            row.push(field); field = ''; closed = false;
            if (c !== ',') {
                if (c === '\r' && source[i + 1] === '\n') i++;
                if (row.some(value => value !== '')) rows.push(row);
                row = [];
            }
        } else if (c === '"' && !field && !closed) quoted = true;
        else {
            if (closed || c === '"') throw new InputError('CSV の引用符が不正です。');
            field += c;
        }
    }
    if (quoted) throw new InputError('CSV の引用符が閉じていません。');
    row.push(field);
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
}

export function parseDecisionCsv(content: string): DecisionInput[] {
    const [headers, ...rows] = csvRows(content);
    if (!headers || new Set(headers).size !== headers.length ||
        !['reviewer_id', 'decision', 'note', 'decided_at'].every(h => headers.includes(h)) ||
        !headers.some(h => h === 'pmid' || h === 'doi')) {
        throw new InputError('CSV に pmid または doi と reviewer_id, decision, note, decided_at の見出しが必要です（見出しの重複は不可）。');
    }
    if (!rows.length) throw new InputError('CSV に判定行がありません。');
    const seen = new Set<string>();
    return rows.map((row, index) => {
        const fail = (message: string): never => { throw new InputError(`CSV ${index + 2} 行目: ${message}`); };
        if (row.length !== headers.length) fail('列数が見出しと一致しません。');
        const values = Object.fromEntries(headers.map((header, i) => [header, row[i]]));
        const pmid = (values.pmid ?? '').trim();
        const doi = (values.doi ?? '').trim();
        if (!pmid && !doi) fail('pmid または doi が必要です。');
        const reviewer = values.reviewer_id;
        if (reviewer !== reviewer.toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewer)) fail('reviewer_id は小文字のメールアドレスで指定してください。');
        if (!['include', 'exclude', 'maybe'].includes(values.decision)) fail('decision は include / exclude / maybe です。');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(values.decided_at) || !Number.isFinite(Date.parse(values.decided_at))) fail('decided_at はタイムゾーン付き ISO 8601 で指定してください。');
        for (const [kind, id] of [['pmid', pmid], ['doi', doi]]) {
            if (!id) continue;
            const key = JSON.stringify([kind, id, reviewer]);
            if (seen.has(key)) fail('同じ文献・判定者が重複しています。');
            seen.add(key);
        }
        return { pmid, doi, reviewer_id: reviewer, decision: values.decision as DecisionInput['decision'], note: values.note, decided_at: values.decided_at };
    });
}

export function decisionCsvSummary(rows: DecisionInput[]) {
    const reviewers: Record<string, { include: number; exclude: number; maybe: number; notes: number }> = {};
    for (const row of rows) {
        const counts = reviewers[row.reviewer_id] ??= { include: 0, exclude: 0, maybe: 0, notes: 0 };
        counts[row.decision]++;
        if (row.note.trim()) counts.notes++;
    }
    return { rows: rows.length, references: new Set(rows.map(r => r.pmid ? `pmid:${r.pmid}` : `doi:${r.doi}`)).size,
        reviewers, notes: rows.filter(r => r.note.trim()).length };
}

/** 照合不能・曖昧な識別子と、別の識別子で指定された同一文献の重複も拒否する。 */
export function resolveDecisionInputs(rows: DecisionInput[], references: Reference[], existing: Decision[]) {
    const seen = new Set<string>();
    return rows.map((row, index) => {
        const matches = references.filter(ref => (!row.pmid || ref.pmid === row.pmid) && (!row.doi || ref.doi === row.doi));
        if (matches.length !== 1) throw new InputError(`CSV ${index + 2} 行目: References の pmid / doi と一意に照合できません。`);
        const ref_id = matches[0].ref_id;
        const key = JSON.stringify([ref_id, row.reviewer_id]);
        if (seen.has(key)) throw new InputError(`CSV ${index + 2} 行目: 同じ文献・判定者が重複しています。`);
        seen.add(key);
        if (existing.some(d => d.ref_id === ref_id && d.reviewer_id === row.reviewer_id)) {
            throw new InputError(`CSV ${index + 2} 行目: 同じ文献・判定者の人の判定が既にあります。`);
        }
        return { ...row, ref_id };
    });
}
