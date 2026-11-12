// 評価結果の公開物を作る純関数群（Issue #307）。git や出力先のファイル操作は pack.mjs に置く。
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync, gunzipSync } from 'node:zlib';

/** evidence の要素に残す項目。抄録の原文（quote）は残さず、位置だけを残す。 */
const EVIDENCE_KEEP = ['field', 'start_char', 'end_char'];

/** 値の中の evidence の quote を取り除く。JSON を文字列で持つ値は、解釈できれば中を同じ規則で処理して戻す。 */
export function stripQuotes(value) {
    if (typeof value === 'string') {
        const trimmed = value.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return JSON.stringify(stripQuotes(JSON.parse(value)));
            } catch {
                return value;
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(stripQuotes);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            if (key === 'quote') continue;
            if (key === 'evidence' && Array.isArray(inner)) {
                out[key] = inner.map((item) => {
                    if (!item || typeof item !== 'object' || Array.isArray(item)) return stripQuotes(item);
                    return Object.fromEntries(EVIDENCE_KEEP.filter((k) => k in item).map((k) => [k, item[k]]));
                });
                continue;
            }
            out[key] = stripQuotes(inner);
        }
        return out;
    }
    return value;
}

/** ファイルの種類ごとに処理を決める。ソースコードは結果データではないので手を入れない。 */
const CODE_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.py']);
export function extensionOf(path) {
    const match = /(\.[A-Za-z0-9]+)$/.exec(path);
    return match ? match[1].toLowerCase() : '';
}

/** .bak は JSONL の退避なので .jsonl と同じに扱う。 */
function dataKind(path) {
    const base = path.replace(/\.bak$/i, '');
    const ext = extensionOf(base);
    if (ext === '.json') return 'json';
    if (ext === '.jsonl') return 'jsonl';
    return null;
}

