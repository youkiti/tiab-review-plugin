const LOCAL_MODEL_PREFIX = 'local:';

export function isLocalModelId(id: string): boolean {
    return id.startsWith(LOCAL_MODEL_PREFIX);
}

export function toLocalModelId(id: string): string {
    return isLocalModelId(id) ? id : LOCAL_MODEL_PREFIX + id;
}

export function stripLocalModelPrefix(id: string): string {
    return isLocalModelId(id) ? id.slice(LOCAL_MODEL_PREFIX.length) : id;
}

export const LOCAL_LLM_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeLocalLlmEndpoint(endpoint: string): string {
    let url: URL;
    try {
        url = new URL(endpoint.trim());
    } catch {
        throw new Error('有効な API エンドポイント URL を入力してください');
    }
    if (!LOCAL_LLM_HOSTNAMES.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('URL は localhost・127.0.0.1・[::1] に限られます');
    }
    if (url.username !== '' || url.password !== '') {
        throw new Error('URL にユーザー名やパスワードを含めないでください');
    }
    if (url.hash !== '') {
        throw new Error('URL にフラグメントを含めないでください');
    }
    return url.toString();
}

export function deriveLocalLlmModelsUrl(endpoint: string): string {
    const url = new URL(normalizeLocalLlmEndpoint(endpoint));
    if (!url.pathname.endsWith('/chat/completions')) {
        throw new Error('URL の末尾を /chat/completions にしてください');
    }
    url.pathname = url.pathname.slice(0, -'/chat/completions'.length) + '/models';
    return url.toString();
}
