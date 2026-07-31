// .nbib（PubMed NBIB形式）ファイルをテキストとしてバンドルするための型宣言。
// webpack 側は asset/source ルールで文字列としてインポートさせる（src/demo/seed.ts 専用）。
declare module '*.nbib' {
    const content: string;
    export default content;
}
