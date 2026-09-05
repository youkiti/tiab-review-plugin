// デモプロファイル解決
//
// 'default'（実データ10件のみ）・'ml'（+ 合成文献1,090件、MLタブ開放デモ用）・
// 'bench'（+ サイズ可変のベンチマーク合成データ、Issue #151（#150 工程0）チャンク2）を
// 切り替えるための入口。URL クエリパラメータ ?demoProfile=ml / ?demoProfile=bench のみで
// 判定する（同期・確実。sidepanel.html / fulltext.html に対して Playwright で直接指定できる）。
//
// 実装メモ（chrome.storage.local 案を採用しなかった理由）:
// 当初は chrome.storage.local の 'demo_profile' キーを非同期フォールバックとして
// 読む案も検討したが、実際に Chromium 拡張機能上で計測したところ、
// document.addEventListener('DOMContentLoaded', ...) の発火は
// chrome.storage.local.get()（拡張プロセスを跨ぐ real な非同期呼び出し）の解決より
// 先に走ってしまい、シード完了前に src/sidepanel/sidepanel.ts 側の初期化
// （bootstrapCommon 呼び出し・イベントリスナー登録・i18n 適用）が一切行われないまま
// DOMContentLoaded リスナーの登録機会自体を逃す事象を確認した（ログインボタンの
// クリックが効かず、i18nテキストも空のままになる）。
// これは「クエリパラメータが無い＝既定プロファイル」という最も頻繁なケース
// （通常の拡張機能利用者がサイドパネルを開く操作そのもの）を壊してしまうため、
// 非同期フォールバックは採用せず、クエリパラメータのみによる完全同期解決とした。
// resolveBenchOptions() も同じ理由で完全同期解決にしている（chrome.storage.local を
// 読む非同期フォールバックを追加しないこと）。

export type DemoProfile = 'default' | 'ml' | 'bench';

/**
 * 現在のページURLの ?demoProfile= クエリパラメータからプロファイルを同期的に解決する。
 * 'ml' / 'bench' 以外（未指定・不明な値）は常に 'default' として扱う。
 */
export function resolveDemoProfile(): DemoProfile {
    if (typeof location === 'undefined') return 'default';
    const value = new URLSearchParams(location.search).get('demoProfile');
    if (value === 'ml') return 'ml';
    if (value === 'bench') return 'bench';
    return 'default';
}

/** ?benchSize= の既定値（未指定・不正値のフォールバック先） */
const DEFAULT_BENCH_SIZE = 1000;
/** ?benchSize= の上限。超えた場合はこの値に丸める */
const MAX_BENCH_SIZE = 50000;

export interface BenchOptions {
    /** 生成する References 件数 */
    size: number;
    /** true: Config に key_opened=true を入れる（非ブラインド） / false: Blind（既定） */
    keyOpened: boolean;
}

/**
 * bench プロファイル用オプションを ?benchSize= / ?benchKeyOpened= から同期的に解決する。
 * - benchSize: 数値として解釈できない値・0以下は既定値（1000）へフォールバックする。
 *   上限は50000で、超えた場合は50000に丸め、丸めたことを console.warn で1行出す。
 * - benchKeyOpened: '1' のときだけ true（既定 false = Blind）。
 */
export function resolveBenchOptions(): BenchOptions {
    if (typeof location === 'undefined') return { size: DEFAULT_BENCH_SIZE, keyOpened: false };
    const params = new URLSearchParams(location.search);

    const rawSize = params.get('benchSize');
    let size = DEFAULT_BENCH_SIZE;
    if (rawSize !== null) {
        const parsed = Number(rawSize);
        if (Number.isFinite(parsed) && parsed > 0) {
            size = Math.floor(parsed);
        }
        // 数値として解釈できない値・0以下は DEFAULT_BENCH_SIZE のまま（フォールバック）
    }
    if (size > MAX_BENCH_SIZE) {
        console.warn(`[demo] ?benchSize=${rawSize} は上限 ${MAX_BENCH_SIZE} を超えるため ${MAX_BENCH_SIZE} に丸めました`);
        size = MAX_BENCH_SIZE;
    }

    const keyOpened = params.get('benchKeyOpened') === '1';

    return { size, keyOpened };
}
