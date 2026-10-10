// 同期追記の台帳と、途中で切れた末尾行の読み飛ばしを提供する。
import fs from 'node:fs';
import path from 'node:path';

export function appendJsonl(file, object) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 既存の部分行を残し、次の行と連結しないよう境界を補う。
    const prefix = endsWithNewline(file) ? '' : '\n\n';
    fs.appendFileSync(file, `${prefix}${JSON.stringify(object)}\n`, { encoding: 'utf8', flush: true });
}

/** 追記のたびに全体を読み直さないよう、末尾の1バイトだけを見る。無い・空のファイルは真。 */
function endsWithNewline(file) {
    if (!fs.existsSync(file)) {
        return true;
    }
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size === 0) {
            return true;
        }
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        return last[0] === 0x0a;
    } finally {
        fs.closeSync(fd);
    }
}

export function readJsonl(file) {
    const rows = [];
    Object.defineProperty(rows, 'skippedPartialLines', { value: 0, writable: true });
    if (!fs.existsSync(file)) {
        return rows;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) {
            continue;
        }
        try {
            rows.push(JSON.parse(lines[index]));
        } catch (error) {
            // 末尾の部分行と、追記時に空行で隔離された部分行だけを読み飛ばす。
            const trailing = lines.slice(index + 1).every((line) => !line.trim());
            const isolated = lines[index + 1] === '';
            if (trailing || isolated) {
                rows.skippedPartialLines++;
                continue;
            }
            throw new Error(`台帳の ${index + 1} 行目が不正: ${error.message}`);
        }
    }
    return rows;
}

export function compactByRefId(rows) {
    return [...new Map(rows.map((row) => [row.ref_id, row])).values()];
}

export function ledgerPaths(directory, conditionId) {
    const prefix = path.join(directory, `depression_${conditionId}`);
    return { items: `${prefix}_items.jsonl`, failures: `${prefix}_failures.jsonl`, raw: `${prefix}_raw.jsonl` };
}
