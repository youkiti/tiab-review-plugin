// share-email-history.ts - 共有メールアドレスのsuggestion用履歴管理
//
// 「共有」ポップオーバーで過去に共有した相手をsuggestionとして出すための保存庫。
// OAuthスコープは drive.file のみでGoogle連絡先APIが使えないため、
// この拡張で過去に共有したメールの履歴（+権限リストからの取り込み）を自前で保持する。
// 少量データなのでデバイス間同期される chrome.storage.sync に保存する。

const SHARE_EMAIL_HISTORY_KEY = 'share_email_history';

/** 履歴の保持上限件数 */
export const SHARE_EMAIL_HISTORY_LIMIT = 30;

/**
 * email文字列を正規化する（trim + 小文字化）。
 * 呼び出し元でフィルタ漏れがあっても落ちないよう、string以外は空文字扱いにする防御を入れる
 * （Drive権限オブジェクトはリンク共有等で emailAddress が undefined になることがある）。
 */
function normalizeEmail(email: string): string {
    if (typeof email !== 'string') return '';
    return email.trim().toLowerCase();
}

/**
 * 保存値を防御的にパースする。
 * 配列でない、または string でない要素は除外する（storage.ts の流儀に合わせる）。
 */
function parseHistory(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * 共有メール履歴を取得（先頭が最新）
 */
export async function getShareEmailHistory(): Promise<string[]> {
    if (typeof chrome === 'undefined' || !chrome.storage) return [];
    const result = await chrome.storage.sync.get([SHARE_EMAIL_HISTORY_KEY]);
    return parseHistory(result[SHARE_EMAIL_HISTORY_KEY]);
}

/**
 * 共有メールを履歴に追加する。
 * 正規化（trim + 小文字化）した上で、既存にあれば先頭へ移動、なければ先頭に追加。
 * 上限 SHARE_EMAIL_HISTORY_LIMIT 件で切り詰める。
 */
export async function addShareEmailToHistory(email: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const normalized = normalizeEmail(email);
    if (!normalized) return;

    const existing = await getShareEmailHistory();
    const next = [normalized, ...existing.filter(e => e !== normalized)].slice(0, SHARE_EMAIL_HISTORY_LIMIT);
    await chrome.storage.sync.set({ [SHARE_EMAIL_HISTORY_KEY]: next });
}

/**
 * 権限リスト由来のメールをまとめて履歴に取り込む。
 * 正規化した上で、既存に無いものだけ末尾に追加する（既存の順序＝新しさの並びは変えない）。
 * 上限 SHARE_EMAIL_HISTORY_LIMIT 件で切り詰める。
 */
export async function mergeShareEmailsToHistory(emails: string[]): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const normalizedNew = emails.map(normalizeEmail).filter(e => e.length > 0);
    if (normalizedNew.length === 0) return;

    const existing = await getShareEmailHistory();
    const existingSet = new Set(existing);
    const toAppend: string[] = [];
    for (const email of normalizedNew) {
        if (!existingSet.has(email) && !toAppend.includes(email)) {
            toAppend.push(email);
        }
    }
    if (toAppend.length === 0) return;

    const next = [...existing, ...toAppend].slice(0, SHARE_EMAIL_HISTORY_LIMIT);
    await chrome.storage.sync.set({ [SHARE_EMAIL_HISTORY_KEY]: next });
}
