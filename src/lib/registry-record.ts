// registry-record.ts
// Issue #118「レジストリ連携フェーズ1」チャンク1: レコード種別（記事 / 試験登録）判定の単一情報源。
// チャンク2（パスA）で、registration行から試験IDを取り出す関数・abstract合成を逆変換する関数・
// 自己完結スナップショットHTMLを組み立てる関数・そのファイル名を組み立てる関数を追加した。
// いずれも UI 非依存・fetch非依存の純関数（fetch を伴う取得は src/lib/registry-api.ts が担当する）。

import type { Reference } from './types';

/**
 * ある References 行が「試験登録（CTG/ICTRP）由来」かどうかを判定する。
 *
 * 判定の単一情報源（single source of truth）。表示（サイドパネルのバッジ表示等）・集計・
 * 取得経路（フルテキスト取得対象に含めるか等）の分岐は、今後すべてこの関数を経由すること。
 * 独自にヒューリスティックを書き直さないこと（表示結果が食い違う原因になる）。
 *
 * 優先順位:
 * 1. record_type が確定値を持つ場合はそれを最優先する（'registration' → true / 'article' → false）。
 *    CTG/ICTRP パーサはこの値を確定で書き込む。
 * 2. record_type 未設定（既存行・他パーサ由来の行との後方互換のためのフォールバック）の場合のみ、
 *    journal/source から推測する。この判定は
 *    src/sidepanel/features/screening/render.ts の renderTrialRegistryNote() が元々持っていた
 *    ヒューリスティックと完全に同一（journal を trim・小文字化した上で 'ictrp' または
 *    'clinicaltrials.gov' と完全一致、または source に 'clinicaltrials.gov' を含む）。
 *    表示結果を変えないため、この判定条件自体は変更しないこと。
 */
export function isRegistrationRecord(
    ref: Pick<Reference, 'record_type' | 'journal' | 'source'>
): boolean {
    if (ref.record_type === 'registration') return true;
    if (ref.record_type === 'article') return false;

    // 未設定の既存行向けフォールバック（renderTrialRegistryNote() と同一ロジック）
    const source = (ref.source || '').trim();
    const journal = (ref.journal || '').trim().toLowerCase();
    return (
        journal === 'ictrp' ||
        journal === 'clinicaltrials.gov' ||
        /clinicaltrials\.gov/i.test(source)
    );
}

/**
 * References 行の pmid 列から試験ID（NCT/JPRN/UMIN/ChiCTR/EUCTR等）を取り出す。
 *
 * CTG/ICTRP パーサはどちらも試験IDを pmid 列にマッピングしている
 * （src/lib/ctg-parser.ts の `pmid: nctNumber`、src/lib/ictrp-parser.ts の `pmid: trialId`）。
 * `NCT\d{8}` に完全一致すれば ClinicalTrials.gov API v2 が使える 'nct'、
 * それ以外の非空値は他レジストリ（jRCT/UMIN/ChiCTR/EUCTR等）の 'other' として区別する。
 * url/source は現時点では判定に使わないが、将来レジストリ種別を精緻化する余地を
 * 残すため引数の型に含めている。
 */
export function extractTrialId(
    ref: Pick<Reference, 'pmid' | 'url' | 'source'>
): { id: string; kind: 'nct' | 'other' } | null {
    const id = (ref.pmid || '').trim();
    if (!id) return null;
    return /^NCT\d{8}$/.test(id) ? { id, kind: 'nct' } : { id, kind: 'other' };
}

/**
 * CTG/ICTRP パーサが abstract 列へ合成した「ラベル: 値」の並びを逆変換する。
 *
 * 合成側（src/lib/ctg-parser.ts の csvRowToReference / src/lib/ictrp-parser.ts の
 * trialToReference）はどちらも `${ラベル}: ${値}` の形の要素を ' | ' で連結している
 * （`abstractParts.join(' | ')`）。値そのものにコロンが入りうる（例:
 * "Date_registration3: 2024-01-01T00:00:00"）ため、区切り文字 ' | ' で分割した後、
 * 各要素の**最初のコロン**でラベル/値に割る。ラベルにコロンは含まれない前提
 * （合成元は固定の英語カラム名/要素名のみ）。
 */
export function parseRegistryFieldsFromAbstract(
    abstract?: string
): Array<{ label: string; value: string }> {
    if (!abstract) return [];

    // 値そのものに ' | ' が含まれる自由記述フィールド（Brief Summary / Inclusion_Criteria 等）は
    // ここで分割された後半部にコロンが無い断片になる。データを落とさない方針（AGENTS.md
    // インポート規約）に合わせ、そういう断片は捨てず直前フィールドの値へ ' | ' で連結し直し、
    // 分割前の原文を復元する。先頭要素がそもそも断片（直前フィールドが無い）場合は、
    // 値だけの行としてラベル空文字で積む（buildRegistrySnapshotHtml 側は空ラベルの行も
    // 崩さず表示できる）。
    const fields: Array<{ label: string; value: string }> = [];
    for (const part of abstract.split(' | ')) {
        const colonIndex = part.indexOf(':');
        if (colonIndex < 0) {
            const fragment = part.trim();
            if (!fragment) continue;
            const last = fields[fields.length - 1];
            if (last) {
                last.value = `${last.value} | ${fragment}`;
            } else {
                fields.push({ label: '', value: fragment });
            }
            continue;
        }

        const label = part.slice(0, colonIndex).trim();
        const value = part.slice(colonIndex + 1).trim();
        if (!label || !value) continue;

        fields.push({ label, value });
    }
    return fields;
}

