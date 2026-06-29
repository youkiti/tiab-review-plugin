// 最小限の ZIP リーダー（依存ゼロ）
//
// EndNote の .enlp は ZIP アーカイブ（中に .enl(SQLite) と .Data/ フォルダを含む）。
// JSZip 等を導入せず、Central Directory を読み、各エントリを store / deflate で展開する。
// deflate の解凍はブラウザ標準の DecompressionStream('deflate-raw') を使う（依存ゼロ）。

const SIG_EOCD = 0x06054b50;        // End Of Central Directory
const SIG_CENTRAL = 0x02014b50;     // Central Directory File Header
const MIN_EOCD_SIZE = 22;

interface CentralEntry {
    name: string;
    method: number;
    compressedSize: number;
    localHeaderOffset: number;
}

/** deflate-raw を解凍する */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    // 入力スライスを ArrayBuffer 由来の Uint8Array にコピーして渡す
    // （TS lib の BufferSource は ArrayBuffer 由来のビューのみ受け付けるため）
    const chunk = new Uint8Array(data.length);
    chunk.set(data);
    void writer.write(chunk);
    void writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
}

/** EOCD レコードをファイル末尾から探す（ZIP コメントがあるため後方走査） */
function findEocd(dv: DataView, length: number): number {
    const minPos = Math.max(0, length - MIN_EOCD_SIZE - 0xffff); // コメント最大長 65535
    for (let i = length - MIN_EOCD_SIZE; i >= minPos; i--) {
        if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
}

/**
 * ZIP バイト列を展開し、エントリ名 → 解凍済みバイト列の Map を返す。
 * ディレクトリエントリ（サイズ 0・名前末尾が "/"）は含めない。
 */
export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const eocd = findEocd(dv, data.length);
    if (eocd < 0) throw new Error('Not a ZIP archive (EOCD not found)');

    const cdCount = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);

    const entries: CentralEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
        if (dv.getUint32(p, true) !== SIG_CENTRAL) break; // ZIP64 等は未対応のため打ち切り
        const method = dv.getUint16(p + 10, true);
        const compressedSize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localHeaderOffset = dv.getUint32(p + 42, true);
        const name = new TextDecoder('utf-8').decode(data.subarray(p + 46, p + 46 + nameLen));
        entries.push({ name, method, compressedSize, localHeaderOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }

    const result = new Map<string, Uint8Array>();
    for (const e of entries) {
        if (e.name.endsWith('/')) continue; // ディレクトリ
        // ローカルヘッダ: 名前長・extra 長はセントラルと異なる場合があるためローカル側を読む
        const lhOff = e.localHeaderOffset;
        const lhNameLen = dv.getUint16(lhOff + 26, true);
        const lhExtraLen = dv.getUint16(lhOff + 28, true);
        const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
        const comp = data.subarray(dataStart, dataStart + e.compressedSize);
        let bytes: Uint8Array;
        if (e.method === 0) {
            bytes = comp; // store（無圧縮）
        } else if (e.method === 8) {
            bytes = await inflateRaw(comp); // deflate
        } else {
            continue; // 未対応の圧縮方式はスキップ
        }
        result.set(e.name, bytes);
    }
    return result;
}
