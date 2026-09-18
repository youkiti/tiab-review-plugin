/** OpenRouter の TypeSafe モデルはチャット補完ではなく Decisions API を使う。 */
export function isOpenRouterJevModel(modelId: string): boolean {
    return modelId.startsWith('typesafe/') || modelId.startsWith('~typesafe/');
}
