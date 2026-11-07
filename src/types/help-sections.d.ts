// ビルド時に抽出した言語別ヘルプデータの型宣言。
declare module '*?help-sections&lang=ja' {
    const sections: import('../lib/help-consult/types').HelpSection[];
    export default sections;
}
declare module '*?help-sections&lang=en' {
    const sections: import('../lib/help-consult/types').HelpSection[];
    export default sections;
}
