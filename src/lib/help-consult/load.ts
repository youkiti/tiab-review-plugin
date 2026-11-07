// 言語別ヘルプデータを必要時にだけ読む入口。呼び出し元もこの入口を動的 import する。
import type { HelpLanguage, HelpSection } from './types';

export async function loadHelpSections(lang: HelpLanguage): Promise<HelpSection[]> {
    if (lang === 'ja') {
        return (await import(/* webpackChunkName: "help-sections-ja" */ '../../../docs/help.html?help-sections&lang=ja')).default;
    }
    return (await import(/* webpackChunkName: "help-sections-en" */ '../../../docs/help.html?help-sections&lang=en')).default;
}
