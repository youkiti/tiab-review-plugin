// 公開 Issue 用に入力を伏せ字にし、URL 長の上限内でコピー可能な下書きを作る。
export interface IssueEnvironment {
    version: string;
    platform: 'extension' | 'web';
    uiLang: string;
    screen: string;
    provider: string;
    model: string;
    configuredProviders: readonly string[];
    errorText?: string;
}

export function sanitizeForIssue(text: string): string {
    return text.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi, '[REDACTED]')
        .replace(/https?:\/\/[^\s<>"'）)]+|[a-z0-9_-]{20,}/gi, value => {
            try {
                const url = new URL(value);
                const allowed = (url.hostname === 'github.com' && /^\/youkiti\/tiab-review-plugin(?:\/|$)/.test(url.pathname))
                    || (url.hostname === 'youkiti.github.io' && /^\/tiab-review-plugin(?:\/|$)/.test(url.pathname));
                if (allowed && !url.username && !url.password && !url.port) {
                    return value;
                }
            } catch {
                // 不正な URL も公開文面には残さない。
            }
            return '[REDACTED]';
        });
}

export function createIssueDraft(input: { question: string; answer?: string; environment: IssueEnvironment }):
    { title: string; body: string; url: string } {
    const clean = sanitizeForIssue;
    const title = Array.from(`ヘルプ相談: ${clean(input.question).replace(/\s+/g, ' ').trim()}`).slice(0, 100).join('');
    const notice = 'この下書きは公開の Issue になります。個人情報や未公開の研究内容が含まれていないか確認してください。\n'
        + 'This draft will become a public Issue. Check for personal information and unpublished research before submitting.\n\n';
    const env = input.environment;
    const environment = [
        ['Version', env.version], ['Platform', env.platform], ['UI language', env.uiLang], ['Screen', env.screen],
        ['Provider', env.provider], ['Model', env.model], ['Configured providers', env.configuredProviders.join(', ')],
    ].map(([label, value]) => `- ${label}: ${clean(value)}`).join('\n');
    const content = `## 環境 / Environment\n${environment}\n\n## 質問 / Question\n${clean(input.question)}\n\n`
        + `## AI の回答 / AI answer\n${clean(input.answer ?? '')}\n\n## エラー / Error\n${clean(env.errorText ?? '')}`;
    const base = `https://github.com/youkiti/tiab-review-plugin/issues/new?title=${encodeURIComponent(title)}&body=`;
    const makeUrl = (body: string) => base + encodeURIComponent(body);
    let body = notice + content;
    if (makeUrl(body).length > 8000) {
        const suffix = '\n\n（URL の長さ制限により省略しました / Truncated to fit the URL length limit.）';
        const chars = Array.from(content);
        let low = 0;
        let high = chars.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (makeUrl(notice + chars.slice(0, mid).join('') + suffix).length <= 8000) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        body = notice + chars.slice(0, low).join('') + suffix;
    }
    return { title, body, url: makeUrl(body) };
}
