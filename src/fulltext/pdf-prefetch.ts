// pdf-prefetch.ts - 隣接候補PDFの先読み（プリフェッチ）キャッシュを担う。
// 状態そのもの（session.pdfPrefetch の Map）は session.ts に残し、このモジュールは
// エントリの作成・取り出し・中止・上限管理という「処理」だけを持つ
// （session.ts 冒頭コメント「処理の呼び出しは持たない」との分担）。
// Issue #156（#150 工程5）PR3: 先読みの上限とキャンセルを導入する。
//
// 元は document-loader.ts に置いていたが、そちらは既に489行あり太らせたくないため
// 独立モジュールへ切り出した。唯一の呼び出し元だった navigation.ts からはこのモジュールを
// 直接importする（document-loader.ts に消費者の居ない再エクスポートは残さない）。

import { downloadDriveFile, extractDriveFileId } from '../lib/drive-api';
import type { Reference } from '../lib/types';
import { session } from './session';
import type { PdfPrefetchEntry } from './session';

// ---------------------------------------------------------------------------
// 上限値
// ---------------------------------------------------------------------------

/**
 * 先読みで同時に保持するBlobの合計バイト数の上限。
 *
 * 実測（Issue #156）のベンチ用フィクスチャは 20ページ版 1,970,103 バイト・
 * 57ページ版 1,853,468 バイト・デモ用 102,651 バイトで、先読みは最大2件（下記
 * MAX_PDF_PREFETCH_CONCURRENCY）しか同時保持しないため通常の使用では合計 4MB 程度にしかならない。
 * この上限はそれよりずっと大きい値にして通常のPDFでは実質上限に触れないようにしつつ、
 * スキャンPDF（高解像度画像の束）等の巨大なファイルを掴んだ場合の最悪ケース（プリフェッチが
 * 際限なくメモリを食い続ける）だけを縛る安全弁として置く。32MBあれば通常サイズのPDFを
 * 2件保持しても8倍近い余裕があり、かつ数百MB級の異常に巨大なスキャンPDFを無制限に
 * 保持することは防げるため、この値を採用した。
 */
export const MAX_PDF_PREFETCH_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * 先読みの同時進行リクエスト数の上限。
 * 既存の「現在地から先の候補PDFを最大2件先読みする」という仕様（prefetchNeighbors の
 * d=1,2ループ）が基準のため、これと同じ2に固定する。
 */
export const MAX_PDF_PREFETCH_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// エントリ単体の作成・破棄
// ---------------------------------------------------------------------------

/**
 * 新しい先読みエントリを作り、ダウンロードを開始する。
 * ダウンロードの成否に関わらず promise は reject せず Blob | null で解決する
 * （呼び出し側の「先読み失敗→その場で再取得」フォールバックを保つため。既存挙動）。
 * 解決後にバイト数を記録し、上限超過分の追い出しを行う。
 */
function startPrefetchEntry(fileId: string): PdfPrefetchEntry {
    const controller = new AbortController();
    // entry.promise の .then コールバックは必ず現在の同期処理が終わった後（マイクロタスク）に
    // 実行されるため、下で entry を後から代入しても参照は解決済みになっている。
    const entry = {
        fileId,
        controller,
        bytes: undefined,
    } as PdfPrefetchEntry;
    entry.promise = downloadDriveFile(fileId, controller.signal)
        // downloadDriveFile は型付きエラー（DriveAccessDeniedError 等）や AbortError を投げるが、
        // 先読みはあくまで「当たればラッキー」の最適化なので、ここで吸収して null に丸める。
        // 実際に画面へ出すエラー導線は、先読みを使わない通常のダウンロード（showCachedPdf 等の
        // フォールバック）側が担う。
        .catch(() => null)
        .then(blob => {
            entry.bytes = blob ? blob.size : 0;
            enforcePrefetchBudget();
            return blob;
        });
    return entry;
}

/**
 * 指定 ref_id の先読みエントリを中止して破棄する。
 * 既に解決済みのエントリに abort() を呼んでも無害（何も起きない）。
 * showCachedPdf() / showRegistrySnapshot() の「先読みが失敗していた場合、その場で再取得する」
 * 前に呼ぶ retryCachedPdf() / retryRegistrySnapshot() からも使う共通の破棄経路。
 */
export function discardPdfPrefetchEntry(refId: string): void {
    const entry = session.pdfPrefetch.get(refId);
    if (!entry) return;
    entry.controller.abort();
    session.pdfPrefetch.delete(refId);
}

/** 全ての先読みエントリを中止して空にする。ページを離れる（後片付け）時に呼ぶ。 */
export function clearPdfPrefetch(): void {
    for (const refId of [...session.pdfPrefetch.keys()]) {
        discardPdfPrefetchEntry(refId);
    }
}

// ---------------------------------------------------------------------------
// バイト上限の集計・追い出し
// ---------------------------------------------------------------------------

