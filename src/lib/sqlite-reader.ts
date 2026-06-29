// 最小限の読み取り専用 SQLite リーダー（純 TypeScript・依存ゼロ）
//
// EndNote の .enl ファイルは SQLite データベースだが、参照テーブルを 1 つ読むだけで足りる。
// そのため sql.js（WASM 約 1.5MB）を導入せず、SQLite ファイルフォーマットの
// 必要最小限（table b-tree の走査・レコードのデコード・オーバーフローページ追跡）だけを
// 自前実装する。書き込み・インデックス・WAL・暗号化などは一切扱わない。
//
// 参考: https://www.sqlite.org/fileformat2.html

/** SQLite のセル値として取りうる型 */
export type SqlValue = string | number | Uint8Array | null;

/** 1 テーブル分の読み取り結果 */
export interface SqlTable {
    /** CREATE TABLE 文から抽出したカラム名（定義順） */
    columns: string[];
    /** 各行をカラム名→値で表現したレコード配列 */
    rows: Array<Record<string, SqlValue>>;
}

interface TableSchema {
    name: string;
    rootPage: number;
    columns: string[];
}

/** 可変長整数（big-endian, 最大 9 バイト）を読む。戻り値は [値, 消費バイト数]。 */
function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
    let result = 0n;
    for (let i = 0; i < 8; i++) {
        const byte = buf[offset + i];
        result = (result << 7n) | BigInt(byte & 0x7f);
        if ((byte & 0x80) === 0) return [result, i + 1];
    }
    // 9 バイト目は全 8 ビットを使う
    result = (result << 8n) | BigInt(buf[offset + 8]);
    return [result, 9];
}

/** CREATE TABLE 文からカラム名を抽出する（簡易パーサー） */
function parseColumnNames(sql: string): string[] {
    const m = /\(([\s\S]*)\)\s*$/.exec(sql);
    if (!m) return [];
    const cols: string[] = [];
    // トップレベルのカンマで分割（カラム定義内に括弧が無い前提。EndNote のスキーマは単純なので十分）
    for (const def of splitTopLevel(m[1])) {
        const cm = /^\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/.exec(def);
        if (!cm) continue;
        const name = cm[1] || cm[2] || cm[3] || cm[4];
        if (!name) continue;
        // テーブル制約（PRIMARY KEY(...), UNIQUE(...), FOREIGN KEY 等）はカラムではない
        if (/^(primary|unique|foreign|constraint|check)$/i.test(name)) continue;
        cols.push(name);
    }
    return cols;
}

/** 括弧の深さを考慮してトップレベルのカンマで分割する */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts;
}

export class SqliteDb {
    private readonly buf: Uint8Array;
    private readonly dv: DataView;
    private readonly pageSize: number;
    private readonly usableSize: number;
    private readonly schema: TableSchema[];

    constructor(data: Uint8Array) {
        // ヘッダ（先頭 16 バイト）でマジックを確認
        const magic = new TextDecoder('latin1').decode(data.subarray(0, 15));
        if (magic !== 'SQLite format 3') {
            throw new Error('Not a SQLite database (bad magic header)');
        }
        this.buf = data;
        this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

        let pageSize = this.dv.getUint16(16);
        if (pageSize === 1) pageSize = 65536; // 仕様: 1 は 65536 を意味する
        this.pageSize = pageSize;
        this.usableSize = pageSize - this.dv.getUint8(20); // 各ページ末尾の予約バイトを除いた使用可能サイズ

        // sqlite_master（root は page 1）を走査してテーブル一覧を得る
        this.schema = this.readSchema();
    }

    /** 含まれるテーブル名の一覧 */
    get tableNames(): string[] {
        return this.schema.map(t => t.name);
    }

    /** 指定テーブルを全件読み出す。存在しなければ null。 */
    getTable(name: string): SqlTable | null {
        const tbl = this.schema.find(t => t.name === name);
        if (!tbl) return null;
        return this.readTable(tbl);
    }

    /** 1-based のページ番号から該当ページのバイト列を返す */
    private page(n: number): Uint8Array {
        return this.buf.subarray((n - 1) * this.pageSize, n * this.pageSize);
    }

    private readSchema(): TableSchema[] {
        const rawRows = this.walkTable(1);
        // sqlite_master のカラム: type(0), name(1), tbl_name(2), rootpage(3), sql(4)
        const tables: TableSchema[] = [];
        for (const { values } of rawRows) {
            if (values[0] !== 'table') continue;
            const name = typeof values[1] === 'string' ? values[1] : '';
            const rootPage = typeof values[3] === 'number' ? values[3] : 0;
            const sql = typeof values[4] === 'string' ? values[4] : '';
            if (!name || !rootPage) continue;
            tables.push({ name, rootPage, columns: parseColumnNames(sql) });
        }
        return tables;
    }

    private readTable(tbl: TableSchema): SqlTable {
        const rawRows = this.walkTable(tbl.rootPage);
        // INTEGER PRIMARY KEY 列はレコード内では NULL で保存され、実値は rowid になる（rowid alias）
        const pkIndex = this.findRowidAliasIndex(tbl);
        const rows = rawRows.map(({ rowid, values }) => {
            const rec: Record<string, SqlValue> = {};
            for (let i = 0; i < tbl.columns.length; i++) {
                let v = values[i] ?? null;
                if (i === pkIndex && v === null) v = rowid;
                rec[tbl.columns[i]] = v;
            }
            return rec;
        });
        return { columns: tbl.columns, rows };
    }

