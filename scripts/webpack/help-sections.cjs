// ヘルプの小節を言語別データへ変換する純関数と webpack ローダー。

function filterSpans(html, lang) {
    const tags = /<\/?span\b[^>]*>/gi;
    const stack = [];
    let hidden = 0;
    let cursor = 0;
    let result = '';
    for (const match of html.matchAll(tags)) {
        if (hidden === 0) {
            result += html.slice(cursor, match.index);
        }
        if (/^<\/span/i.test(match[0])) {
            if (stack.pop()) {
                hidden--;
            }
        } else {
            const classes = /class\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1].split(/\s+/) ?? [];
            const hide = classes.includes('lang-sep') || classes.includes(lang === 'ja' ? 'en' : 'ja');
            stack.push(hide);
            if (hide) {
                hidden++;
            }
        }
        cursor = match.index + match[0].length;
    }
    if (hidden === 0) {
        result += html.slice(cursor);
    }
    return result;
}

function plainText(html, lang) {
    const entities = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
        copy: '©', reg: '®', times: '×', bull: '•', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    };
    const clean = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    return filterSpans(clean, lang)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
            if (entity.startsWith('#')) {
                const value = entity[1].toLowerCase() === 'x'
                    ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
            }
            return entities[entity] ?? whole;
        })
        .replace(/\s+/g, ' ').trim();
}

function parseHelpSections(html, lang) {
    if (lang !== 'ja' && lang !== 'en') {
        throw new Error('ヘルプの言語は ja または en を指定してください');
    }
    const result = [];
    const sectionPattern = /<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi;
    for (const section of html.matchAll(sectionPattern)) {
        if (!/class=["'][^"']*\bhelp-section\b[^"']*["']/.test(section[1])) {
            continue;
        }
        const sectionId = /\bid=["']([^"']+)["']/.exec(section[1])?.[1];
        const content = section[2];
        const sectionTitle = plainText(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(content)?.[1] ?? '', lang);
        const headings = [...content.matchAll(/<h([234])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi)];
        for (let index = 0; index < headings.length; index++) {
            const heading = headings[index];
            const id = /\bid=["']([^"']+)["']/.exec(heading[2])?.[1];
            if (heading[1] === '2' || !id) {
                continue;
            }
            let body = content.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? content.length);
            const whenBlock = /^\s*<div\b[^>]*class=["']help-when["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(body);
            const when = whenBlock
                ? [...whenBlock[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(item => plainText(item[1], lang)) : [];
            if (whenBlock) {
                body = body.slice(whenBlock[0].length);
            }
            result.push({ id, level: Number(heading[1]), sectionId, sectionTitle,
                title: plainText(heading[3], lang), when, body: plainText(body, lang) });
        }
    }
    return result;
}

module.exports = function (source) {
    const lang = new URLSearchParams(this.resourceQuery.slice(1)).get('lang');
    return `module.exports = ${JSON.stringify(parseHelpSections(source, lang))};`;
};
module.exports.parseHelpSections = parseHelpSections;