/** バイト列を処理して返す。JSON・JSONL は quote を除いて書き戻し、それ以外はそのまま返す。 */
export function sanitizeFile(path, bytes) {
    const kind = dataKind(path);
    if (!kind) return bytes;
    const text = bytes.toString('utf8');
    if (kind === 'json') {
        const trailing = text.endsWith('\n') ? '\n' : '';
        const indented = /^\s*[\[{]\s*\n/.test(text);
        const parsed = stripQuotes(JSON.parse(text));
        return Buffer.from((indented ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)) + trailing, 'utf8');
    }
    const lines = text.split('\n').map((line) => {
        if (!line.trim()) return line;
        return JSON.stringify(stripQuotes(JSON.parse(line)));
    });
    return Buffer.from(lines.join('\n'), 'utf8');
}

/** 処理後のファイルに quote が残っていれば、その理由を返す（無ければ null）。ソースコードは対象外。 */
export function findLeftoverQuote(path, bytes) {
    const ext = extensionOf(path.replace(/\.bak$/i, ''));
    if (CODE_EXTENSIONS.has(ext)) return null;
    const buffer = ext === '.gz' ? gunzipSync(bytes) : bytes;
    const text = buffer.toString('utf8');
    if (text.includes('"quote"') || text.includes('\\"quote\\"')) {
        return `${path}: "quote" が残っています`;
    }
    return null;
}

export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** ファイル名とファイル内の項目から model・dataset・run_date を取る。取れないものは空文字。 */
export function inferMeta(path, bytes) {
    const base = path.split('/').pop();
    const meta = { model: '', dataset: '', run_date: '' };
    const date = /(\d{4}-\d{2}-\d{2})/.exec(base);
    if (date) meta.run_date = date[1];
    const titan = /^(CD\d+)_(jev-[\d.]+)_/.exec(base);
    if (titan) {
        meta.dataset = titan[1];
        meta.model = titan[2];
        return meta;
    }
    const kind = dataKind(path);
    if (!kind) return meta;
    let first;
    try {
        const text = bytes.toString('utf8');
        first = kind === 'json' ? JSON.parse(text) : JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')));
    } catch {
        return meta;
    }
    if (Array.isArray(first)) first = first[0];
    const decision = first && typeof first === 'object' ? (first.decision && typeof first.decision === 'object' ? first.decision : first) : null;
    if (decision && typeof decision.reviewer_id === 'string' && decision.reviewer_id.startsWith('llm:')) {
        const body = decision.reviewer_id.slice(4);
        const at = body.lastIndexOf('@');
        if (at > 0) {
            meta.model = body.slice(0, at);
            if (!meta.run_date) {
                const stamp = /^(\d{4}-\d{2}-\d{2})/.exec(body.slice(at + 1));
                if (stamp) meta.run_date = stamp[1];
            }
        } else {
            meta.model = body;
        }
    }
    const refId = decision && typeof decision.ref_id === 'string' ? decision.ref_id : first && typeof first.ref_id === 'string' ? first.ref_id : '';
    const dataset = /^(.+?)-\d+$/.exec(refId);
    if (dataset) meta.dataset = dataset[1];
    return meta;
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const MANIFEST_HEADER = ['zip', 'path', 'bytes', 'sha256', 'model', 'dataset', 'run_date'];

export function manifestRow(zip, path, bytes, meta) {
    return [zip, path, bytes.length, sha256(bytes), meta.model, meta.dataset, meta.run_date];
}

export function buildManifestCsv(rows) {
    return [MANIFEST_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** manifest.csv を行ごとの配列に戻す。引用符つきのセルに対応する。 */
export function parseManifestCsv(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        const cells = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quoted) {
                if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
            } else if (ch === '"') quoted = true;
            else if (ch === ',') { cells.push(cell); cell = ''; } else cell += ch;
        }
        cells.push(cell);
        rows.push(cells);
    }
    return rows.slice(1);
}

/** ラベルの表（id,label_included の2列だけ）。題名・抄録など他の欄は落とす。 */
export function buildLabelsCsv(records, labelKey = 'label_included') {
    const lines = ['id,label_included'];
    for (const record of records) {
        const id = record?.id;
        if (id === undefined || id === null || id === '') {
            throw new Error(`id=${String(id)}: ${labelKey} のレコードに空でない id が必要です`);
        }
        const label = record[labelKey];
        if (label !== 1 && label !== 0 && label !== true && label !== false) {
            throw new Error(`id=${id}: ${labelKey} は 1・0・true・false のいずれかである必要があります`);
        }
        lines.push(`${csvCell(id)},${label === 1 || label === true ? 1 : 0}`);
    }
    return lines.join('\n') + '\n';
}

// --- zip（外部依存なし。名前は UTF-8、更新時刻は固定して同じ入力から同じ zip を作る） ---

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data: Buffer }]。DOS 時刻は 2000-01-01 00:00 に固定する。 */
export function createZip(entries) {
    const DOS_TIME = 0;
    const DOS_DATE = (20 << 9) | (1 << 5) | 1; // 2000-01-01
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const compressed = deflateRawSync(data, { level: 9 });
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 の名前
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, compressed);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + compressed.length;
    }
    const centralBytes = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, end]);
}

/** createZip で作った zip を読み、[{ name, data }] を返す。CRC が合わなければ例外。 */
export function readZip(zip) {
    const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endAt < 0) throw new Error('zip の終端が見つかりません');
    const count = zip.readUInt16LE(endAt + 10);
    let at = zip.readUInt32LE(endAt + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('zip の中央ディレクトリが壊れています');
        const crc = zip.readUInt32LE(at + 16);
        const compressedSize = zip.readUInt32LE(at + 20);
        const nameLength = zip.readUInt16LE(at + 28);
        const extraLength = zip.readUInt16LE(at + 30);
        const commentLength = zip.readUInt16LE(at + 32);
        const localAt = zip.readUInt32LE(at + 42);
        const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
        const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
        const data = inflateRawSync(zip.subarray(dataAt, dataAt + compressedSize));
        if (crc32(data) !== crc) throw new Error(`${name}: CRC が一致しません`);
        entries.push({ name, data });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}