    /** "id INTEGER PRIMARY KEY" のような rowid alias 列のインデックスを返す（無ければ -1） */
    private findRowidAliasIndex(tbl: TableSchema): number {
        // 厳密な再パースは避け、"id" 列が INTEGER PRIMARY KEY である EndNote のスキーマに合わせ、
        // 1 列目が "id" の場合のみ alias とみなす簡易判定で十分。
        return tbl.columns[0]?.toLowerCase() === 'id' ? 0 : -1;
    }

    /** table b-tree を走査し、全リーフセルの { rowid, values } を集める */
    private walkTable(rootPage: number): Array<{ rowid: number; values: SqlValue[] }> {
        const out: Array<{ rowid: number; values: SqlValue[] }> = [];
        const visited = new Set<number>();
        const walk = (pageNum: number): void => {
            if (visited.has(pageNum)) throw new Error('Corrupt SQLite: page cycle detected');
            visited.add(pageNum);
            const b = this.page(pageNum);
            const headerOffset = pageNum === 1 ? 100 : 0; // page 1 はファイルヘッダ 100 バイトの後ろ
            const type = b[headerOffset];
            const nCells = this.dv.getUint16((pageNum - 1) * this.pageSize + headerOffset + 3);
            const cellPtrBase = headerOffset + (type === 5 ? 12 : 8);
            const pageBase = (pageNum - 1) * this.pageSize;

            if (type === 5) {
                // interior table page: 各セルは [左child(4B)][key(varint)]、末尾に rightmost child
                for (let i = 0; i < nCells; i++) {
                    const ptr = this.dv.getUint16(pageBase + cellPtrBase + i * 2);
                    const child = this.dv.getUint32(pageBase + ptr);
                    walk(child);
                }
                const right = this.dv.getUint32(pageBase + headerOffset + 8);
                walk(right);
            } else if (type === 13) {
                // leaf table page
                for (let i = 0; i < nCells; i++) {
                    const ptr = this.dv.getUint16(pageBase + cellPtrBase + i * 2);
                    const { rowid, payload } = this.readLeafCell(b, ptr);
                    out.push({ rowid, values: this.parseRecord(payload) });
                }
            }
            // type 2/10（index ページ）は参照テーブルの走査では現れないため無視
        };
        walk(rootPage);
        return out;
    }

    /** leaf table セルを読み、オーバーフローページを追跡して完全な payload を組み立てる */
    private readLeafCell(b: Uint8Array, cellOffset: number): { rowid: number; payload: Uint8Array } {
        let off = cellOffset;
        const [payloadLenBig, n1] = readVarint(b, off);
        off += n1;
        const payloadLen = Number(payloadLenBig);
        const [rowidBig, n2] = readVarint(b, off);
        off += n2;

        const maxLocal = this.usableSize - 35;
        const minLocal = Math.floor((this.usableSize - 12) * 32 / 255) - 23;
        let local: number;
        if (payloadLen <= maxLocal) {
            local = payloadLen;
        } else {
            const k = minLocal + (payloadLen - minLocal) % (this.usableSize - 4);
            local = k <= maxLocal ? k : minLocal;
        }

        const out = new Uint8Array(payloadLen);
        out.set(b.subarray(off, off + local), 0);
        let written = local;

        if (payloadLen > local) {
            // ローカル分の直後 4 バイトが最初のオーバーフローページ番号
            const firstOverflow = new DataView(b.buffer, b.byteOffset + off + local, 4).getUint32(0);
            let nextPage = firstOverflow;
            while (nextPage !== 0 && written < payloadLen) {
                const op = this.page(nextPage);
                // 各オーバーフローページ先頭 4 バイトは次ページ番号、残りがデータ
                nextPage = new DataView(op.buffer, op.byteOffset, 4).getUint32(0);
                const chunk = Math.min(this.usableSize - 4, payloadLen - written);
                out.set(op.subarray(4, 4 + chunk), written);
                written += chunk;
            }
        }
        return { rowid: Number(rowidBig), payload: out };
    }

    /** レコード payload（ヘッダ＋ボディ）をデコードしてカラム値配列にする */
    private parseRecord(payload: Uint8Array): SqlValue[] {
        const [hdrLenBig, n0] = readVarint(payload, 0);
        const headerEnd = Number(hdrLenBig);
        const serials: number[] = [];
        let off = n0;
        while (off < headerEnd) {
            const [s, n] = readVarint(payload, off);
            serials.push(Number(s));
            off += n;
        }
        const values: SqlValue[] = [];
        let body = headerEnd;
        for (const s of serials) {
            if (s === 0) {
                values.push(null);
            } else if (s >= 1 && s <= 6) {
                const len = [0, 1, 2, 3, 4, 6, 8][s];
                let v = 0n;
                for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(payload[body + i]);
                // 符号付き整数として符号拡張
                const bits = BigInt(len * 8);
                if (v >> (bits - 1n)) v -= (1n << bits);
                values.push(Number(v));
                body += len;
            } else if (s === 7) {
                values.push(new DataView(payload.buffer, payload.byteOffset + body, 8).getFloat64(0));
                body += 8;
            } else if (s === 8) {
                values.push(0);
            } else if (s === 9) {
                values.push(1);
            } else if (s >= 12 && s % 2 === 0) {
                // BLOB
                const len = (s - 12) / 2;
                values.push(payload.subarray(body, body + len));
                body += len;
            } else if (s >= 13) {
                // TEXT（EndNote は UTF-8）
                const len = (s - 13) / 2;
                values.push(new TextDecoder('utf-8').decode(payload.subarray(body, body + len)));
                body += len;
            } else {
                // 予約済み（10, 11）は出現しない想定
                values.push(null);
            }
        }
        return values;
    }
}

/** SQLite データベースを開く。マジックヘッダが不正なら例外。 */
export function openSqlite(data: Uint8Array): SqliteDb {
    return new SqliteDb(data);
}