/** 解決済み（bytes が確定した）エントリの合計バイト数 */
function totalResolvedPrefetchBytes(): number {
    let total = 0;
    for (const entry of session.pdfPrefetch.values()) {
        if (entry.bytes !== undefined) total += entry.bytes;
    }
    return total;
}

/**
 * バイト上限を超えていたら、現在地から遠いエントリから順に捨てる。
 * ダウンロードが解決するたび（startPrefetchEntry の .then）に呼ぶ。バイト数は解決後にしか
 * 分からないため、集計・追い出しは解決後にしか行えない。
 */
function enforcePrefetchBudget(): void {
    // 1. 単体で上限を超えるBlobは、それを保持するために他を全部捨てても意味が無いため
    //    そもそも保持しない（他のエントリより先に、無条件で捨てる）。
    for (const [refId, entry] of [...session.pdfPrefetch.entries()]) {
        if (entry.bytes !== undefined && entry.bytes > MAX_PDF_PREFETCH_TOTAL_BYTES) {
            discardPdfPrefetchEntry(refId);
        }
    }
    // 2. 残りの合計が上限を超えている間、現在地から遠いエントリから順に捨てる。
    //    現在地に近いエントリほど次に開かれる確率が高く、そちらを先に捨てると「次へ」を
    //    押した直後に再ダウンロードが発生して先読みの意味が無くなるため、近いエントリを
    //    優先して残す（旧実装はMapの挿入順で捨てていた。挿入順は prefetchNeighbors() が
    //    d=1,2 の順に同期挿入するため通常は近い順そのものであり、旧実装は上限に触れるたび
    //    次に開かれる可能性が最も高いエントリを先に捨てていた。挿入順が距離順とずれるのは、
    //    keep 集合に残ったエントリが prefetchNeighbors() の呼び出しをまたいでMap上の元の
    //    位置を保ったまま残る場合（後方へジャンプした場合等）であり、ネットワークの応答順
    //    ではない）。
    //    未解決（bytes === undefined）のエントリはサイズが分からず合計に含めていないため、
    //    追い出し対象にもしない（ダウンロードが完了すれば改めてこの関数で判定される）。
    const distanceOf = (refId: string): number => {
        // 距離を定義できない（現在地未確定）場合のみ、距離の代わりに0を返して全エントリを
        // 同着扱いにする。この後の安定ソートにより、実質的に挿入順（従来の判定）へ戻る。
        if (session.currentCandidateIndex < 0) return 0;
        const index = session.fulltextCandidates.findIndex(ref => ref.ref_id === refId);
        // 候補列から外れた古いエントリ（既に不要）は最遠扱いにし、最優先で捨てる。
        if (index === -1) return Infinity;
        return Math.abs(index - session.currentCandidateIndex);
    };
    // 追い出し候補の並び順は、走査を始める前に確定させる（走査中に順序が変わらないように
    // するため）。Array.prototype.sort は安定ソートなので、距離が同じエントリ同士は
    // Map の反復順（＝挿入順）のまま残り、古い方から先に捨てられる。
    const evictionOrder = [...session.pdfPrefetch.entries()]
        .sort((a, b) => distanceOf(b[0]) - distanceOf(a[0]));
    for (const [refId, entry] of evictionOrder) {
        if (totalResolvedPrefetchBytes() <= MAX_PDF_PREFETCH_TOTAL_BYTES) return;
        if (entry.bytes === undefined) continue;
        discardPdfPrefetchEntry(refId);
    }
}

// ---------------------------------------------------------------------------
// 取り出し（showCachedPdf() / showRegistrySnapshot() の共通ヘルパー）
// ---------------------------------------------------------------------------

/**
 * 先読みエントリを取り出す。呼び出し元は document-loader.ts の showCachedPdf() と
 * registry-snapshot.ts の showRegistrySnapshot() の2箇所（ほぼ同じ取り出しコードが
 * 重複していたため、ファイルID照合ロジックをここへ一本化した。片方にだけ照合を入れると
 * もう片方が古いエントリを掴み続ける事故になる）。
 *
 * 先読みを作った時点の Drive ファイルIDと、現在表示しようとしているURLから抽出した
 * ファイルIDが一致しないときはヒットさせず、古いエントリは中止・破棄してから miss（undefined）
 * を返す。PDFが差し替わって Drive ID が変わった（`pdf-upload.ts` 経由の置き換え・再アップロード）
 * のに、キャッシュキーが ref_id だけだと古い先読み結果を掴んでしまうため。
 */
export function getPdfPrefetch(refId: string, fileId: string): Promise<Blob | null> | undefined {
    const entry = session.pdfPrefetch.get(refId);
    if (!entry) return undefined;
    if (entry.fileId !== fileId) {
        discardPdfPrefetchEntry(refId);
        return undefined;
    }
    return entry.promise;
}

// ---------------------------------------------------------------------------
// 先読み本体
// ---------------------------------------------------------------------------

