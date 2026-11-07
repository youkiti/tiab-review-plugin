// 自由問い合わせの入力型。ディスパッチ層を参照せずプロバイダ間で共有する。
export interface AskParams {
    model: string;
    prompt: string;
    systemPrompt?: string;
    jsonSchema?: object;
    maxOutputTokens: number;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    signal?: AbortSignal;
    timeoutMs?: number;
}