/** & < > " ' をHTMLエンティティへ変換する。レジストリ由来の未検証テキストを埋め込む前に必ず通すこと。 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * registration行由来のURLを外部に渡す前の共通ガード。http/httpsのみを安全とみなす。
 *
 * 用途はHTML埋め込み（buildRegistrySnapshotHtml の <a href>）に限らない。References の url
 * 列＝ユーザーが直接編集できるセル由来のため、`javascript:` / `data:` 等の危険なスキームや
 * 相対URL・不正な値が入りうる。fulltext-retriever.ts の retrieveRegistrationSnapshot()（Drive
 * 保存失敗時のフォールバック）も同じガードを通してから fulltext_url として保存する
 * （そうしないとサイドパネルの buildLinkBtn() → chrome.tabs.create({ url }) に未検証の値が渡る）。
 * escapeHtml() はHTML構文注入は防ぐがスキームまでは防げないため、ここで別途検証する。
 * new URL() は不正な値で例外を投げるため try/catch する。
 */
export function isSafeHttpUrl(value: string): boolean {
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

/** buildRegistrySnapshotHtml() の入力 */
export interface RegistrySnapshotInput {
    /**
     * 試験ID（NCT番号やレジストリ独自ID）。extractTrialId() が取れなかった場合など、
     * 無ければ省略可（buildRegistrySnapshotHtml側で「(不明)」表示になる）。
     * ref_id（内部UUID）を代替値として渡さないこと（試験IDと誤認させないため）。
     */
    trialId?: string;
    title: string;
    /** レジストリ名（例: "ClinicalTrials.gov"、"ICTRP"、Referencesの journal 列の値） */
    registryName: string;
    /** 原簿URL。無ければヘッダーに「不明」と表示する */
    sourceUrl?: string;
    /** 取得日時（ISO 8601）。関数内で `new Date()` を呼ばずテスト可能にするため呼び出し側から渡す */
    retrievedAt: string;
    fields: Array<{ label: string; value: string }>;
}

/**
 * 試験登録レコードの内容を焼き込んだ、自己完結（外部CSS/JS/画像を一切参照しない）
 * HTMLスナップショットを組み立てる。
 *
 * レジストリ由来のテキスト（title / registryName / fields の値など）は全て
 * escapeHtml() を通してから埋め込む。値中の改行は `white-space: pre-wrap` で
 * 表示するため <br> への変換は行わない（改行文字はそのままエスケープ後の文字列に残る）。
 * 印刷用に最低限の @media print を入れている（チャンク3で「PDFとして保存」導線を
 * 足す際、この印刷スタイルをそのまま使う想定）。
 */
export function buildRegistrySnapshotHtml(input: RegistrySnapshotInput): string {
    const title = escapeHtml(input.title);
    const trialIdRaw = input.trialId?.trim();
    const trialId = trialIdRaw ? escapeHtml(trialIdRaw) : '(不明)';
    const registryName = escapeHtml(input.registryName);
    const retrievedAt = escapeHtml(input.retrievedAt);
    const sourceUrl = input.sourceUrl?.trim();
    // http/https 以外（javascript: / data: 等）や相対URL・不正な値はリンクにせず、
    // エスケープ済みのプレーンテキストとして表示する（値そのものは落とさない）。
    const sourceUrlHtml = sourceUrl
        ? (isSafeHttpUrl(sourceUrl) ? `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>` : escapeHtml(sourceUrl))
        : '(不明)';

    const rows = input.fields
        .map(f => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`)
        .join('\n');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem; color: #222; line-height: 1.6; }
  h1 { font-size: 1.3rem; margin-bottom: 0.5rem; }
  .meta { font-size: 0.9rem; color: #555; margin-bottom: 1.5rem; }
  .meta dt { font-weight: bold; float: left; clear: left; width: 8rem; }
  .meta dd { margin-left: 8rem; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; vertical-align: top; white-space: pre-wrap; }
  th { width: 12rem; background: #f5f5f5; }
  @media print {
    body { margin: 0.5cm; }
    a { color: #000; text-decoration: none; }
  }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <dl class="meta">
    <dt>試験ID</dt><dd>${trialId}</dd>
    <dt>レジストリ</dt><dd>${registryName}</dd>
    <dt>原簿URL</dt><dd>${sourceUrlHtml}</dd>
    <dt>取得日時</dt><dd>${retrievedAt}</dd>
  </dl>
</header>
<table>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

/**
 * レジストリスナップショットHTMLのファイル名を組み立てる。
 * src/lib/drive-api.ts の buildPdfFileName() と同じ命名規約（不正文字の除去・
 * 空白正規化・80文字切り詰め・ref_id先頭8桁の付与）に揃え、拡張子だけ .html にする。
 */
export function buildRegistrySnapshotFileName(ref: { ref_id: string; title?: string }): string {
    const base = (ref.title || ref.ref_id)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return `${base} [${ref.ref_id.slice(0, 8)}].html`;
}