/**
 * 現在地から先の候補PDF（最大2件）をメモリに先読みする。
 * 先読みは Drive 保存済み(cached)PDFのみ対象。keep 集合から外れた古い先読みは、新規追加より
 * 先に中止・破棄してメモリを節約する（この順序の理由は下記コメント参照）。
 *
 * 呼び出し元は navigation.ts の loadRef() のみで、文献遷移1回につき1回しか呼ばれない
 * （同じ文献に留まったまま再度呼ばれる契機は無い）。同時進行リクエスト数が上限
 * （MAX_PDF_PREFETCH_CONCURRENCY）に達している間は、この呼び出しでは新しい投機的な先読みを
 * 開始しない（待ち行列は作らない）。
 *
 * 上限のカウントから現在表示中の文献自身のエントリを除いている
 * （countInFlightSpeculativePrefetches() 参照）: 除かないと「現在地自身がまだ未解決な
 * だけ」で投機的な隣接先読み用の枠が実質1件分に縮み、速く連続移動する場面（先読みが
 * 最も効いてほしい場面）で2件目の隣接先読みが恒久的に開始されなくなってしまう。
 *
 * **正直な注記**: 破棄を新規追加より先に行い、かつ現在地を勘定から除く現在の実装では、
 * この呼び出しの唯一の実際の経路（隣接候補は常に最大2件までしか対象にならない）を通す限り、
 * 同時実行数の上限（cap=2）が新規開始を実際に拒否することは構造的に起こらない
 * （keep 集合の非現在地メンバーは常に2件以下で、かつ「開始が必要」と判断される候補は
 * 判断の時点で必ずまだ進行中に数えられていないため、勘定値は最大1にしかならない）。
 * この上限は「隣接2件の先読み」という既存仕様を明示的に固定する防御的なガードであり、
 * 将来 prefetchNeighbors() 以外の経路が session.pdfPrefetch へ直接エントリを積むように
 * なった場合に効く。テスト（pdf-prefetch.test.ts）もこの前提に基づき、上限に張り付く
 * 境界条件（cache状態を直接組み立てて上限ちょうどの状態を作る）として検証している。
 */
export function prefetchNeighbors(): void {
    if (session.currentCandidateIndex < 0) return;

    const keep = new Set<string>();
    if (session.currentRef) keep.add(session.currentRef.ref_id);

    // 先読み対象（現在地の次から2件、cachedなDrive PDFのみ）を先に集める。
    const targets: Array<{ ref: Reference; fileId: string }> = [];
    for (let d = 1; d <= 2; d++) {
        const ref = session.fulltextCandidates[session.currentCandidateIndex + d];
        if (!ref || ref.fulltext_status !== 'cached' || !ref.fulltext_url) continue;
        const fileId = extractDriveFileId(ref.fulltext_url);
        if (!fileId) continue;
        keep.add(ref.ref_id);
        targets.push({ ref, fileId });
    }

    // keep 集合から外れたエントリは、新規追加より先に中止・破棄する。この呼び出しの中で
    // どのみち捨てることが確定しているエントリに、同時実行数の枠を食わせないため
    // （食わせると、現在地から2つ以上離れて既に不要になった古いエントリのせいで、
    // まだ必要な新しい隣接先読みが開始できなくなる。現在地自身を勘定から除く措置
    // （countInFlightSpeculativePrefetches() 参照）と同種の欠陥になる）。
    for (const key of [...session.pdfPrefetch.keys()]) {
        if (!keep.has(key)) discardPdfPrefetchEntry(key);
    }

    for (const { ref, fileId } of targets) {
        const existing = session.pdfPrefetch.get(ref.ref_id);
        if (existing) {
            if (existing.fileId === fileId) continue; // 同じ実体を先読み済み/進行中
            // PDFが差し替わっている（fileId不一致）→ 古い方を中止して作り直す
            discardPdfPrefetchEntry(ref.ref_id);
        }
        if (countInFlightSpeculativePrefetches() >= MAX_PDF_PREFETCH_CONCURRENCY) continue; // 上限。この呼び出しでは開始しない
        session.pdfPrefetch.set(ref.ref_id, startPrefetchEntry(fileId));
    }
}

/**
 * 進行中（未解決）の「投機的な」先読みエントリ数。同時実行数の上限はこの数だけを縛る。
 *
 * 現在表示中の文献（session.currentRef）自身のエントリはここから除く。そのダウンロードは
 * もはや投機ではなく実際に画面が必要としているものであり、これを数に含めると
 * 「現在地自身がまだ未解決」なだけで隣接2件ぶんの枠が1件分しか残らなくなる。
 * prefetchNeighbors() は文献遷移1回につき1回しか呼ばれない（呼び出し元は navigation.ts の
 * loadRef() のみ）ため、この枠を取り違えると、速く連続移動する場面で2件目の隣接先読みが
 * 恒久的に開始されなくなる（＝先読みが最も効いてほしい場面で機能低下する）。
 */
function countInFlightSpeculativePrefetches(): number {
    let count = 0;
    const currentRefId = session.currentRef?.ref_id;
    for (const [refId, entry] of session.pdfPrefetch) {
        if (refId === currentRefId) continue;
        if (entry.bytes === undefined) count++;
    }
    return count;
}
